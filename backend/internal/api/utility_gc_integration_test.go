package api

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/internal/utilities"
	"github.com/naperu/clarin/pkg/database"
)

func TestUtilityGCProtectsExternalAssetsAndRecoveryReferencesIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_UTILITIES_INTEGRATION") != "1" {
		t.Skip("requires disposable loopback PostgreSQL and MinIO")
	}
	raw := os.Getenv("UTILITIES_TEST_DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/clarin_utilities_qa" {
		t.Fatal("isolated loopback database required")
	}
	endpoint := os.Getenv("UTILITIES_TEST_MINIO_ENDPOINT")
	if !strings.HasPrefix(endpoint, "127.0.0.1:") {
		t.Fatal("isolated loopback MinIO required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	store, err := storage.New(storage.Config{Endpoint: endpoint, AccessKey: "utilitiesqa", SecretKey: "utilities-qa-only", Bucket: "clarin-utilities-qa-b7a3", PublicURL: "http://invalid.test"})
	if err != nil {
		t.Fatal(err)
	}
	a, u, asset := uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Utility retention fixture')`, a)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'fixture-only')`, u, a, u.String(), u.String()+"@fixture.invalid")
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		_, _ = db.Exec(cleanup, `DELETE FROM accounts WHERE id=$1`, a)
	})
	s := &utilities.Service{Store: &utilities.Store{DB: db}, Objects: utilityObjectStore{store}}
	s.ReferenceCheck = func(ctx context.Context, tx pgx.Tx, account uuid.UUID, key string) (bool, error) {
		return utilityStorageReferences(ctx, tx, account, key, store)
	}
	doc, err := s.Store.Create(ctx, a, u, utilities.DocumentInput{Type: "json", Title: "Retención externa", OperationID: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.WriteContent(ctx, a, u, doc.ID, "panel-a", "text/plain", 0, uuid.New(), []byte("fixture")); err != nil {
		t.Fatal(err)
	}
	var key string
	if err = db.QueryRow(ctx, `SELECT object_key FROM utility_content WHERE account_id=$1 AND owner_id=$2 AND document_id=$3`, a, u, doc.ID).Scan(&key); err != nil {
		t.Fatal(err)
	}
	exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,size_bytes,status) VALUES($1,$2,$3,$4,7,'active')`, asset, a, asset.String(), key)
	exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after) VALUES($1,$2,$3,'fixture.txt','document',7,'[]',NOW()+INTERVAL '7 days')`, a, key, u)
	exec(`INSERT INTO storage_removed_references(account_id,actor_id,operation_id,object_key,use_id,adapter,origin_type,filename,media_type,size_bytes,snapshot) VALUES($1,$2,$3,$4,$5,'ordinary','chats','fixture.txt','document',7,'{}')`, a, u, uuid.New(), key, uuid.NewString())
	if err = s.Store.Delete(ctx, a, u, doc.ID, doc.Version); err != nil {
		t.Fatal(err)
	}
	workerDone := make(chan struct{})
	go func() { s.RunWorkers(ctx); close(workerDone) }()
	defer func() { cancel(); <-workerDone }()
	assertRetained := func() {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			var deferred bool
			if e := db.QueryRow(ctx, `SELECT available_at>NOW()+INTERVAL '30 seconds' FROM utility_objects WHERE account_id=$1 AND object_key=$2`, a, key).Scan(&deferred); e != nil {
				t.Fatal(e)
			}
			if deferred {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("cleanup did not defer retained object")
			}
			time.Sleep(25 * time.Millisecond)
		}
		if _, e := store.GetFileInfo(ctx, key); e != nil {
			t.Fatal("retained object was physically deleted", e)
		}
	}
	assertRetained()
	exec(`UPDATE media_assets SET status='deleted' WHERE account_id=$1 AND id=$2`, a, asset)
	exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1 AND object_key=$2`, a, key)
	assertRetained()
	exec(`DELETE FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, a, key)
	exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1 AND object_key=$2`, a, key)
	assertRetained()
	exec(`UPDATE storage_removed_references SET state='restored' WHERE account_id=$1 AND object_key=$2`, a, key)
	exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1 AND object_key=$2`, a, key)
	deadline := time.Now().Add(5 * time.Second)
	for {
		var count int
		if err = db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND object_key=$2`, a, key).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("released object was not cleaned")
		}
		time.Sleep(25 * time.Millisecond)
	}
	if _, err = store.GetFileInfo(ctx, key); err == nil {
		t.Fatal("released physical object remains")
	}
}
