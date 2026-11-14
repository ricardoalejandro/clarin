package utilities

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	"github.com/naperu/clarin/pkg/database"
)

type integrationObjects struct{ *storage.Storage }

func (s integrationObjects) DeleteFile(ctx context.Context, key string) error {
	return s.DeleteUtilityObject(ctx, key)
}

// Explicit loopback-only opt-in prevents an accidental run against account
// data. The disposable database and MinIO bucket must be dedicated to this test.
func TestUtilitiesPostgresAndMinIOIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_UTILITIES_INTEGRATION") != "1" {
		t.Skip("requires isolated loopback PostgreSQL and MinIO")
	}
	raw := os.Getenv("UTILITIES_TEST_DATABASE_URL")
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/clarin_utilities_qa" {
		t.Fatal("isolated loopback clarin_utilities_qa database required")
	}
	endpoint := os.Getenv("UTILITIES_TEST_MINIO_ENDPOINT")
	if !strings.HasPrefix(endpoint, "127.0.0.1:") {
		t.Fatal("isolated loopback MinIO required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	db, err := pgxpool.New(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	for pass := 0; pass < 2; pass++ {
		if err = database.Migrate(db); err != nil {
			t.Fatalf("migration pass %d: %v", pass, err)
		}
	}
	store, err := storage.New(storage.Config{Endpoint: endpoint, AccessKey: "utilitiesqa", SecretKey: "utilities-qa-only", Bucket: "clarin-utilities-qa-b7a3", PublicURL: "http://invalid.test"})
	if err != nil {
		t.Fatal(err)
	}
	minioClient, err := minio.New(endpoint, &minio.Options{Creds: credentials.NewStaticV4("utilitiesqa", "utilities-qa-only", "")})
	if err != nil {
		t.Fatal(err)
	}
	if err = minioClient.SetBucketVersioning(ctx, "clarin-utilities-qa-b7a3-private", minio.BucketVersioningConfiguration{Status: "Enabled"}); err != nil {
		t.Fatal(err)
	}
	a, b, u, v := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Utility QA A'),($2,'Utility QA B')`, a, b)
	for _, user := range []uuid.UUID{u, v} {
		exec(`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'fixture-only')`, user, a, user.String(), user.String()+"@fixture.invalid")
	}
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		_, _ = db.Exec(cleanup, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{a, b})
	})
	s := &Service{Store: &Store{DB: db}, Objects: integrationObjects{store}, Cipher: testCipher(t, "qa", map[string][]byte{"qa": bytes.Repeat([]byte{3}, 32)})}
	doc, err := s.Store.Create(ctx, a, u, DocumentInput{Type: "json", Title: "Prueba JSON", OperationID: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	t.Run("personal and account isolation", func(t *testing.T) {
		for _, scope := range [][2]uuid.UUID{{a, v}, {b, u}} {
			if _, e := s.Store.Get(ctx, scope[0], scope[1], doc.ID); !errors.Is(e, ErrMissing) {
				t.Fatalf("cross scope read: %v", e)
			}
			if _, e := s.WriteContent(ctx, scope[0], scope[1], doc.ID, "panel-a", "text/plain", 0, uuid.New(), []byte("forbidden")); !errors.Is(e, ErrMissing) {
				t.Fatalf("cross scope write: %v", e)
			}
		}
	})
	var revision int64
	t.Run("snapshot journal retries and conflict", func(t *testing.T) {
		op := uuid.New()
		first, e := s.WriteContent(ctx, a, u, doc.ID, "panel-a", "text/plain;charset=utf-8", 0, op, []byte("a😀中"))
		if e != nil {
			t.Fatal(e)
		}
		if len(first.Document.Slots) != 1 || first.Document.Slots[0].Version != first.Content.Version {
			t.Fatal("canonical snapshot reply omitted slots")
		}
		retry, e := s.WriteContent(ctx, a, u, doc.ID, "panel-a", "text/plain;charset=utf-8", 0, op, []byte("a😀中"))
		if e != nil || retry.Content.Version != first.Content.Version {
			t.Fatal("retry was not idempotent", e)
		}
		if _, e = s.WriteContent(ctx, a, u, doc.ID, "panel-a", "text/plain", 0, uuid.New(), []byte("stale")); !errors.Is(e, ErrConflict) {
			t.Fatal("snapshot CAS missing", e)
		}
		in := ChangeInput{Slot: "panel-a", BaseVersion: first.Content.Version, OperationID: uuid.New(), Edits: []Edit{{Offset: 3, DeleteCount: 1, Text: "listo"}}}
		changed, e := s.Changes(ctx, a, u, doc.ID, in)
		if e != nil {
			t.Fatal(e)
		}
		if len(changed.Document.Slots) != 1 || changed.Document.Slots[0].Version != changed.Content.Version {
			t.Fatal("canonical journal reply omitted slots")
		}
		revision = changed.Content.Version
		if _, e = s.Changes(ctx, a, u, doc.ID, in); e != nil {
			t.Fatal("journal retry failed", e)
		}
		in.OperationID = uuid.New()
		if _, e = s.Changes(ctx, a, u, doc.ID, in); !errors.Is(e, ErrConflict) {
			t.Fatal("journal CAS missing", e)
		}
		data, c, e := s.ReadContent(ctx, a, u, doc.ID, "panel-a")
		if e != nil || string(data) != "a😀listo" || c.Version != revision {
			t.Fatalf("journal recovery: %q %v", data, e)
		}
	})
	t.Run("checkpoint and content search", func(t *testing.T) {
		exec(`UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1`, a)
		if e := s.processContentJob(ctx); e != nil {
			t.Fatal(e)
		}
		data, content, e := s.ReadContent(ctx, a, u, doc.ID, "panel-a")
		if e != nil || string(data) != "a😀listo" || content.SnapshotVersion != revision {
			t.Fatal("checkpoint lost journal", e)
		}
		items, _, e := s.Store.List(ctx, a, u, Query{Search: "listo"})
		if e != nil || len(items) != 1 || items[0].ID != doc.ID {
			t.Fatal("content search failed", e)
		}
		hidden, _, e := s.Store.List(ctx, a, v, Query{Search: "listo"})
		if e != nil || len(hidden) != 0 {
			t.Fatal("search leaked owner", e)
		}
	})
	t.Run("metadata version and workspace", func(t *testing.T) {
		name := "Renombrado"
		patched, e := s.Store.Patch(ctx, a, u, doc.ID, DocumentPatch{Title: &name, BaseVersion: doc.Version, OperationID: uuid.New()})
		if e != nil {
			t.Fatal(e)
		}
		if len(patched.Slots) != 1 {
			t.Fatal("canonical metadata reply omitted slots")
		}
		if _, e = s.Store.Patch(ctx, a, u, doc.ID, DocumentPatch{Title: &name, BaseVersion: doc.Version, OperationID: uuid.New()}); !errors.Is(e, ErrConflict) {
			t.Fatal("metadata CAS missing", e)
		}
		doc = patched
		w, e := s.Store.SaveWorkspace(ctx, a, u, domainWorkspace(doc.ID))
		if e != nil || len(w.OpenIDs) != 1 {
			t.Fatal("workspace failed", e)
		}
		if _, e = s.Store.SaveWorkspace(ctx, a, u, domainWorkspace(doc.ID)); !errors.Is(e, ErrConflict) {
			t.Fatal("workspace CAS missing", e)
		}
	})
	t.Run("vault envelope recovery rotation and physical cleanup", func(t *testing.T) {
		in := VaultInput{Name: "Clave prueba", Kind: "rsa", Algorithm: "RSA", Material: `{"privateKey":"fixture-private"}`, OperationID: uuid.New()}
		item, e := s.CreateVault(ctx, a, u, in)
		if e != nil {
			t.Fatal(e)
		}
		if _, _, _, e = s.VaultMaterial(ctx, a, v, item.ID); !errors.Is(e, ErrMissing) {
			t.Fatal("vault owner boundary failed", e)
		}
		plain, _, _, e := s.VaultMaterial(ctx, a, u, item.ID)
		if e != nil || plain != in.Material {
			t.Fatal("vault recovery failed", e)
		}
		// Restoring the independently backed-up key ring must recover the same
		// object; maintenance then rewraps unopened entries without rewriting it.
		previousCipher := s.Cipher
		s.Cipher = testCipher(t, "next", map[string][]byte{"qa": bytes.Repeat([]byte{3}, 32), "next": bytes.Repeat([]byte{4}, 32)})
		if e = s.rotateVaultKeys(ctx); e != nil {
			t.Fatal("rotation maintenance failed", e)
		}
		plain, _, _, e = s.VaultMaterial(ctx, a, u, item.ID)
		if e != nil || plain != in.Material {
			t.Fatal("rotated backup recovery failed", e)
		}
		s.Cipher = previousCipher
		var key string
		var wrapped []byte
		if e = db.QueryRow(ctx, `SELECT object_key,wrapped_key FROM utility_vault WHERE id=$1`, item.ID).Scan(&key, &wrapped); e != nil {
			t.Fatal(e)
		}
		stored, e := store.GetFileLimited(ctx, key, SecretLimit+1024)
		if e != nil || bytes.Contains(stored, []byte("fixture-private")) || bytes.Contains(wrapped, []byte("fixture-private")) {
			t.Fatal("plaintext persisted", e)
		}
		if _, e = store.UploadObject(ctx, key, stored, "application/octet-stream"); e != nil {
			t.Fatal(e)
		}
		updated, e := s.WriteVaultMaterial(ctx, a, u, item.ID, VaultMaterialInput{Version: item.Version, Material: `{"privateKey":"changed-fixture"}`, OperationID: uuid.New()})
		if e != nil {
			t.Fatal(e)
		}
		if e = s.DeleteVault(ctx, a, u, item.ID, updated.Version); e != nil {
			t.Fatal(e)
		}
		exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1 AND resource_id=$2`, a, item.ID)
		for i := 0; i < 5; i++ {
			if e = s.processGC(ctx); e != nil {
				t.Fatal(e)
			}
		}
		if _, e = store.GetFileInfo(ctx, key); e == nil {
			t.Fatal("private object still occupies storage")
		}
		for version := range minioClient.ListObjects(ctx, "clarin-utilities-qa-b7a3-private", minio.ListObjectsOptions{Prefix: key, Recursive: true, WithVersions: true}) {
			if version.Err != nil {
				t.Fatal(version.Err)
			}
			if version.Key == key {
				t.Fatal("a physical object version or delete marker remains")
			}
		}
	})
	t.Run("original bytes preserve non UTF8 and do not index", func(t *testing.T) {
		raw := []byte{0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x2f, 0x00, 0x3e, 0x00}
		written, e := s.WriteContent(ctx, a, u, doc.ID, "original-a", "application/xml", 0, uuid.New(), raw)
		if e != nil {
			t.Fatal(e)
		}
		if written.Content.Indexing || written.Content.ContentType != "application/octet-stream" {
			t.Fatal("original incorrectly treated as editable text")
		}
		data, _, e := s.ReadContent(ctx, a, u, doc.ID, "original-a")
		if e != nil || !bytes.Equal(data, raw) {
			t.Fatal("original bytes changed", e)
		}
		var count int
		if e = db.QueryRow(ctx, `SELECT count(*) FROM utility_content_jobs WHERE account_id=$1 AND document_id=$2 AND slot='original-a'`, a, doc.ID).Scan(&count); e != nil || count != 0 {
			t.Fatal("original was queued for indexing", e)
		}
	})
	t.Run("concurrent edits commit once", func(t *testing.T) {
		_, content, e := s.ReadContent(ctx, a, u, doc.ID, "panel-a")
		if e != nil {
			t.Fatal(e)
		}
		var wg sync.WaitGroup
		results := make(chan error, 2)
		for _, suffix := range []string{"uno", "dos"} {
			wg.Add(1)
			go func(value string) {
				defer wg.Done()
				_, err := s.Changes(ctx, a, u, doc.ID, ChangeInput{Slot: "panel-a", BaseVersion: content.Version, OperationID: uuid.New(), Edits: []Edit{{Offset: 0, DeleteCount: 0, Text: value}}})
				results <- err
			}(suffix)
		}
		wg.Wait()
		close(results)
		ok, conflict := 0, 0
		for err := range results {
			if err == nil {
				ok++
			} else if errors.Is(err, ErrConflict) {
				conflict++
			} else {
				t.Fatal(err)
			}
		}
		if ok != 1 || conflict != 1 {
			t.Fatal("concurrent changes were not atomic", ok, conflict)
		}
	})
	t.Run("delete removes search journal and all objects", func(t *testing.T) {
		if e := s.Store.Delete(ctx, a, u, doc.ID, doc.Version); e != nil {
			t.Fatal(e)
		}
		if _, e := s.Store.Get(ctx, a, u, doc.ID); !errors.Is(e, ErrMissing) {
			t.Fatal("deleted document readable", e)
		}
		exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1`, a)
		for i := 0; i < 8; i++ {
			if e := s.processGC(ctx); e != nil {
				t.Fatal(e)
			}
		}
		var count int
		if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1`, a).Scan(&count); e != nil || count != 0 {
			t.Fatal("cleanup remains", count, e)
		}
		for _, table := range []string{"utility_search_chunks", "utility_changes", "utility_content"} {
			if e := db.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM %s WHERE account_id=$1", table), a).Scan(&count); e != nil || count != 0 {
				t.Fatal("dependent data remains", table, e)
			}
		}
	})
}

func domainWorkspace(id uuid.UUID) domain.UtilityWorkspace {
	return domain.UtilityWorkspace{OpenIDs: []uuid.UUID{id}, ActiveID: &id, Version: 0}
}
