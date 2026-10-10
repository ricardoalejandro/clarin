package database

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStorageReferenceGuardSpecification(t *testing.T) {
	seen := map[string]bool{}
	for _, spec := range storageReferenceGuardSpecs {
		if seen[spec.table] || spec.fields == "" || spec.accountMode == "" {
			t.Fatalf("ambiguous or empty media writer guard: %+v", spec)
		}
		seen[spec.table] = true
	}
	for _, table := range []string{"messages", "media_assets", "campaign_attachments", "dynamics", "survey_templates", "survey_file_uploads", "task_attachments", "whiteboard_assets"} {
		if !seen[table] {
			t.Fatalf("media writer %s has no deletion barrier", table)
		}
	}
}

// This test changes only explicitly enabled, disposable loopback databases.
// PGlite can exercise PostgreSQL SQL and triggers, but cannot prove independent
// session/lock behavior. The concurrency subtest therefore requires PostgreSQL.
func TestStorageReferenceGuardIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_REFERENCE_GUARD_INTEGRATION") != "1" {
		t.Skip("enable only against a disposable loopback PostgreSQL database")
	}
	raw := os.Getenv("DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || !strings.HasPrefix(parsed.Path, "/clarin_storage_") {
		t.Fatal("disposable loopback clarin_storage_ database required")
	}
	ctx := context.Background()
	config, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal(err)
	}
	emulated := os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1"
	if emulated {
		config.MaxConns = 1
		config.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeSimpleProtocol
	}
	db, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	// Run the new migration twice on populated schema, independently of Migrate's
	// registration, so its upgrade idempotency is checked explicitly.
	for pass := 0; pass < 2; pass++ {
		for _, migration := range storageSelfServiceReferenceGuardMigrations() {
			if _, err := db.Exec(ctx, migration); err != nil {
				t.Fatal(err)
			}
		}
	}
	a, b, user := uuid.New(), uuid.New(), uuid.New()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Storage guard A'),($2,'Storage guard B')`, a, b)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test-only')`, user, a, user.String(), user.String()+"@test.invalid")
	key := a.String() + "/uploads/report final.pdf"
	asset := uuid.New()
	exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes) VALUES($1,$2,$3,$4,'document','application/pdf','report final.pdf',42)`, asset, a, asset.String(), key)
	exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after,state) VALUES($1,$2,$3,'report final.pdf','document',42,'[]',NOW()-INTERVAL '1 day','purging')`, a, key, user)
	t.Run("canonical keys and path escape remain exact", func(t *testing.T) {
		cases := []struct {
			payload any
			want    []string
		}{
			{map[string]any{"url": "/api/media/file/" + a.String() + "/uploads/report%20final.pdf?media_preview=x"}, []string{key}},
			{map[string]any{"nested": []any{map[string]any{"url": "https://media.invalid/clarin-media/" + a.String() + "/uploads/report%20final.pdf"}, nil}}, []string{key}},
			{map[string]any{"raw": a.String() + "/uploads/a+b.pdf"}, []string{a.String() + "/uploads/a+b.pdf"}},
			{map[string]any{"raw": key}, []string{key}},
			{map[string]any{"url": "https://media.invalid/custom-bucket/" + a.String() + "%2Fuploads%2Freport%20final.pdf?signature=x"}, []string{key}},
			{map[string]any{"url": "/api/media/file/" + a.String() + "%2Fuploads%2Fespa%C3%B1ol.pdf"}, []string{a.String() + "/uploads/español.pdf"}},
			{map[string]any{"url": "https://other.invalid/plain.pdf"}, []string{}},
			{map[string]any{"url": "/api/media/file/" + a.String() + "/uploads/../bad.pdf"}, []string{}},
		}
		for _, tc := range cases {
			payload, _ := json.Marshal(tc.payload)
			var got []string
			if err := db.QueryRow(ctx, `SELECT clarin_storage_reference_keys($1::jsonb)`, string(payload)).Scan(&got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("key normalization=%v want=%v", got, tc.want)
			}
		}
	})
	assertRejected := func(q string, args ...any) {
		t.Helper()
		_, err := db.Exec(ctx, q, args...)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
			t.Fatalf("reference was not rejected safely: %v", err)
		}
	}
	t.Run("purging and purged URLs cannot be reattached", func(t *testing.T) {
		for _, state := range []string{"purging", "purged"} {
			exec(`UPDATE storage_media_trash SET state=$3 WHERE account_id=$1 AND object_key=$2`, a, key, state)
			assertRejected(`INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, a, "/api/media/file/"+a.String()+"/uploads/report%20final.pdf?token=stale")
			assertRejected(`INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, b, "/api/media/file/"+a.String()+"/uploads/report%20final.pdf")
		}
		// An exact key is blocked, not another file that merely has its prefix.
		exec(`INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, a, "/api/media/file/"+a.String()+"/uploads/report%20final.pdf.extra")
	})
	t.Run("active media cannot revive a tombstone but a new upload key can", func(t *testing.T) {
		exec(`UPDATE media_assets SET status='deleted',deleted_at=NOW() WHERE account_id=$1 AND id=$2`, a, asset)
		assertRejected(`UPDATE media_assets SET status='active',deleted_at=NULL WHERE account_id=$1 AND id=$2`, a, asset)
		exec(`UPDATE media_assets SET object_key=$3,status='active',deleted_at=NULL WHERE account_id=$1 AND id=$2`, a, asset, a.String()+"/uploads/new-object.pdf")
		exec(`UPDATE media_assets SET updated_at=NOW() WHERE account_id=$1 AND id=$2`, a, asset)
	})
	t.Run("normalized asset references and child account joins are guarded", func(t *testing.T) {
		// New object reuses the deduplication row safely. Revoking its physical
		// key must also block relations containing only media_asset_id.
		newKey := a.String() + "/uploads/new-object.pdf"
		exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after,state) VALUES($1,$2,$3,'new-object.pdf','document',42,'[]',NOW(),'purging')`, a, newKey, user)
		contact := uuid.New()
		assertRejected(`INSERT INTO contacts(id,account_id,jid,name,avatar_media_asset_id) VALUES($1,$2,$3,'Guarded', $4)`, contact, a, contact.String(), asset)
		dynamic := uuid.New()
		exec(`INSERT INTO dynamics(id,account_id,type,name,slug) VALUES($1,$2,'scratch','Guarded',$3)`, dynamic, a, dynamic.String())
		assertRejected(`INSERT INTO dynamic_items(dynamic_id,image_url) VALUES($1,$2)`, dynamic, "/api/media/file/"+a.String()+"/uploads/report%20final.pdf")
		assertRejected(`UPDATE dynamics SET config=jsonb_build_object('overlay_image_url',$3::text) WHERE account_id=$1 AND id=$2`, a, dynamic, "/api/media/file/"+a.String()+"/uploads/report%20final.pdf")
	})
	t.Run("domain owned pending asset lifecycle remains attachable", func(t *testing.T) {
		// Work, whiteboards and survey uploads attach their normalized asset
		// before making it active in the same transaction. The generic storage
		// barrier must leave those domain-specific lifecycle checks untouched.
		for _, status := range []string{"task_upload_pending", "whiteboard_upload_pending", "whiteboard_gc_pending", "survey_upload_staged"} {
			pendingAsset, contact := uuid.New(), uuid.New()
			exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,status) VALUES($1,$2,$3,$4,$5)`, pendingAsset, a, pendingAsset.String(), a.String()+"/_private/qa/"+pendingAsset.String()+".png", status)
			exec(`INSERT INTO contacts(id,account_id,jid,name,avatar_media_asset_id) VALUES($1,$2,$3,'Pending lifecycle QA',$4)`, contact, a, contact.String(), pendingAsset)
		}
	})
	t.Run("other accounts remain writable and stale snapshots cannot bypass intent", func(t *testing.T) {
		if emulated {
			t.Skip("PGlite does not provide independent PostgreSQL transactions")
		}
		cleanup, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer cleanup.Rollback(ctx)
		if _, err = cleanup.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:'||$1::text,0))`, a.String()); err != nil {
			t.Fatal(err)
		}
		if _, err = cleanup.Exec(ctx, `UPDATE storage_reference_epochs SET version=version+1 WHERE account_id=$1`, a); err != nil {
			t.Fatal(err)
		}
		bounded, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		if _, err = db.Exec(bounded, `INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, b, "/api/media/file/"+b.String()+"/uploads/unrelated.webp"); err != nil {
			t.Fatalf("cleanup in A blocks account B: %v", err)
		}
		if err = cleanup.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		stale, err := db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
		if err != nil {
			t.Fatal(err)
		}
		defer stale.Rollback(ctx)
		var version int64
		if err = stale.QueryRow(ctx, `SELECT version FROM storage_reference_epochs WHERE account_id=$1`, a).Scan(&version); err != nil {
			t.Fatal(err)
		}
		exec(`UPDATE storage_reference_epochs SET version=version+1 WHERE account_id=$1`, a)
		_, err = stale.Exec(ctx, `INSERT INTO saved_stickers(account_id,media_url) VALUES($1,$2)`, a, "/api/media/file/"+a.String()+"/uploads/snapshot.webp")
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "40001" {
			t.Fatalf("stale snapshot did not fail safely: %v", err)
		}
	})
}
