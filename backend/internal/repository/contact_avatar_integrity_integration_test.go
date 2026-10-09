package repository

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/storage"
)

func avatarIntegrityStorage(t *testing.T, endpoint string) *storage.Storage {
	t.Helper()
	if os.Getenv("CLARIN_RUN_CONTACT_MEDIA_INTEGRATION") != "1" {
		t.Skip("requires disposable PostgreSQL and MinIO")
	}
	if os.Getenv("MINIO_ENDPOINT") != "127.0.0.1:19001" {
		t.Fatal("contact media tests require the isolated MinIO endpoint")
	}
	if endpoint == "" {
		endpoint = os.Getenv("MINIO_ENDPOINT")
	}
	store, err := storage.New(storage.Config{Endpoint: endpoint, AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("isolated storage unavailable")
	}
	return store
}

func avatarIntegrityFixture(t *testing.T) (*pgxpool.Pool, *storage.Storage, integrityProgramFixture, uuid.UUID, []byte) {
	t.Helper()
	store := avatarIntegrityStorage(t, "")
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	other := uuid.New()
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic second identity')`, other, f.account, other.String()+"@test.invalid")
	t.Cleanup(func() {
		// Only this fixture's account prefix is selected, after its Contacts are
		// detached. Never sweep another integration test's storage.
		integrityExec(t, pool, `DELETE FROM contacts WHERE account_id=$1`, f.account)
		objects, err := store.ListPrefix(context.Background(), f.account.String()+"/")
		if err != nil {
			t.Error("list isolated avatar fixture for cleanup")
			return
		}
		for _, object := range objects {
			if err := store.DeleteFile(context.Background(), object.Key); err != nil {
				t.Error("delete isolated avatar fixture")
			}
		}
	})
	img := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			img.SetRGBA(x, y, color.RGBA{90, 170, 120, 255})
		}
	}
	var data bytes.Buffer
	if err := jpeg.Encode(&data, img, &jpeg.Options{Quality: 85}); err != nil {
		t.Fatal(err)
	}
	return pool, store, f, other, data.Bytes()
}

func assertReadableAvatar(t *testing.T, pool *pgxpool.Pool, store *storage.Storage, record *ContactAvatarRecord, data []byte) {
	t.Helper()
	if record == nil || record.ObjectKey == nil || record.MediaAssetID == nil {
		t.Fatal("successful attachment has no readable object")
	}
	var mediaStatus, storageStatus string
	if err := pool.QueryRow(context.Background(), `SELECT ma.status,so.status FROM media_assets ma JOIN storage_objects so
		ON so.account_id=ma.account_id AND so.object_key=ma.object_key WHERE ma.id=$1 AND ma.account_id=$2`, *record.MediaAssetID, record.AccountID).Scan(&mediaStatus, &storageStatus); err != nil {
		t.Fatal(err)
	}
	if mediaStatus != "active" || storageStatus != "active" {
		t.Fatalf("live photo inventory status=%s/%s", mediaStatus, storageStatus)
	}
	body, err := store.GetFile(context.Background(), *record.ObjectKey)
	if err != nil || !bytes.Equal(body, data) {
		t.Fatal("saved avatar bytes were deleted or changed")
	}
}

func TestContactAvatarAttachAfterGCScheduled(t *testing.T) {
	pool, store, f, other, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	saved, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	integrityExec(t, tx, `SELECT id FROM contacts WHERE account_id=$1 AND id=$2 FOR UPDATE`, f.account, other)
	type result struct {
		record *ContactAvatarRecord
		err    error
	}
	done := make(chan result, 1)
	go func() {
		record, err := repo.Save(ctx, store, f.account, other, "manual", data, SaveContactAvatarOptions{})
		done <- result{record, err}
	}()
	waitIntegrityLock(t, pool, "SELECT avatar_media_asset_id,avatar_url")
	if _, err := repo.Remove(ctx, f.account, f.contact); err != nil {
		t.Fatal(err)
	}
	var pending string
	if err := pool.QueryRow(ctx, `SELECT status FROM media_assets WHERE account_id=$1 AND id=$2`, f.account, *saved.MediaAssetID).Scan(&pending); err != nil || pending != "avatar_gc_pending" {
		t.Fatalf("controlled GC precondition=%s: %v", pending, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-done:
		if result.err != nil {
			t.Fatal(result.err)
		}
		assertReadableAvatar(t, pool, store, result.record, data)
		if *result.record.ObjectKey != *saved.ObjectKey {
			t.Fatal("pending content restoration orphaned the original key")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("attachment did not finish")
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 0 {
		t.Fatalf("GC deleted a live restored photo: %d %v", count, err)
	}
}

func TestContactAvatarSharedGCAndDeletedRestoration(t *testing.T) {
	pool, store, f, other, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	a, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := repo.Save(ctx, store, f.account, other, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if *a.MediaAssetID != *b.MediaAssetID {
		t.Fatal("same-account content did not deduplicate")
	}
	if _, err := repo.Remove(ctx, f.account, f.contact); err != nil {
		t.Fatal(err)
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 0 {
		t.Fatal("shared photo was collected")
	}
	assertReadableAvatar(t, pool, store, b, data)
	if _, err := repo.Remove(ctx, f.account, other); err != nil {
		t.Fatal(err)
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 1 {
		t.Fatalf("unreferenced GC=%d: %v", count, err)
	}
	if _, err := store.GetFile(ctx, *a.ObjectKey); err == nil {
		t.Fatal("GC did not delete the detached object")
	}
	restored, err := repo.Save(ctx, store, f.account, other, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	assertReadableAvatar(t, pool, store, restored, data)
	if *restored.MediaAssetID != *a.MediaAssetID || *restored.ObjectKey != *a.ObjectKey {
		t.Fatal("deleted content restoration duplicated inventory")
	}
	var objects int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1`, f.account).Scan(&objects); err != nil || objects != 1 {
		t.Fatalf("restored inventory objects=%d: %v", objects, err)
	}
}

func TestContactAvatarAttachmentWaitsForPhysicalGC(t *testing.T) {
	pool, store, f, other, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	saved, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Remove(ctx, f.account, f.contact); err != nil {
		t.Fatal(err)
	}
	target, _ := url.Parse("http://" + os.Getenv("MINIO_ENDPOINT"))
	proxy := httputil.NewSingleHostReverseProxy(target)
	deleting, release := make(chan struct{}), make(chan struct{})
	var closeOnce sync.Once
	t.Cleanup(func() { closeOnce.Do(func() { close(release) }) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Method == http.MethodDelete && strings.HasSuffix(req.URL.Path, *saved.ObjectKey) {
			close(deleting)
			select {
			case <-release:
			case <-req.Context().Done():
				return
			}
		}
		proxy.ServeHTTP(w, req)
	}))
	defer func() {
		closeOnce.Do(func() { close(release) })
		server.Close()
	}()
	proxiedStore := avatarIntegrityStorage(t, strings.TrimPrefix(server.URL, "http://"))
	gcDone := make(chan error, 1)
	go func() { _, err := repo.DrainGC(ctx, proxiedStore, 25); gcDone <- err }()
	select {
	case <-deleting:
	case <-time.After(10 * time.Second):
		t.Fatal("GC did not reach controlled physical delete")
	}
	type result struct {
		record *ContactAvatarRecord
		err    error
	}
	saveDone := make(chan result, 1)
	go func() {
		record, err := repo.Save(ctx, store, f.account, other, "manual", data, SaveContactAvatarOptions{})
		saveDone <- result{record, err}
	}()
	waitIntegrityLock(t, pool, "SELECT id,object_key,status,filename")
	select {
	case <-saveDone:
		t.Fatal("attachment completed while physical deletion was in flight")
	default:
	}
	closeOnce.Do(func() { close(release) })
	if err := <-gcDone; err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-saveDone:
		if result.err != nil {
			t.Fatal(result.err)
		}
		assertReadableAvatar(t, pool, store, result.record, data)
	case <-time.After(10 * time.Second):
		t.Fatal("attachment did not restore content after GC")
	}
}

func TestContactAvatarFailedAttachmentTracksOrphan(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	rejectAvatarAttachment(t, pool, f.account)
	repo := NewContactAvatarRepository(pool)
	if _, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{}); err == nil {
		t.Fatal("synthetic failed attachment reported success")
	}
	current, err := repo.Get(ctx, f.account, f.contact)
	if err != nil || current.MediaAssetID != nil {
		t.Fatal("failed attachment left a partial Contact photo")
	}
	var mediaStatus, storageStatus, key string
	if err := pool.QueryRow(ctx, `SELECT ma.status,so.status,ma.object_key FROM media_assets ma JOIN storage_objects so
		ON so.account_id=ma.account_id AND so.object_key=ma.object_key WHERE ma.account_id=$1`, f.account).Scan(&mediaStatus, &storageStatus, &key); err != nil {
		t.Fatal("failed upload was not durably inventoried", err)
	}
	if mediaStatus != "avatar_gc_pending" || storageStatus != "avatar_gc_pending" {
		t.Fatal("failed upload was not scheduled for GC")
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 1 {
		t.Fatalf("failed upload cleanup=%d: %v", count, err)
	}
	if _, err := store.GetFile(ctx, key); err == nil {
		t.Fatal("failed upload remained in storage")
	}
}

func rejectAvatarAttachment(t *testing.T, pool *pgxpool.Pool, account uuid.UUID) {
	t.Helper()
	suffix := strings.ReplaceAll(account.String(), "-", "")
	function, trigger := "avatar_failure_"+suffix, "avatar_failure_"+suffix
	integrityExec(t, pool, `CREATE FUNCTION `+pgx.Identifier{function}.Sanitize()+`() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.account_id='`+account.String()+`'::uuid AND NEW.avatar_media_asset_id IS NOT NULL THEN RAISE EXCEPTION 'synthetic attachment failure'; END IF; RETURN NEW; END $$`)
	integrityExec(t, pool, `CREATE TRIGGER `+pgx.Identifier{trigger}.Sanitize()+` BEFORE UPDATE OF avatar_media_asset_id ON contacts FOR EACH ROW EXECUTE FUNCTION `+pgx.Identifier{function}.Sanitize()+`() `)
	t.Cleanup(func() {
		integrityExec(t, pool, `DROP TRIGGER IF EXISTS `+pgx.Identifier{trigger}.Sanitize()+` ON contacts`)
		integrityExec(t, pool, `DROP FUNCTION IF EXISTS `+pgx.Identifier{function}.Sanitize()+`() `)
	})
}

func TestContactAvatarFailedDeletedRestorationTracksOrphan(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	saved, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Remove(ctx, f.account, f.contact); err != nil {
		t.Fatal(err)
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 1 {
		t.Fatalf("deleted restoration precondition GC=%d: %v", count, err)
	}
	rejectAvatarAttachment(t, pool, f.account)
	if _, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{}); err == nil {
		t.Fatal("synthetic failed attachment reported success")
	}
	var mediaStatus, storageStatus, key string
	if err := pool.QueryRow(ctx, `SELECT ma.status,so.status,ma.object_key FROM media_assets ma JOIN storage_objects so
		ON so.account_id=ma.account_id AND so.object_key=ma.object_key WHERE ma.account_id=$1 AND ma.id=$2`, f.account, *saved.MediaAssetID).Scan(&mediaStatus, &storageStatus, &key); err != nil {
		t.Fatal(err)
	}
	if mediaStatus != "avatar_gc_pending" || storageStatus != "avatar_gc_pending" {
		t.Fatalf("rolled-back restoration left uploaded bytes outside GC: %s/%s", mediaStatus, storageStatus)
	}
	if body, err := store.GetFile(ctx, key); err != nil || !bytes.Equal(body, data) {
		t.Fatal("restore failure must have uploaded bytes before the attachment error")
	}
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 1 {
		t.Fatalf("failed restoration cleanup=%d: %v", count, err)
	}
	if _, err := store.GetFile(ctx, key); err == nil {
		t.Fatal("failed restoration remained in storage")
	}
}

func TestContactAvatarDeleteTriggerWaitsForSharedAttachment(t *testing.T) {
	pool, store, f, other, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	saved, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	integrityExec(t, tx, `SELECT id FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`, f.account, *saved.MediaAssetID)
	done := make(chan error, 1)
	go func() {
		_, err := pool.Exec(ctx, `DELETE FROM contacts WHERE account_id=$1 AND id=$2`, f.account, f.contact)
		done <- err
	}()
	waitIntegrityLock(t, pool, "DELETE FROM contacts WHERE account_id=$1 AND id=$2")
	// Simulate the tail of the same transaction used by Save while its asset
	// lock is owned. The DELETE trigger must observe this newly committed ref.
	integrityExec(t, tx, contactAvatarUpdateSQL, f.account, other, *saved.MediaAssetID, "manual", false)
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Contact delete did not finish")
	}
	current, err := repo.Get(ctx, f.account, other)
	if err != nil {
		t.Fatal(err)
	}
	assertReadableAvatar(t, pool, store, current, data)
	if count, err := repo.DrainGC(ctx, store, 25); err != nil || count != 0 {
		t.Fatal("Contact deletion scheduled a newly shared image")
	}
}

func TestContactAvatarBrokenReferencedAssetRestorationBumpsRevision(t *testing.T) {
	pool, store, f, _, data := avatarIntegrityFixture(t)
	ctx := context.Background()
	repo := NewContactAvatarRepository(pool)
	previous, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
	if err != nil {
		t.Fatal(err)
	}
	for _, brokenStatus := range []string{"avatar_gc_pending", "deleted"} {
		// Reproduce the persisted state left by the former attach/GC race:
		// the Contact retains its ID/URL while Get can no longer resolve bytes.
		integrityExec(t, pool, `UPDATE media_assets SET status=$3 WHERE account_id=$1 AND id=$2`, f.account, *previous.MediaAssetID, brokenStatus)
		integrityExec(t, pool, `UPDATE storage_objects SET status=$3 WHERE account_id=$1 AND object_key=$2`, f.account, *previous.ObjectKey, brokenStatus)
		if brokenStatus == "deleted" {
			if err := store.DeleteFile(ctx, *previous.ObjectKey); err != nil {
				t.Fatal(err)
			}
		}
		broken, err := repo.Get(ctx, f.account, f.contact)
		if err != nil || broken.ObjectKey != nil {
			t.Fatal("historical broken-photo precondition missing")
		}
		restored, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		assertReadableAvatar(t, pool, store, restored, data)
		if *restored.MediaAssetID != *previous.MediaAssetID || restored.Revision != previous.Revision+1 || *restored.AvatarURL == *previous.AvatarURL {
			t.Fatalf("%s photo restoration did not invalidate the failed URL", brokenStatus)
		}
		stable, err := repo.Save(ctx, store, f.account, f.contact, "manual", data, SaveContactAvatarOptions{})
		if err != nil || stable.Revision != restored.Revision || *stable.AvatarURL != *restored.AvatarURL {
			t.Fatal("unchanged healthy photo needlessly changed its cache revision")
		}
		previous = stable
	}
}
