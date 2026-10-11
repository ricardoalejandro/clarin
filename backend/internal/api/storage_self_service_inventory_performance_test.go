package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/storage"
)

// Optional diagnostic plans are distinct from timed HTTP samples. They compare
// the previous wide projection with the current page and summary statements
// against the same fixture, without changing PostgreSQL configuration.
func storagePerformanceExplainInventory(t *testing.T, f *storageQAFixture, objects int) {
	t.Helper()
	directory := os.Getenv("CLARIN_STORAGE_PERF_PLAN_DIR")
	if directory == "" {
		return
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	defer f.exec(`UPDATE user_accounts SET role='member' WHERE account_id=$1 AND user_id=$2`, f.account, f.user)
	for _, role := range []string{"member", "admin"} {
		f.exec(`UPDATE user_accounts SET role=$3 WHERE account_id=$1 AND user_id=$2`, f.account, f.user, role)
		claims := &service.JWTClaims{AccountID: f.account, UserID: f.user, Role: role, Permissions: []string{domain.PermSettings, domain.PermChats}}
		privateSources, err := f.server.storageInventoryHasPrivateSources(context.Background(), f.account, claims)
		if err != nil {
			t.Fatal(err)
		}
		baseArgs := storageInventoryArguments(f.account, f.user, claims)
		filterArgs := append(append([]any{}, baseArgs...), "", "", "", "all", int64(0), (*time.Time)(nil))
		pageArgs := append(append([]any{}, filterArgs...), 40, 0)
		filter := storageInventoryFilter{Sort: "size", Order: "desc"}
		for _, query := range []struct {
			name string
			sql  string
			args []any
		}{
			{"count", storageInventoryCTE(claims, privateSources) + ` SELECT count(*) FROM file_rows f` + storageInventoryFilterSQL, filterArgs},
			{"files-before-page-projection", storageInventoryCTE(claims) + ` SELECT to_jsonb(f) FROM file_rows f` + storageInventoryFilterSQL + ` ORDER BY size_bytes DESC,object_key ASC,recovery_id ASC LIMIT $13 OFFSET $14`, pageArgs},
			{"files", storageInventoryPageWithCountSQL(claims, filter, privateSources), pageArgs},
			{"usage", storageInventoryUsageSQL(claims, privateSources), baseArgs},
		} {
			explain := "EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) "
			if os.Getenv("CLARIN_STORAGE_PERF_PLAN_ANALYZE") == "0" {
				explain = "EXPLAIN(FORMAT JSON) "
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			var data []byte
			err := f.db.QueryRow(ctx, explain+query.sql, query.args...).Scan(&data)
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(directory, fmt.Sprintf("inventory-%s-%s-%d.json", query.name, role, objects))
			if err = os.WriteFile(file, data, 0600); err != nil {
				t.Fatal(err)
			}
			var plans []map[string]any
			if err = json.Unmarshal(data, &plans); err != nil || len(plans) != 1 {
				t.Fatalf("invalid query plan: %v", err)
			}
			summary, _ := json.Marshal(map[string]any{"objects": objects, "actor_role": role, "query": query.name, "planning_ms": plans[0]["Planning Time"], "execution_ms": plans[0]["Execution Time"], "jit": plans[0]["JIT"], "sql_bytes": len(query.sql)})
			t.Logf("STORAGE_PERF_PLAN %s", summary)
		}
	}
}

func storagePerformanceSharedFixture(t *testing.T, db *pgxpool.Pool, store *storage.Storage, n int) *storageQAFixture {
	t.Helper()
	f := newStorageQAFixture(t, db, store)
	storagePerformanceSeed(t, f, 1, 0, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	f.exec(`INSERT INTO contacts(id,account_id,jid,name) SELECT md5($1::text||':shared-contact:'||g::text)::uuid,$1::uuid,'shared-'||g::text||'@test.invalid','Shared performance '||g::text FROM generate_series(1,100) g`, f.account)
	f.exec(`INSERT INTO chats(id,account_id,contact_id,jid,name) SELECT md5($1::text||':shared-chat:'||g::text)::uuid,$1::uuid,md5($1::text||':shared-contact:'||g::text)::uuid,'shared-'||g::text||'@test.invalid','Shared Chat '||g::text FROM generate_series(1,100) g`, f.account)
	var chats []uuid.UUID
	rows, err := db.Query(ctx, `SELECT id FROM chats WHERE account_id=$1 AND name LIKE 'Shared Chat %' ORDER BY id`, f.account)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		chats = append(chats, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil || len(chats) != 100 {
		t.Fatalf("shared Chat fixture: chats=%d err=%v", len(chats), err)
	}
	for first := 1; first < n; first += 1000 {
		last := min(first+999, n-1)
		_, err = db.Exec(ctx, `INSERT INTO messages(account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp)
		 SELECT $1,($2::uuid[])[1+mod(g,100)],'shared-perf-'||g::text,'Synthetic shared attachment','document','/api/media/file/'||ma.object_key,'application/pdf',ma.filename,ma.size_bytes,ma.id,NOW()
		 FROM generate_series($3::int,$4::int) g CROSS JOIN media_assets ma WHERE ma.account_id=$1`, f.account, chats, first, last)
		if err != nil {
			t.Fatal(err)
		}
	}
	var references int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM messages WHERE account_id=$1 AND media_asset_id IS NOT NULL`, f.account).Scan(&references); err != nil || references != n {
		t.Fatalf("shared references=%d want=%d error=%v", references, n, err)
	}
	for _, table := range []string{"messages", "media_assets", "storage_objects", "chats", "contacts"} {
		f.exec("ANALYZE " + table)
	}
	indexStarted := time.Now()
	if err = f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
		t.Fatal(err)
	}
	t.Logf("STORAGE_PERF_SHARED_INDEX objects=1 media_references=%d chats=101 duration_ms=%.3f", n, float64(time.Since(indexStarted).Microseconds())/1000)
	storagePerformanceAnalyzeInventory(t, f)
	return f
}

// This additional shape isolates fan-out: one physical object, many authorized
// messages spread across real Chats. It is not mixed into the historical
// one-reference-per-object comparison.
func storagePerformanceSharedReferences(t *testing.T, db *pgxpool.Pool, store *storage.Storage, samples int) {
	n := storagePerformanceInt(t, "CLARIN_STORAGE_PERF_SHARED_REFERENCES", 10000, 100, 50000)
	t.Run(fmt.Sprintf("shared_object_references_%d", n), func(t *testing.T) {
		f := storagePerformanceSharedFixture(t, db, store, n)
		storagePerformanceExplainInventory(t, f, 1)
		storagePerformanceTrackS3(t, f)
		f.app.Get("/storage/uses", f.server.handleStorageSelfServiceUses)
		first := storagePerformanceRequest{path: "/storage/files?limit=40", total: 1, files: 1, references: n}
		usage := storagePerformanceRequest{path: "/storage/usage", total: 1, usage: true, references: n}
		// This fan-out remains a separate result: SQL selects the bounded
		// authorized page before adapters hydrate its canonical business rows.
		uses := storagePerformanceRequest{path: "/storage/uses?limit=40&object_key=" + url.QueryEscape(f.account.String()+"/chats/"+storagePerformanceFilename(0)), total: n, files: 40, uses: true, references: n}
		for _, scenario := range []struct {
			name     string
			requests []storagePerformanceRequest
		}{{"shared_files", []storagePerformanceRequest{first}}, {"shared_usage", []storagePerformanceRequest{usage}}, {"shared_page_open_parallel", []storagePerformanceRequest{usage, first}}, {"shared_uses_detail", []storagePerformanceRequest{uses}}} {
			t.Run(scenario.name, func(t *testing.T) {
				storagePerformanceMeasure(t, f, scenario.name, scenario.requests, 1, samples, 0, 101, "foreign-never-present")
			})
		}
		t.Run("shared_uses_detail_dirty", func(t *testing.T) {
			f.exec(`INSERT INTO document_templates(account_id,name,canvas_json) VALUES($1,'Pending unrelated index','{"objects":[]}'::jsonb)`, f.account)
			dirtyUses := uses
			dirtyUses.indexingBudget = n > storageFallbackCandidateLimit
			storagePerformanceMeasure(t, f, "shared_uses_detail_dirty", []storagePerformanceRequest{dirtyUses}, 1, samples, 0, 101, "foreign-never-present")
		})
	})
}
