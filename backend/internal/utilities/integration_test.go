package utilities

import (
	"bytes"
	"context"
	"encoding/json"
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

type failedUploadObjects struct{ ObjectStorage }

type pausedReadObjects struct {
	ObjectStorage
	entered chan struct{}
	resume  chan struct{}
}

func (s pausedReadObjects) GetFileLimited(ctx context.Context, key string, limit int64) ([]byte, error) {
	close(s.entered)
	select {
	case <-s.resume:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	return s.ObjectStorage.GetFileLimited(ctx, key, limit)
}

func (s failedUploadObjects) UploadObject(context.Context, string, []byte, string) (string, error) {
	return "", errors.New("fixture upload failure")
}

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
	t.Run("content read protects its snapshot and journal from checkpointing", func(t *testing.T) {
		exec(`UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1 AND document_id=$2`, a, doc.ID)
		paused := pausedReadObjects{ObjectStorage: s.Objects, entered: make(chan struct{}), resume: make(chan struct{})}
		reader := *s
		reader.Objects = paused
		finished := make(chan error, 1)
		go func() {
			data, content, e := reader.ReadContent(ctx, a, u, doc.ID, "panel-a")
			if e == nil && (string(data) != "a😀listo" || content.Version != revision) {
				e = fmt.Errorf("incoherent content snapshot: version %d", content.Version)
			}
			finished <- e
		}()
		select {
		case <-paused.entered:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		checkpointErr := s.processContentJob(ctx)
		close(paused.resume)
		if checkpointErr == nil {
			t.Fatal("checkpoint must wait for the shared document read lock")
		}
		if e := <-finished; e != nil {
			t.Fatal(e)
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
		cryptoDoc, e := s.Store.Create(ctx, a, u, DocumentInput{Type: "criptografia", Title: "Claves QA", OperationID: uuid.New()})
		if e != nil {
			t.Fatal(e)
		}
		in := VaultInput{Name: "Clave prueba", Kind: "rsa", Algorithm: "RSA", Material: `{"privateKey":"fixture-private"}`, OperationID: uuid.New()}
		item, e := s.CreateVault(ctx, a, u, cryptoDoc.ID, in)
		if e != nil {
			t.Fatal(e)
		}
		if _, _, _, e = s.VaultMaterial(ctx, a, v, cryptoDoc.ID, item.ID); !errors.Is(e, ErrMissing) {
			t.Fatal("vault owner boundary failed", e)
		}
		plain, _, _, e := s.VaultMaterial(ctx, a, u, cryptoDoc.ID, item.ID)
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
		plain, _, _, e = s.VaultMaterial(ctx, a, u, cryptoDoc.ID, item.ID)
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
		updated, e := s.WriteVaultMaterial(ctx, a, u, cryptoDoc.ID, item.ID, VaultMaterialInput{Version: item.Version, Material: `{"privateKey":"changed-fixture"}`, OperationID: uuid.New()})
		if e != nil {
			t.Fatal(e)
		}
		if e = s.DeleteVault(ctx, a, u, cryptoDoc.ID, item.ID, updated.Version); e != nil {
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
	t.Run("document vault ownership independent copies legacy recovery and scoped cleanup", func(t *testing.T) {
		createDoc := func(account, owner uuid.UUID) domain.UtilityDocument {
			t.Helper()
			d, e := s.Store.Create(ctx, account, owner, DocumentInput{Type: "criptografia", Title: "Vault scope fixture", OperationID: uuid.New()})
			if e != nil {
				t.Fatal(e)
			}
			return d
		}
		left, right := createDoc(a, u), createDoc(a, u)
		input := VaultInput{Name: "Independent fixture", Kind: "rsa", Algorithm: "RSA", Material: `{"privateKey":"fixture-key","certificates":["fixture-cert"],"requests":["fixture-csr"]}`, OperationID: uuid.New()}
		key, e := s.CreateVault(ctx, a, u, left.ID, input)
		if e != nil {
			t.Fatal(e)
		}
		if key.DocumentID == nil || *key.DocumentID != left.ID {
			t.Fatal("missing document ownership")
		}
		for _, read := range []func() error{
			func() error { _, e := s.GetVault(ctx, a, u, right.ID, key.ID); return e },
			func() error { _, _, _, e := s.VaultMaterial(ctx, a, u, right.ID, key.ID); return e },
			func() error {
				_, e := s.PatchVault(ctx, a, u, right.ID, key.ID, VaultPatch{Name: "Forbidden", Version: key.Version, OperationID: uuid.New()})
				return e
			},
			func() error {
				_, e := s.WriteVaultMaterial(ctx, a, u, right.ID, key.ID, VaultMaterialInput{Version: key.Version, Material: input.Material, OperationID: uuid.New()})
				return e
			},
			func() error { return s.DeleteVault(ctx, a, u, right.ID, key.ID, key.Version) },
		} {
			if e = read(); !errors.Is(e, ErrMissing) {
				t.Fatal("cross-document key access", e)
			}
		}
		if _, e = s.CreateVault(ctx, a, u, right.ID, input); !errors.Is(e, ErrConflict) {
			t.Fatal("cross-document create replay", e)
		}
		page, _, e := s.ListVault(ctx, a, u, right.ID, "", "")
		if e != nil || len(page) != 0 {
			t.Fatal("neighbor key leaked into list", e)
		}
		if _, e = s.CreateVault(ctx, a, u, doc.ID, VaultInput{Name: "Wrong type", Kind: "aes", Algorithm: "AES", Material: "fixture", OperationID: uuid.New()}); !errors.Is(e, ErrMissing) {
			t.Fatal("non-crypto vault accepted", e)
		}
		config := json.RawMessage(fmt.Sprintf(`{"key_id":%q}`, key.ID.String()))
		if _, e = s.Store.Patch(ctx, a, u, right.ID, DocumentPatch{BaseVersion: right.Version, Config: config, OperationID: uuid.New()}); !errors.Is(e, ErrMissing) {
			t.Fatal("cross-document config reference accepted", e)
		}
		left, e = s.Store.Patch(ctx, a, u, left.ID, DocumentPatch{BaseVersion: left.Version, Config: config, OperationID: uuid.New()})
		if e != nil {
			t.Fatal(e)
		}
		extraInput := input
		extraInput.OperationID = uuid.New()
		extraKey, e := s.CreateVault(ctx, a, u, left.ID, extraInput)
		if e != nil {
			t.Fatal(e)
		}
		request := DocumentDuplicate{BaseVersion: left.Version, OperationID: uuid.New(), Title: "Independent copy", Config: left.Config}
		cloneContext, stopClone := context.WithTimeout(ctx, 30*time.Second)
		copy, e := s.DuplicateCryptoDocument(cloneContext, a, u, left.ID, request)
		stopClone()
		if e != nil {
			t.Fatal(e)
		}
		copiedID, parseError := uuid.Parse(configuredKey(copy.Config))
		if parseError != nil || copiedID == key.ID {
			t.Fatal("selected key not remapped")
		}
		if copiedKeys, _, e := s.ListVault(ctx, a, u, copy.ID, "", ""); e != nil || len(copiedKeys) != 2 {
			t.Fatal("clone did not complete both independent uploads", e)
		}
		plain, _, _, e := s.VaultMaterial(ctx, a, u, copy.ID, copiedID)
		if e != nil || plain != input.Material {
			t.Fatal("copy lost key/certificate/CSR", e)
		}
		var originalObject, copyObject string
		var originalEnvelope, copyEnvelope []byte
		if e = db.QueryRow(ctx, `SELECT object_key,wrapped_key FROM utility_vault WHERE id=$1`, key.ID).Scan(&originalObject, &originalEnvelope); e != nil {
			t.Fatal(e)
		}
		if e = db.QueryRow(ctx, `SELECT object_key,wrapped_key FROM utility_vault WHERE id=$1`, copiedID).Scan(&copyObject, &copyEnvelope); e != nil {
			t.Fatal(e)
		}
		if originalObject == copyObject || bytes.Equal(originalEnvelope, copyEnvelope) {
			t.Fatal("copy reused source ciphertext/envelope")
		}
		replay, e := s.DuplicateCryptoDocument(ctx, a, u, left.ID, request)
		if e != nil || replay.ID != copy.ID {
			t.Fatal("duplicate replay created another document", e)
		}
		request.OperationID = uuid.New()
		request.BaseVersion++
		if _, e = s.DuplicateCryptoDocument(ctx, a, u, left.ID, request); !errors.Is(e, ErrConflict) {
			t.Fatal("stale source accepted", e)
		}
		request.OperationID = uuid.New()
		request.BaseVersion = left.Version
		originalStore := s.Objects
		s.Objects = failedUploadObjects{s.Objects}
		_, e = s.DuplicateCryptoDocument(ctx, a, u, left.ID, request)
		s.Objects = originalStore
		if e == nil {
			t.Fatal("failed upload appeared successful")
		}
		failedID := uuid.NewSHA1(a, []byte(u.String()+"duplicate|"+request.OperationID.String()))
		if _, e = s.Store.Get(ctx, a, u, failedID); !errors.Is(e, ErrMissing) {
			t.Fatal("failed duplicate left a document", e)
		}
		var candidates int
		if e = db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND resource_id=ANY($2::uuid[]) AND state='uploading'`, a, []uuid.UUID{uuid.NewSHA1(failedID, []byte(key.ID.String())), uuid.NewSHA1(failedID, []byte(extraKey.ID.String()))}).Scan(&candidates); e != nil || candidates != 1 {
			t.Fatal("failed clone has no durable cleanup", e)
		}
		if e = s.Store.Delete(ctx, a, u, left.ID, left.Version); e != nil {
			t.Fatal(e)
		}
		if _, _, _, e = s.VaultMaterial(ctx, a, u, copy.ID, copiedID); e != nil {
			t.Fatal("source deletion damaged copy", e)
		}
		if e = db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND resource_id=$2 AND state='gc'`, a, key.ID).Scan(&candidates); e != nil || candidates < 1 {
			t.Fatal("document deletion omitted key objects", e)
		}
		legacyDoc := createDoc(a, u)
		input.OperationID = uuid.New()
		legacy, e := s.CreateVault(ctx, a, u, legacyDoc.ID, input)
		if e != nil {
			t.Fatal(e)
		}
		exec(`UPDATE utility_vault SET document_id=NULL WHERE id=$1`, legacy.ID)
		exec(`UPDATE utility_documents SET config=jsonb_build_object('key_id',$2::text) WHERE id=$1`, legacyDoc.ID, legacy.ID.String())
		legacyConfig := json.RawMessage(fmt.Sprintf(`{"key_id":%q,"active":"hash"}`, legacy.ID.String()))
		legacyDoc, e = s.Store.Patch(ctx, a, u, legacyDoc.ID, DocumentPatch{BaseVersion: legacyDoc.Version, Config: legacyConfig, OperationID: uuid.New()})
		if e != nil {
			t.Fatal("legacy reference blocked unrelated preference save", e)
		}
		metadata, e := s.GetLegacyVault(ctx, a, u, legacy.ID)
		if e != nil || metadata.DocumentID != nil {
			t.Fatal("legacy metadata unavailable", e)
		}
		if _, _, _, e = s.VaultMaterial(ctx, a, u, legacyDoc.ID, legacy.ID); !errors.Is(e, ErrMissing) {
			t.Fatal("legacy material reachable without import", e)
		}
		importRequest := LegacyVaultImport{SourceID: legacy.ID, SourceVersion: legacy.Version, OperationID: uuid.New()}
		imported, e := s.ImportLegacyVault(ctx, a, u, right.ID, importRequest)
		if e != nil {
			t.Fatal(e)
		}
		if imported.ID == legacy.ID {
			t.Fatal("legacy key was moved/shared")
		}
		if plain, _, _, e = s.VaultMaterial(ctx, a, u, right.ID, imported.ID); e != nil || plain != input.Material {
			t.Fatal("legacy import changed material", e)
		}
		if again, e := s.ImportLegacyVault(ctx, a, u, right.ID, importRequest); e != nil || again.ID != imported.ID {
			t.Fatal("legacy retry duplicated material", e)
		}
		if _, e = s.ImportLegacyVault(ctx, a, u, copy.ID, importRequest); !errors.Is(e, ErrConflict) {
			t.Fatal("legacy replay crossed document", e)
		}
		otherDoc := createDoc(a, v)
		input.OperationID = uuid.New()
		otherKey, e := s.CreateVault(ctx, a, v, otherDoc.ID, input)
		if e != nil {
			t.Fatal(e)
		}
		exec(`UPDATE utility_vault SET document_id=NULL WHERE id=$1`, otherKey.ID)
		outsideMembership := createDoc(b, u)
		input.OperationID = uuid.New()
		outsideKey, e := s.CreateVault(ctx, b, u, outsideMembership.ID, input)
		if e != nil {
			t.Fatal(e)
		}
		exec(`UPDATE utility_vault SET document_id=NULL WHERE id=$1`, outsideKey.ID)
		exec(`UPDATE users SET is_super_admin=TRUE WHERE id=$1`, u)
		manifest, e := s.Store.PrepareLegacyCleanup(ctx, u, u.String())
		if e != nil || len(manifest.Accounts) != 2 {
			t.Fatal("superadmin legacy outside membership omitted", e)
		}
		exec(`UPDATE utility_vault SET version=version+1 WHERE id=$1`, legacy.ID)
		for _, scope := range manifest.Accounts {
			if scope.AccountID == a {
				if _, e = s.Store.ApplyLegacyCleanupAccount(ctx, manifest, scope); !errors.Is(e, ErrConflict) {
					t.Fatal("stale cleanup manifest accepted", e)
				}
			}
		}
		manifest, e = s.Store.PrepareLegacyCleanup(ctx, u, u.String())
		if e != nil {
			t.Fatal(e)
		}
		deleted := 0
		for _, scope := range manifest.Accounts {
			result, e := s.Store.ApplyLegacyCleanupAccount(ctx, manifest, scope)
			if e != nil {
				t.Fatal(e)
			}
			deleted += result.Deleted
			if again, e := s.Store.ApplyLegacyCleanupAccount(ctx, manifest, scope); e != nil || again != result {
				t.Fatal("cleanup replay failed", e)
			}
		}
		if deleted != 2 {
			t.Fatal("cleanup did not cover both owned scopes", deleted)
		}
		if _, e = s.GetLegacyVault(ctx, a, v, otherKey.ID); e != nil {
			t.Fatal("cleanup deleted another user", e)
		}
		if _, _, _, e = s.VaultMaterial(ctx, a, u, right.ID, imported.ID); e != nil {
			t.Fatal("cleanup deleted new scoped key", e)
		}
		legacyDoc, e = s.Store.Get(ctx, a, u, legacyDoc.ID)
		if e != nil || configuredKey(legacyDoc.Config) != "" {
			t.Fatal("cleanup left stale document reference", e)
		}
		if _, e = s.Store.PrepareLegacyCleanup(ctx, u, "different-user"); !errors.Is(e, ErrMissing) {
			t.Fatal("cleanup did not verify exact identity", e)
		}
	})
	t.Run("quota reservations serialize without blocking parent foreign keys", func(t *testing.T) {
		account := uuid.New()
		exec(`INSERT INTO accounts(id,name,storage_limit_bytes) VALUES($1,'Quota lock fixture',11)`, account)
		t.Cleanup(func() { _, _ = db.Exec(context.Background(), `DELETE FROM accounts WHERE id=$1`, account) })
		parent, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer parent.Rollback(ctx)
		if _, e = parent.Exec(ctx, `INSERT INTO utility_documents(id,account_id,owner_id,type,title) VALUES($1,$2,$3,'criptografia','Uncommitted parent')`, uuid.New(), account, u); e != nil {
			t.Fatal(e)
		}
		quotaContext, stop := context.WithTimeout(ctx, 10*time.Second)
		defer stop()
		if _, e = s.prepareObject(quotaContext, account, u, uuid.New(), 1, "application/octet-stream", "secret"); e != nil {
			t.Fatal("parent FK blocked reservation", e)
		}
		start := make(chan struct{})
		results := make(chan error, 2)
		for i := 0; i < 2; i++ {
			go func() {
				<-start
				_, e := s.prepareObject(quotaContext, account, u, uuid.New(), 6, "application/octet-stream", "secret")
				results <- e
			}()
		}
		close(start)
		allowed, denied := 0, 0
		for i := 0; i < 2; i++ {
			e := <-results
			if e == nil {
				allowed++
			} else if errors.Is(e, ErrQuota) {
				denied++
			} else {
				t.Fatal(e)
			}
		}
		if allowed != 1 || denied != 1 {
			t.Fatal("quota reservations were not serialized", allowed, denied)
		}
		if e = parent.Rollback(ctx); e != nil {
			t.Fatal(e)
		}
	})
	t.Run("queued account removal cannot hang a child upload reservation", func(t *testing.T) {
		account := uuid.New()
		exec(`INSERT INTO accounts(id,name) VALUES($1,'Account lock fixture')`, account)
		parent, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer parent.Rollback(ctx)
		var id uuid.UUID
		if e = parent.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR KEY SHARE`, account).Scan(&id); e != nil {
			t.Fatal(e)
		}
		connection, e := db.Acquire(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer connection.Release()
		var pid int
		if e = connection.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); e != nil {
			t.Fatal(e)
		}
		removed := make(chan error, 1)
		go func() { _, e := connection.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, account); removed <- e }()
		waitingContext, stopWaiting := context.WithTimeout(ctx, 5*time.Second)
		defer stopWaiting()
		for {
			var waiting bool
			if e = db.QueryRow(waitingContext, `SELECT COALESCE(wait_event_type='Lock',FALSE) FROM pg_stat_activity WHERE pid=$1`, pid).Scan(&waiting); e != nil {
				t.Fatal(e)
			}
			if waiting {
				break
			}
			select {
			case <-waitingContext.Done():
				t.Fatal("account removal did not queue")
			case <-time.After(10 * time.Millisecond):
			}
		}
		reservationContext, stopReservation := context.WithTimeout(ctx, 2*time.Second)
		_, reservationError := s.prepareObject(reservationContext, account, u, uuid.New(), 1, "application/octet-stream", "secret")
		stopReservation()
		// Either compatible locks pass immediately or the queued deletion wins;
		// the reservation must be cancellable before releasing the parent barrier.
		if reservationError != nil && !errors.Is(reservationError, context.DeadlineExceeded) && !errors.Is(reservationError, context.Canceled) {
			t.Fatal("unexpected reservation failure", reservationError)
		}
		if e = parent.Rollback(ctx); e != nil {
			t.Fatal(e)
		}
		select {
		case e = <-removed:
			if e != nil {
				t.Fatal(e)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("account removal remained blocked")
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
		var liveVaultObjects int
		if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_vault WHERE account_id=$1`, a).Scan(&liveVaultObjects); e != nil {
			t.Fatal(e)
		}
		if e := s.Store.Delete(ctx, a, u, doc.ID, doc.Version); e != nil {
			t.Fatal(e)
		}
		if _, e := s.Store.Get(ctx, a, u, doc.ID); !errors.Is(e, ErrMissing) {
			t.Fatal("deleted document readable", e)
		}
		exec(`UPDATE utility_objects SET available_at=NOW() WHERE account_id=$1`, a)
		for i := 0; i < 64; i++ {
			var due int
			if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND state IN ('gc','uploading') AND available_at<=NOW()`, a).Scan(&due); e != nil {
				t.Fatal(e)
			}
			if due == 0 {
				break
			}
			if e := s.processGC(ctx); e != nil {
				t.Fatal(e)
			}
		}
		var count int
		if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND resource_id=$2`, a, doc.ID).Scan(&count); e != nil || count != 0 {
			t.Fatal("deleted document objects remain", count, e)
		}
		if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_objects WHERE account_id=$1 AND state IN ('gc','uploading')`, a).Scan(&count); e != nil || count != 0 {
			t.Fatal("deleted source cleanup remains", count, e)
		}
		if e := db.QueryRow(ctx, `SELECT count(*) FROM utility_vault v JOIN utility_objects o ON o.account_id=v.account_id AND o.object_key=v.object_key AND o.state='active' WHERE v.account_id=$1`, a).Scan(&count); e != nil || count != liveVaultObjects {
			t.Fatal("cleanup removed another live document's key", count, e)
		}
		rows, e := db.Query(ctx, `SELECT object_key FROM utility_vault WHERE account_id=$1`, a)
		if e != nil {
			t.Fatal(e)
		}
		for rows.Next() {
			var key string
			if e = rows.Scan(&key); e != nil {
				rows.Close()
				t.Fatal(e)
			}
			if _, e = store.GetFileInfo(ctx, key); e != nil {
				rows.Close()
				t.Fatal("live key bytes were removed", e)
			}
		}
		if e = rows.Err(); e != nil {
			rows.Close()
			t.Fatal(e)
		}
		rows.Close()
		for _, table := range []string{"utility_search_chunks", "utility_changes", "utility_content"} {
			if e := db.QueryRow(ctx, fmt.Sprintf("SELECT count(*) FROM %s WHERE account_id=$1 AND document_id=$2", table), a, doc.ID).Scan(&count); e != nil || count != 0 {
				t.Fatal("dependent data remains", table, e)
			}
		}
	})
}

func domainWorkspace(id uuid.UUID) domain.UtilityWorkspace {
	return domain.UtilityWorkspace{OpenIDs: []uuid.UUID{id}, ActiveID: &id, Version: 0}
}
