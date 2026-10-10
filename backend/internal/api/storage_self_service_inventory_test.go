package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func TestStorageSelfServiceInventorySourceQueriesRemainBounded(t *testing.T) {
	sources := storageInventorySources()
	if len(sources) != len(storageSelfServiceReferenceQueries) {
		t.Fatal("a reference source cannot be indexed")
	}
	seen := map[string]bool{}
	for _, source := range sources {
		if source.kind == "" || source.idColumn == "" || !strings.Contains(source.sql, " WHERE ") {
			t.Fatalf("unbounded inventory source %+v", source)
		}
		if seen[source.kind] {
			t.Fatalf("duplicate source %s requires an explicit source identity", source.kind)
		}
		seen[source.kind] = true
	}
	for _, kind := range []string{"messages", "contacts", "campaigns", "task_attachments", "whiteboard_assets"} {
		if !seen[kind] {
			t.Fatalf("missing source %s", kind)
		}
	}
	if (storageInventoryFilter{Sort: "size; DROP TABLE accounts", Order: "asc; --"}).orderSQL() != "last_modified DESC,object_key ASC,recovery_id ASC" {
		t.Fatal("client ordering reached SQL")
	}
}

func storageInventoryRawGET(t *testing.T, f *storageQAFixture, path string) map[string]any {
	t.Helper()
	response, err := f.app.Test(httptest.NewRequest(http.MethodGet, path, nil), 15000)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatalf("GET %s status=%d response=%s", path, response.StatusCode, data)
	}
	var result map[string]any
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func runStorageInventoryIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	t.Run("inventory shared fanout stays bounded and retains hidden authority", func(t *testing.T) {
		const references = 10000
		f := storagePerformanceSharedFixture(t, db, store, references)
		key := f.account.String() + "/chats/" + storagePerformanceFilename(0)
		storagePerformanceTrackS3(t, f)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		reconcile := func() {
			t.Helper()
			if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
				t.Fatal(err)
			}
			f.inventoryS3Requests.Store(0)
		}
		check := func(wantReferences int, retained bool) {
			t.Helper()
			page := storageInventoryRawGET(t, f, "/storage/files?limit=40")
			files := storageQAItems(t, page, "files")
			if page["total"] != float64(1) || len(files) != 1 || files[0]["references_count"] != float64(wantReferences) || files[0]["retained_elsewhere"] != retained || files[0]["has_more_uses"] != true {
				t.Fatalf("incorrect shared-file projection: %v", files)
			}
			if origins, ok := files[0]["origins"].([]any); !ok || len(origins) > 6 {
				t.Fatal("shared-file summary materialized every use")
			}
			if f.inventoryS3Requests.Load() != 0 {
				t.Fatal("shared-file page contacted S3")
			}
		}
		check(references, false)
		config, _ := json.Marshal(map[string]any{"overlay_image_url": mediaProxyURLFromObjectKey(key)})
		f.exec(`INSERT INTO dynamics(account_id,name,slug,config) VALUES($1,'Secret fanout origin',$2,$3::jsonb)`, f.account, "fanout-"+f.account.String(), config)
		reconcile()
		check(references, true)
		if got := storageInventoryRawGET(t, f, "/storage/files?q=Secret%20fanout")["total"]; got != float64(0) {
			t.Fatal("hidden source leaked through search")
		}
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats, domain.PermDynamics})
		check(references+1, false)
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings, domain.PermChats})
		check(references, true) // Revocation is immediate without rebuilding the index.
		f.exec(`DELETE FROM dynamics WHERE account_id=$1`, f.account)
		f.exec(`INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state) VALUES($1,$2,$3,true,'active')`, f.account, key, f.user)
		reconcile()
		check(references, false) // This actor's verified ownership is not a hidden use.
		f.exec(`INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state) VALUES($1,$2,$3,true,'active')`, f.account, key, f.secondUser)
		reconcile()
		check(references, true) // Another actor's claim still retains the object.
	})
	t.Run("inventory private identities require current module and resource authority", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		task := storagePrivateQASeedTask(f)
		_ = storagePrivateQASeedBoard(f)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		reconcile := func() {
			t.Helper()
			if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
				t.Fatal(err)
			}
		}
		expectFiles := func(want int) {
			t.Helper()
			page := storageInventoryRawGET(t, f.storageQAFixture, "/storage/files")
			if page["total"] != float64(want) || len(storageQAItems(t, page, "files")) != want {
				t.Fatalf("private projection count=%v want=%d", page["total"], want)
			}
		}
		reconcile()
		expectFiles(2) // Real task and board grants, with their module permissions.
		f.permissions(domain.PermSettings)
		expectFiles(0) // Resource Edit grants alone never bypass the module gate.
		f.permissions(domain.PermSettings, domain.PermTasks)
		expectFiles(1)
		f.permissions(domain.PermSettings, domain.PermTasks, domain.PermWhiteboards)
		expectFiles(2)
		f.exec(`UPDATE user_accounts SET role='admin' WHERE account_id=$1 AND user_id=$2`, f.account, f.user)
		f.permissions(domain.PermSettings)
		expectFiles(2) // Current account administration supplies module authority.
		f.exec(`UPDATE task_attachments SET attachment_scope='comment_draft',draft_owner_id=$3,draft_expires_at=NOW()+INTERVAL '1 hour' WHERE account_id=$1 AND id=$2`, f.account, task.attachment, f.secondUser)
		reconcile()
		expectFiles(1) // Admin still cannot see someone else's unpublished upload.
		f.exec(`UPDATE task_attachments SET draft_owner_id=$3 WHERE account_id=$1 AND id=$2`, f.account, task.attachment, f.user)
		reconcile()
		expectFiles(2)
	})
	t.Run("inventory empty authorized filename never reveals global asset name or search", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, message := f.media(f.account, "chats", "opaque-object.pdf", true)
		f.exec(`UPDATE media_assets SET filename='hidden-original-contract.pdf' WHERE account_id=$1 AND id=$2`, f.account, asset)
		f.exec(`UPDATE messages SET media_filename='' WHERE account_id=$1 AND id=$2`, f.account, message)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		page := storageInventoryRawGET(t, f, "/storage/files")
		files := storageQAItems(t, page, "files")
		if len(files) != 1 || files[0]["filename"] != "Documento" {
			t.Fatalf("authorized unnamed use inherited another source's filename: %v", files)
		}
		if got := storageInventoryRawGET(t, f, "/storage/files?q=hidden-original-contract")["total"]; got != float64(0) {
			t.Fatalf("search matched an unauthorized filename: %v", got)
		}
		plan := f.preview("trash", key)
		items := storageQAItems(t, plan, "items")
		if len(items) != 1 || items[0]["filename"] != "Documento" {
			t.Fatalf("legacy selected catalog inherited the global filename: %v", items)
		}
	})
	t.Run("inventory recovery summaries count physical bytes instead of historical snapshots", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "recovery-accounting.pdf", true)
		f.confirm(f.preview("trash", key))
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		initial := storageInventoryRawGET(t, f, "/storage/usage")
		if initial["object_count"] != float64(1) || initial["trash_bytes"] == float64(0) {
			t.Fatalf("recovery was not initially accounted: %v", initial)
		}
		if err := store.DeleteFile(ctx, key); err != nil {
			t.Fatal(err)
		}
		f.exec(`UPDATE storage_inventory_scans SET next_run_at=NOW() WHERE account_id=$1`, f.account)
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		usage := storageInventoryRawGET(t, f, "/storage/usage")
		if usage["object_count"] != float64(0) || usage["visible_bytes"] != float64(0) || usage["trash_bytes"] != float64(0) {
			t.Fatalf("unavailable recovery invented physical storage: %v", usage)
		}
	})
	t.Run("inventory replacement observes source generation without domain updated timestamp", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "chats", "replaced-index.pdf", true)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		var previousObservation time.Time
		if err := db.QueryRow(ctx, `SELECT observed_at FROM storage_inventory_objects WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&previousObservation); err != nil {
			t.Fatal(err)
		}
		payload := []byte(strings.Repeat("replacement-byte", 256))
		if _, err := store.UploadObject(ctx, key, payload, "application/pdf"); err != nil {
			t.Fatal(err)
		}
		// Some existing writers do not maintain updated_at. The durable source
		// generation is the refresh signal; metadata size is not physical truth.
		f.exec(`UPDATE media_assets SET size_bytes=999999 WHERE account_id=$1 AND id=$2`, f.account, asset)
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		if got := storageInventoryRawGET(t, f, "/storage/usage")["visible_bytes"]; got != float64(len(payload)) {
			t.Fatalf("replacement did not use current physical bytes: %v", got)
		}
		// A listing started before that Stat must not restore old observations.
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if err = f.server.storageInventoryUpsertObjects(ctx, tx, f.account, "ordinary", 1, []storage.InventoryObject{{Key: key, Size: 1, ETag: "old", LastModified: previousObservation, ObservedAt: previousObservation}}); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		if got := storageInventoryRawGET(t, f, "/storage/usage")["visible_bytes"]; got != float64(len(payload)) {
			t.Fatalf("older observation overwrote replacement: %v", got)
		}
	})
	t.Run("inventory SQL pagination current source generations and zero request S3", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "indexed-visible.pdf", true)
		_, _, _ = f.media(f.other, "chats", "must-stay-hidden.pdf", true)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		var requests atomic.Int64
		_, counted := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			original := proxy.Director
			proxy.Director = func(r *http.Request) { requests.Add(1); original(r) }
		})
		f.server.storage = counted
		requests.Store(0)
		files := storageInventoryRawGET(t, f, "/storage/files?limit=1")
		if files["total"] != float64(1) || files["catalog_status"] != "ready" {
			t.Fatalf("indexed page: %v", files)
		}
		usage := storageInventoryRawGET(t, f, "/storage/usage")
		if usage["object_count"] != float64(1) || usage["scope"] != "authorized" {
			t.Fatalf("indexed usage: %v", usage)
		}
		if requests.Load() != 0 {
			t.Fatalf("GET enumerated/stat'ed S3: calls=%d", requests.Load())
		}
		f.exec(`UPDATE messages SET media_url=NULL,media_asset_id=NULL WHERE account_id=$1 AND id=$2`, f.account, message)
		stale := storageInventoryRawGET(t, f, "/storage/files")
		if stale["total"] != float64(0) || stale["catalog_status"] != "indexing" {
			t.Fatalf("outdated source retained access: %v", stale)
		}
		f.exec(`UPDATE messages SET media_url=$3 WHERE account_id=$1 AND id=$2`, f.account, message, mediaProxyURLFromObjectKey(key))
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		requests.Store(0)
		f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, []string{domain.PermSettings})
		if got := storageInventoryRawGET(t, f, "/storage/files")["total"]; got != float64(0) {
			t.Fatalf("role revocation leaked cached files: %v", got)
		}
		if got := storageInventoryRawGET(t, f, "/storage/usage")["used_bytes"]; got != float64(0) {
			t.Fatalf("role revocation leaked cached bytes: %v", got)
		}
		if requests.Load() != 0 {
			t.Fatal("authorization read unexpectedly contacted S3")
		}
	})
	t.Run("inventory legacy discovery physical absence and incomplete scan", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "legacy-index.pdf", true)
		f.exec(`DELETE FROM storage_objects WHERE account_id=$1 AND object_key=$2`, f.account, key)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		initial := storageInventoryRawGET(t, f, "/storage/usage")
		if initial["inventory_complete"] != false || initial["catalog_status"] != "indexing" {
			t.Fatalf("unbuilt index claimed complete: %v", initial)
		}
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		if storageInventoryRawGET(t, f, "/storage/files")["total"] != float64(1) {
			t.Fatal("S3 legacy object was not discovered")
		}
		if err := store.DeleteFile(ctx, key); err != nil {
			t.Fatal(err)
		}
		f.exec(`UPDATE storage_inventory_scans SET next_run_at=NOW() WHERE account_id=$1`, f.account)
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		if storageInventoryRawGET(t, f, "/storage/files")["total"] != float64(0) {
			t.Fatal("confirmed physical absence was not reconciled")
		}
		var bytes int64
		if err := db.QueryRow(ctx, `SELECT size_bytes FROM storage_inventory_totals WHERE account_id=$1`, f.account).Scan(&bytes); err != nil || bytes != 0 {
			t.Fatalf("physical totals bytes=%d error=%v", bytes, err)
		}
	})
}
