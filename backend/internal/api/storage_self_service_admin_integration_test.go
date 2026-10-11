package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/storage"
)

type storageAdminQAResult struct {
	freed int64
	err   error
}

func storageAdminQAAsync(f *storageMultiOriginQAFixture, item adminStorageOrphanItem, minAgeDays int) <-chan storageAdminQAResult {
	f.t.Helper()
	done := make(chan storageAdminQAResult, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		freed, err := f.server.storageAdminRemoveOrphan(ctx, f.user, item, minAgeDays)
		done <- storageAdminQAResult{freed: freed, err: err}
	}()
	return done
}

func storageAdminQAAwait(t *testing.T, done <-chan storageAdminQAResult) storageAdminQAResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-time.After(20 * time.Second):
		t.Fatal("administrative deletion did not finish")
		return storageAdminQAResult{}
	}
}

func storageAdminQAObject(f *storageMultiOriginQAFixture, account uuid.UUID) adminStorageOrphanItem {
	f.t.Helper()
	key := account.String() + "/admin-orphan-qa/" + uuid.NewString() + ".pdf"
	if _, err := f.store.UploadObject(context.Background(), key, []byte("Synthetic administrative orphan "+uuid.NewString()), "application/pdf"); err != nil {
		f.t.Fatal(err)
	}
	info, err := f.store.GetFileInfo(context.Background(), key)
	if err != nil {
		f.t.Fatal(err)
	}
	return adminStorageOrphanItem{ObjectKey: key, AccountID: account.String(), SizeBytes: info.Size, LastModified: info.LastModified}
}

// MinIO timestamps are real wall-clock data. Seed only the durable state left
// after a prior, validated administrative decision to exercise its retry path;
// this does not claim that a freshly uploaded object meets the seven-day rule.
func storageAdminQASeedPending(f *storageMultiOriginQAFixture) adminStorageOrphanItem {
	f.t.Helper()
	key, _, _ := f.media(f.account, "admin-orphan-qa", "pending.pdf", false)
	info, err := f.store.GetFileInfo(context.Background(), key)
	if err != nil {
		f.t.Fatal(err)
	}
	f.exec(`UPDATE media_assets SET status='deleting' WHERE account_id=$1 AND object_key=$2`, f.account, key)
	f.exec(`INSERT INTO storage_admin_delete_intents(account_id,object_key,actor_id,size_bytes,state)
		VALUES($1,$2,$3,$4,'purging')`, f.account, key, f.user, info.Size)
	return adminStorageOrphanItem{ObjectKey: key, AccountID: f.account.String(), SizeBytes: info.Size, LastModified: info.LastModified}
}

func storageAdminQAExpectNoIntent(f *storageMultiOriginQAFixture, key string) {
	f.t.Helper()
	var count int
	if err := f.db.QueryRow(context.Background(), `SELECT COUNT(*) FROM storage_admin_delete_intents WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	if count != 0 {
		f.t.Fatalf("rejected candidate left %d irreversible intents", count)
	}
	f.expectObject(key, true)
}

func storageAdminQAExpectFinalized(f *storageMultiOriginQAFixture, item adminStorageOrphanItem) {
	f.t.Helper()
	var intent, media, inventory string
	if err := f.db.QueryRow(context.Background(), `SELECT intent.state,asset.status,object.status
		FROM storage_admin_delete_intents intent
		JOIN media_assets asset ON asset.account_id=intent.account_id AND asset.object_key=intent.object_key
		JOIN storage_objects object ON object.account_id=intent.account_id AND object.object_key=intent.object_key
		WHERE intent.account_id=$1 AND intent.object_key=$2`, f.account, item.ObjectKey).Scan(&intent, &media, &inventory); err != nil {
		f.t.Fatal(err)
	}
	if intent != "purged" || media != "deleted" || inventory != "deleted" {
		f.t.Fatalf("incomplete administrative finalization: intent=%s media=%s inventory=%s", intent, media, inventory)
	}
	f.expectObject(item.ObjectKey, false)
}

func runStorageAdminIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	ctx := context.Background()
	t.Run("administrator preserves recent objects without creating an intent", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storageAdminQAObject(f, f.account)
		freed, err := f.server.storageAdminRemoveOrphan(ctx, f.user, item, 7)
		if err == nil || freed != 0 {
			t.Fatalf("recent MinIO object was accepted: freed=%d err=%v", freed, err)
		}
		storageAdminQAExpectNoIntent(f, item.ObjectKey)
	})
	t.Run("administrator preserves both recovery ledgers upload claims and active inventory", func(t *testing.T) {
		for _, kind := range []string{"legacy_trash", "removed_use", "own_upload", "active_media"} {
			t.Run(kind, func(t *testing.T) {
				f := newStorageMultiOriginQAFixture(t, db, store)
				item := storageAdminQAObject(f, f.account)
				var inspect string
				switch kind {
				case "legacy_trash":
					f.exec(`INSERT INTO storage_media_trash(account_id,object_key,actor_id,filename,media_type,size_bytes,message_backups,purge_after)
						VALUES($1,$2,$3,'retained.pdf','document',$4,'[]'::jsonb,NOW()+INTERVAL '7 days')`, f.account, item.ObjectKey, f.user, item.SizeBytes)
					inspect = `SELECT to_jsonb(entry)::text FROM storage_media_trash entry WHERE account_id=$1 AND object_key=$2`
				case "removed_use":
					f.exec(`INSERT INTO storage_removed_references(account_id,actor_id,operation_id,object_key,use_id,adapter,origin_type,filename,media_type,size_bytes,snapshot)
						VALUES($1,$2,$3,$4,'retained-use','chats','chats','retained.pdf','document',$5,'{}'::jsonb)`, f.account, f.user, uuid.New(), item.ObjectKey, item.SizeBytes)
					inspect = `SELECT to_jsonb(entry)::text FROM storage_removed_references entry WHERE account_id=$1 AND object_key=$2`
				case "own_upload":
					f.exec(`INSERT INTO storage_upload_ownership(account_id,object_key,actor_id,provenance_verified,state)
						VALUES($1,$2,$3,TRUE,'active')`, f.account, item.ObjectKey, f.user)
					inspect = `SELECT to_jsonb(entry)::text FROM storage_upload_ownership entry WHERE account_id=$1 AND object_key=$2`
				case "active_media":
					f.exec(`INSERT INTO media_assets(account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status)
						VALUES($1,$2,$3,'document','application/pdf','retained.pdf',$4,'active')`, f.account, uuid.NewString(), item.ObjectKey, item.SizeBytes)
					inspect = `SELECT to_jsonb(entry)::text FROM media_assets entry WHERE account_id=$1 AND object_key=$2`
				}
				var before, after string
				if err := db.QueryRow(ctx, inspect, f.account, item.ObjectKey).Scan(&before); err != nil {
					t.Fatal(err)
				}
				// The direct helper's zero-age parameter isolates this protection from
				// MinIO's fresh timestamp. The public endpoint still requires >=7.
				freed, err := f.server.storageAdminRemoveOrphan(ctx, f.user, item, 0)
				if err == nil || freed != 0 {
					t.Fatalf("retained %s was accepted: freed=%d err=%v", kind, freed, err)
				}
				if err := db.QueryRow(ctx, inspect, f.account, item.ObjectKey).Scan(&after); err != nil {
					t.Fatal(err)
				}
				if before != after {
					t.Fatalf("administrative rejection mutated %s", kind)
				}
				storageAdminQAExpectNoIntent(f, item.ObjectKey)
			})
		}
	})
	t.Run("simultaneous administrative retries delete and account bytes once", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storageAdminQASeedPending(f)
		pending, err := f.server.storageAdminPendingOrphans(ctx)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, candidate := range pending {
			if candidate.AccountID == f.account.String() && candidate.ObjectKey == item.ObjectKey {
				found = true
			}
		}
		if !found {
			t.Fatal("pending deletion was hidden by the fresh object timestamp")
		}
		entered, release := make(chan struct{}), make(chan struct{})
		var enteredOnce, releaseOnce sync.Once
		var deletes atomic.Int32
		_, delayed := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			original := proxy.Director
			proxy.Director = func(request *http.Request) {
				if request.Method == http.MethodDelete && strings.HasSuffix(request.URL.Path, "/"+item.ObjectKey) {
					deletes.Add(1)
					enteredOnce.Do(func() { close(entered) })
					select {
					case <-release:
					case <-request.Context().Done():
					}
				}
				original(request)
			}
		})
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		defer unblock()
		f.server.storage = delayed
		first := storageAdminQAAsync(f, item, 7)
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("administrative retry did not reach real S3 DELETE")
		}
		second := storageAdminQAAsync(f, item, 7)
		storageQAWaitForLock(t, db, 1, `SELECT COUNT(*) FROM pg_stat_activity
			WHERE datname=current_database() AND wait_event_type='Lock'
			AND query LIKE 'SELECT state FROM storage_admin_delete_intents%'`)
		unblock()
		a, b := storageAdminQAAwait(t, first), storageAdminQAAwait(t, second)
		if a.err != nil || b.err != nil || a.freed+b.freed != item.SizeBytes || deletes.Load() != 1 {
			t.Fatalf("concurrent retries duplicated/lost physical accounting: first=%+v second=%+v size=%d deletes=%d", a, b, item.SizeBytes, deletes.Load())
		}
		storageAdminQAExpectFinalized(f, item)
		freed, err := f.server.storageAdminRemoveOrphan(ctx, f.user, item, 7)
		if err != nil || freed != 0 || deletes.Load() != 1 {
			t.Fatalf("terminal replay performed deletion twice: freed=%d err=%v deletes=%d", freed, err, deletes.Load())
		}
	})
	t.Run("lost administrative delete acknowledgement preserves retry intent and honest accounting", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storageAdminQASeedPending(f)
		var applied atomic.Bool
		_, faulty := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			proxy.ModifyResponse = func(response *http.Response) error {
				if response.Request.Method != http.MethodDelete || !strings.HasSuffix(response.Request.URL.Path, "/"+item.ObjectKey) {
					return nil
				}
				if response.StatusCode != http.StatusNoContent {
					return fmt.Errorf("MinIO did not apply the synthetic ambiguous delete: %d", response.StatusCode)
				}
				applied.Store(true)
				response.Body.Close()
				body := `<Error><Code>AccessDenied</Code><Message>Synthetic lost administrative delete acknowledgement</Message></Error>`
				response.StatusCode, response.Status = http.StatusForbidden, "403 Forbidden"
				response.Body = io.NopCloser(strings.NewReader(body))
				response.ContentLength = int64(len(body))
				response.Header.Set("Content-Type", "application/xml")
				response.Header.Set("Content-Length", fmt.Sprint(len(body)))
				return nil
			}
		})
		f.server.storage = faulty
		freed, err := f.server.storageAdminRemoveOrphan(ctx, f.user, item, 7)
		if !applied.Load() || err == nil || freed != 0 {
			t.Fatalf("ambiguous DELETE fabricated completion: applied=%v freed=%d err=%v", applied.Load(), freed, err)
		}
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_admin_delete_intents WHERE account_id=$1 AND object_key=$2`, f.account, item.ObjectKey).Scan(&state); err != nil || state != "purging" {
			t.Fatalf("ambiguous DELETE lost durable intent: state=%s err=%v", state, err)
		}
		f.expectObject(item.ObjectKey, false)
		f.server.storage = store
		freed, err = f.server.storageAdminRemoveOrphan(ctx, f.user, item, 7)
		if err != nil || freed != 0 {
			t.Fatalf("retry invented reclaimed bytes for an already absent object: freed=%d err=%v", freed, err)
		}
		storageAdminQAExpectFinalized(f, item)
	})
	t.Run("reference committed before administrator proof preserves the candidate", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storageAdminQAObject(f, f.account)
		writer, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer writer.Rollback(context.Background())
		var pid int32
		if err = writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err = writer.Exec(ctx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url)
			VALUES($1,$2,'New live use','Preserve this reference',$3)`, f.account, uuid.NewString(), mediaProxyURLFromObjectKey(item.ObjectKey)); err != nil {
			t.Fatal(err)
		}
		// Zero age isolates the live-reference proof after the writer commits.
		done := storageAdminQAAsync(f, item, 0)
		storageQAWaitForLock(t, db, 1, `SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database()
			AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock(%'`, pid)
		if err = writer.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		result := storageAdminQAAwait(t, done)
		if result.err == nil || result.freed != 0 {
			t.Fatalf("administrator deleted the newly referenced object: %+v", result)
		}
		storageAdminQAExpectNoIntent(f, item.ObjectKey)
	})
	t.Run("administrative intent blocks late references while another account keeps writing", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storageAdminQASeedPending(f)
		other := storageAdminQAObject(f, f.other)
		entered, release := make(chan struct{}), make(chan struct{})
		var enteredOnce, releaseOnce sync.Once
		_, delayed := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			original := proxy.Director
			proxy.Director = func(request *http.Request) {
				if request.Method == http.MethodDelete && strings.HasSuffix(request.URL.Path, "/"+item.ObjectKey) {
					enteredOnce.Do(func() { close(entered) })
					select {
					case <-release:
					case <-request.Context().Done():
					}
				}
				original(request)
			}
		})
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		defer unblock()
		f.server.storage = delayed
		done := storageAdminQAAsync(f, item, 7)
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("administrative retry did not reach S3")
		}
		writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, err := db.Exec(writeCtx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url)
			VALUES($1,$2,'Late use','Must be rejected',$3)`, f.account, uuid.NewString(), mediaProxyURLFromObjectKey(item.ObjectKey))
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
			t.Fatalf("late reference bypassed intent or waited for object storage: %v", err)
		}
		if _, err = db.Exec(writeCtx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url)
			VALUES($1,$2,'Independent account','Must remain writable',$3)`, f.other, uuid.NewString(), mediaProxyURLFromObjectKey(other.ObjectKey)); err != nil {
			t.Fatalf("account A deletion blocked account B: %v", err)
		}
		unblock()
		result := storageAdminQAAwait(t, done)
		if result.err != nil || result.freed != item.SizeBytes {
			t.Fatalf("safe pending deletion failed: %+v", result)
		}
		storageAdminQAExpectFinalized(f, item)
		f.expectObject(other.ObjectKey, true)
	})
}
