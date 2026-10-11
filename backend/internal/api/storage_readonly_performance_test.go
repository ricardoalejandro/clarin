package api

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

// Explicit diagnostics only: this never migrates, seeds, constructs a provider
// client, creates a token, or prints account identifiers/payloads. Every pool
// connection is read-only, with bounded statements and a single connection.
// Measurements are SQL+Go reads, not deployed network/browser latency.
func TestStorageReadOnlyPerformanceProbe(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_READONLY_PROBE") != "1" {
		t.Skip("explicit read-only diagnostic opt-in required")
	}
	cfg, err := pgxpool.ParseConfig(os.Getenv("CLARIN_STORAGE_READONLY_DATABASE_URL"))
	if err != nil {
		t.Fatal("read-only probe configuration unavailable")
	}
	cfg.MaxConns = 1
	if os.Getenv("CLARIN_STORAGE_READONLY_GENERIC") == "1" {
		cfg.ConnConfig.RuntimeParams["plan_cache_mode"] = "force_generic_plan"
	}
	if os.Getenv("CLARIN_STORAGE_READONLY_JIT_OFF") == "1" {
		cfg.ConnConfig.RuntimeParams["jit"] = "off"
	}
	cfg.ConnConfig.RuntimeParams["default_transaction_read_only"] = "on"
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "5000"
	if os.Getenv("CLARIN_STORAGE_READONLY_EXPLAIN") == "1" {
		cfg.ConnConfig.RuntimeParams["statement_timeout"] = "25000"
	}
	cfg.ConnConfig.RuntimeParams["application_name"] = "clarin_storage_readonly_probe"
	db, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal("read-only probe connection unavailable")
	}
	defer db.Close()
	var readOnly string
	if err = db.QueryRow(context.Background(), "SHOW transaction_read_only").Scan(&readOnly); err != nil || readOnly != "on" {
		t.Fatal("read-only guarantee unavailable")
	}
	targetBytes, _ := strconv.ParseInt(os.Getenv("CLARIN_STORAGE_READONLY_TARGET_BYTES"), 10, 64)
	claims := &service.JWTClaims{}
	// Choose an existing authorized administrator in the account with the
	// largest measured inventory; selection never emits its identity.
	err = db.QueryRow(context.Background(), `SELECT ua.account_id,ua.user_id,ua.role,COALESCE(u.is_super_admin,false),COALESCE(r.permissions,'{}'::text[])
        FROM user_accounts ua JOIN users u ON u.id=ua.user_id AND u.is_active
        LEFT JOIN roles r ON r.id=ua.role_id JOIN storage_inventory_totals totals ON totals.account_id=ua.account_id
        WHERE (ua.role IN ('admin','super_admin') OR u.is_super_admin) AND ($1::bigint=0 OR totals.size_bytes=$1)
        ORDER BY totals.size_bytes DESC,ua.account_id,ua.user_id LIMIT 1`, targetBytes).Scan(&claims.AccountID, &claims.UserID, &claims.Role, &claims.IsSuperAdmin, &claims.Permissions)
	if err != nil {
		t.Fatal("no authorized read-only probe actor")
	}
	server := &Server{repos: repository.NewRepositories(db)}
	freshness, err := server.storageInventoryFreshness(context.Background(), claims.AccountID)
	if err != nil || !freshness.Complete {
		t.Fatal("read-only probe requires complete inventory; cannot fall back to old scalar decoder")
	}
	var key string
	var objects, references int64
	err = db.QueryRow(context.Background(), `SELECT object_key FROM storage_inventory_references WHERE account_id=$1 AND origin='chats' AND readable GROUP BY object_key ORDER BY count(*) DESC,object_key LIMIT 1`, claims.AccountID).Scan(&key)
	if err != nil {
		t.Fatal("no readable object for uses measurement")
	}
	if err = db.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM storage_inventory_objects WHERE account_id=$1),(SELECT count(*) FROM storage_inventory_references WHERE account_id=$1)`, claims.AccountID).Scan(&objects, &references); err != nil {
		t.Fatal("probe cardinality unavailable")
	}
	t.Logf("STORAGE_READONLY_DATASET objects=%d references=%d read_only=%s samples=30 warmups=2", objects, references, readOnly)
	actor := storageUseActor{AccountID: claims.AccountID, UserID: claims.UserID, Claims: claims}
	if os.Getenv("CLARIN_STORAGE_READONLY_EXPLAIN") == "1" {
		private, err := server.storageInventoryHasPrivateSources(context.Background(), claims.AccountID, claims)
		if err != nil {
			t.Fatal("private source check failed")
		}
		args := storageInventoryArguments(claims.AccountID, claims.UserID, claims)
		filterArgs := append(append([]any{}, args...), "", "", "", "all", int64(0), (*time.Time)(nil))
		pageArgs := append(append([]any{}, filterArgs...), 40, 0)
		for _, query := range []struct {
			name, sql string
			args      []any
		}{
			{"summary", storageInventoryUsageSQL(claims, private), args},
			{"files_count", storageInventoryCTE(claims, private) + " SELECT count(*) FROM file_rows f" + storageInventoryFilterSQL, filterArgs},
			{"files_page", storageInventoryPageWithCountSQL(claims, storageInventoryFilter{Sort: "size", Order: "desc"}, private), pageArgs},
		} {
			var raw []byte
			err := db.QueryRow(context.Background(), "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "+query.sql, query.args...).Scan(&raw)
			if err != nil {
				storageReadFailure("readonly_explain_"+query.name, err)
				t.Fatal("read-only explain failed")
			}
			var report []map[string]any
			_ = json.Unmarshal(raw, &report)
			var nodes []map[string]any
			var visit func(map[string]any)
			visit = func(node map[string]any) {
				nodes = append(nodes, map[string]any{"type": node["Node Type"], "relation": node["Relation Name"], "time": node["Actual Total Time"], "loops": node["Actual Loops"], "rows": node["Actual Rows"], "cost": node["Total Cost"], "plan_rows": node["Plan Rows"]})
				if children, ok := node["Plans"].([]any); ok {
					for _, child := range children {
						if child, ok := child.(map[string]any); ok {
							visit(child)
						}
					}
				}
			}
			if plan, ok := report[0]["Plan"].(map[string]any); ok {
				visit(plan)
			}
			sort.Slice(nodes, func(i, j int) bool {
				return storageExplainNumber(nodes[i]["time"])*storageExplainNumber(nodes[i]["loops"]) > storageExplainNumber(nodes[j]["time"])*storageExplainNumber(nodes[j]["loops"])
			})
			if len(nodes) > 12 {
				nodes = nodes[:12]
			}
			safe, _ := json.Marshal(map[string]any{"query": query.name, "planning_ms": report[0]["Planning Time"], "execution_ms": report[0]["Execution Time"], "jit": report[0]["JIT"], "nodes": nodes})
			t.Logf("STORAGE_READONLY_EXPLAIN %s", safe)
		}
		if os.Getenv("CLARIN_STORAGE_READONLY_EXPLAIN_ONLY") == "1" {
			return
		}
	}

	for _, scenario := range []struct {
		name string
		read func(context.Context) error
	}{
		{"summary", func(ctx context.Context) error {
			_, err := server.storageInventoryUsage(ctx, claims.AccountID, claims.UserID, claims)
			return err
		}},
		{"files", func(ctx context.Context) error {
			_, _, err := server.storageInventoryFiles(ctx, claims.AccountID, claims.UserID, claims, storageInventoryFilter{Status: "all", Sort: "size", Order: "desc", Limit: 40})
			return err
		}},
		{"videos", func(ctx context.Context) error {
			_, _, err := server.storageInventoryFiles(ctx, claims.AccountID, claims.UserID, claims, storageInventoryFilter{Type: "video", Status: "all", Sort: "size", Order: "desc", Limit: 40})
			return err
		}},
		{"uses", func(ctx context.Context) error {
			_, _, _, err := server.storageReadUsesPage(ctx, actor, key, "", 40)
			return err
		}},
		{"content_authorization", func(ctx context.Context) error {
			_, _, err := server.storageAuthorizeContent(ctx, actor, key)
			return err
		}},
	} {
		values := make([]float64, 0, 30)
		for sample := -2; sample < 30; sample++ {
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			start := time.Now()
			err := scenario.read(ctx)
			duration := float64(time.Since(start).Microseconds()) / 1000
			cancel()
			if err != nil {
				storageReadFailure("readonly_probe_"+scenario.name, err)
				t.Fatalf("read-only %s failed at sample %d", scenario.name, sample)
			}
			if sample >= 0 {
				values = append(values, duration)
			}
		}
		sort.Float64s(values)
		result, _ := json.Marshal(map[string]any{"scenario": scenario.name, "samples": len(values), "p50_ms": values[14], "p95_ms": values[28], "max_ms": values[29], "layer": "sql_and_go_read_only"})
		t.Logf("STORAGE_READONLY_PERF %s", result)
	}
}

func storageExplainNumber(value any) float64 { number, _ := value.(float64); return number }
