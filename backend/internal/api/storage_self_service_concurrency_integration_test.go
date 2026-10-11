package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
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

type storageQAResponse struct {
	status int
	data   map[string]any
	err    error
}

// Concurrent requests must not modify fixture roles or call Fatal from a worker.
func storageQAConfirmAsync(f *storageQAFixture, plan map[string]any) <-chan storageQAResponse {
	done := make(chan storageQAResponse, 1)
	payload, err := json.Marshal(map[string]any{"preview_id": plan["preview_id"]})
	if err != nil {
		f.t.Fatal(err)
	}
	go func() {
		req := httptest.NewRequest(http.MethodPost, "/storage/cleanup/confirm", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		res, err := f.app.Test(req, 15000)
		if err != nil {
			done <- storageQAResponse{err: err}
			return
		}
		defer res.Body.Close()
		var data map[string]any
		err = json.NewDecoder(res.Body).Decode(&data)
		done <- storageQAResponse{status: res.StatusCode, data: data, err: err}
	}()
	return done
}

func storageQAAwait(t *testing.T, done <-chan storageQAResponse) storageQAResponse {
	t.Helper()
	select {
	case response := <-done:
		if response.err != nil {
			t.Fatal(response.err)
		}
		return response
	case <-time.After(20 * time.Second):
		t.Fatal("concurrent storage request did not finish")
		return storageQAResponse{}
	}
}

// Observe real PostgreSQL waits rather than assuming a goroutine reached a lock
// after sleeping. The budget stays below confirmation's three-second lock limit.
func storageQAWaitForLock(t *testing.T, db *pgxpool.Pool, count int, query string, args ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		var waiting int
		if err := db.QueryRow(ctx, query, args...).Scan(&waiting); err != nil {
			t.Fatalf("could not observe PostgreSQL lock wait: %v", err)
		}
		if waiting >= count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("observed %d/%d expected PostgreSQL lock waits", waiting, count)
		case <-tick.C:
		}
	}
}

func storageQAProxy(t *testing.T, mutate func(*httputil.ReverseProxy)) (*httputil.ReverseProxy, *storage.Storage) {
	t.Helper()
	upstream, err := url.Parse("http://" + os.Getenv("MINIO_ENDPOINT"))
	if err != nil {
		t.Fatal(err)
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	mutate(proxy)
	server := httptest.NewServer(proxy)
	t.Cleanup(server.Close)
	store, err := storage.New(storage.Config{Endpoint: strings.TrimPrefix(server.URL, "http://"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("could not initialize disposable S3 proxy")
	}
	return proxy, store
}

func runStorageConcurrencyIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		t.Skip("real concurrent requests require independent native PostgreSQL sessions")
	}

	t.Run("concurrent confirmations share one trash and purge result", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "concurrent.pdf", true)
		info, err := store.GetFileInfo(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		var deletes atomic.Int32
		_, countedStore := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			original := proxy.Director
			proxy.Director = func(r *http.Request) {
				if r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/"+key) {
					deletes.Add(1)
				}
				original(r)
			}
		})
		f.server.storage = countedStore
		for _, action := range []string{"trash", "purge"} {
			if action == "purge" {
				f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1 AND object_key=$2`, f.account, key)
			}
			plan := f.preview(action, key)
			gate, err := db.Begin(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			defer gate.Rollback(context.Background())
			if _, err := gate.Exec(context.Background(), `SELECT id FROM storage_cleanup_previews WHERE id=$1 FOR UPDATE`, plan["preview_id"]); err != nil {
				t.Fatal(err)
			}
			first, second := storageQAConfirmAsync(f, plan), storageQAConfirmAsync(f, plan)
			storageQAWaitForLock(t, db, 2, `SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT action,items,%'`)
			if err := gate.Commit(context.Background()); err != nil {
				t.Fatal(err)
			}
			for _, done := range []<-chan storageQAResponse{first, second} {
				response := storageQAAwait(t, done)
				wantFreed := float64(0)
				if action == "purge" {
					wantFreed = float64(info.Size)
				}
				if response.status != 200 || response.data["status"] != "completed" || response.data["operation_id"] != plan["preview_id"] || response.data["freed_bytes"] != wantFreed || response.data["files_count"] != float64(1) {
					t.Fatalf("concurrent %s changed canonical operation: %d %v", action, response.status, response.data)
				}
			}
		}
		var ledgers, operations int
		if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&ledgers); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM storage_cleanup_previews WHERE account_id=$1 AND result IS NOT NULL`, f.account).Scan(&operations); err != nil {
			t.Fatal(err)
		}
		if ledgers != 1 || operations != 2 || deletes.Load() != 1 {
			t.Fatalf("duplicate effects: ledgers=%d operations=%d S3 deletes=%d", ledgers, operations, deletes.Load())
		}
		f.expectObject(key, false)
		f.expectMessage(message, true)
	})

	t.Run("reference committed ahead of purge invalidates its review", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "writer-first.pdf", true)
		f.confirm(f.preview("trash", key))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1`, f.account)
		plan := f.preview("purge", key)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		writer, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer writer.Rollback(context.Background())
		var pid int32
		if err := writer.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Exec(ctx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Writer wins','Synthetic',$3)`, f.account, uuid.NewString(), mediaProxyURLFromObjectKey(key)); err != nil {
			t.Fatal(err)
		}
		done := storageQAConfirmAsync(f, plan)
		storageQAWaitForLock(t, db, 1, `SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock(%'`, pid)
		if err := writer.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		response := storageQAAwait(t, done)
		if response.status != 409 || response.data["code"] != "storage_preview_stale" {
			t.Fatalf("new committed reference did not invalidate purge: %d %v", response.status, response.data)
		}
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&state); err != nil || state != "trash" {
			t.Fatalf("failed review changed retention state: %q %v", state, err)
		}
		f.expectObject(key, true)
		f.expectMessage(message, true)
	})

	t.Run("committed purge blocks new reference while another account keeps writing", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "purge-first.pdf", true)
		other, _, _ := f.media(f.other, "chats", "unrelated-account.pdf", true)
		f.confirm(f.preview("trash", key))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1`, f.account)
		plan := f.preview("purge", key)
		entered, release := make(chan struct{}), make(chan struct{})
		var once sync.Once
		_, delayedStore := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			original := proxy.Director
			proxy.Director = func(r *http.Request) {
				if r.Method == http.MethodDelete && strings.HasSuffix(r.URL.Path, "/"+key) {
					once.Do(func() { close(entered) })
					select {
					case <-release:
					case <-r.Context().Done():
					}
				}
				original(r)
			}
		})
		// Release blocked handlers before httptest's cleanup closes its server.
		var releaseOnce sync.Once
		unblock := func() { releaseOnce.Do(func() { close(release) }) }
		defer unblock()
		f.server.storage = delayedStore
		done := storageQAConfirmAsync(f, plan)
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("purge did not reach physical deletion")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&state); err != nil || state != "purging" {
			t.Fatalf("S3 delete began without committed intent: %q %v", state, err)
		}
		_, err := db.Exec(ctx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Late reference','Synthetic',$3)`, f.account, uuid.NewString(), mediaProxyURLFromObjectKey(key))
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
			t.Fatalf("writer bypassed committed purge or blocked on S3: %v", err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO quick_replies(account_id,shortcut,title,body,media_url) VALUES($1,$2,'Independent account','Synthetic',$3)`, f.other, uuid.NewString(), mediaProxyURLFromObjectKey(other)); err != nil {
			t.Fatalf("purge blocked unrelated account: %v", err)
		}
		unblock()
		response := storageQAAwait(t, done)
		if response.status != 200 || response.data["status"] != "completed" {
			t.Fatalf("purge failed after safe concurrent writes: %d %v", response.status, response.data)
		}
		f.expectObject(key, false)
		f.expectObject(other, true)
		f.expectMessage(message, true)
	})

	t.Run("restore retains surviving message without recreating deleted history", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, asset, surviving := f.media(f.account, "chats", "surviving.pdf", true)
		deleted := uuid.New()
		f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_asset_id,media_size,timestamp) SELECT $2,account_id,chat_id,$3,body,message_type,media_url,media_asset_id,media_size,timestamp FROM messages WHERE id=$1`, surviving, deleted, uuid.NewString())
		f.confirm(f.preview("trash", key))
		f.exec(`DELETE FROM messages WHERE account_id=$1 AND id=$2`, f.account, deleted)
		f.confirm(f.preview("restore", key))
		var restoredAsset uuid.UUID
		var restoredURL string
		if err := db.QueryRow(context.Background(), `SELECT media_asset_id,media_url FROM messages WHERE account_id=$1 AND id=$2`, f.account, surviving).Scan(&restoredAsset, &restoredURL); err != nil || restoredAsset != asset || restoredURL != mediaProxyURLFromObjectKey(key) {
			t.Fatalf("surviving reference was not restored exactly: %v", err)
		}
		var count int
		if err := db.QueryRow(context.Background(), `SELECT COUNT(*) FROM messages WHERE account_id=$1 AND id=$2`, f.account, deleted).Scan(&count); err != nil || count != 0 {
			t.Fatalf("restore recreated deleted message: %d %v", count, err)
		}
		f.expectMessage(surviving, false)
		f.expectObject(key, true)
	})

	t.Run("lost successful delete acknowledgement stays durable and retries without invented bytes", func(t *testing.T) {
		f := newStorageQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "lost-ack.pdf", true)
		f.confirm(f.preview("trash", key))
		f.exec(`UPDATE storage_media_trash SET purge_after=NOW()-INTERVAL '1 minute' WHERE account_id=$1`, f.account)
		plan := f.preview("purge", key)
		var applied atomic.Bool
		_, faultyStore := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			proxy.ModifyResponse = func(res *http.Response) error {
				if res.Request.Method != http.MethodDelete || !strings.HasSuffix(res.Request.URL.Path, "/"+key) {
					return nil
				}
				if res.StatusCode != http.StatusNoContent {
					return fmt.Errorf("real S3 delete did not succeed: %d", res.StatusCode)
				}
				applied.Store(true)
				res.Body.Close()
				// Lose the success acknowledgement after MinIO applied the delete.
				// A terminal synthetic transport response keeps client-side retries
				// from hiding the ambiguous result being tested at the durable layer.
				body := `<Error><Code>AccessDenied</Code><Message>Synthetic lost delete acknowledgement</Message></Error>`
				res.StatusCode = http.StatusForbidden
				res.Status = "403 Forbidden"
				res.Body = io.NopCloser(strings.NewReader(body))
				res.ContentLength = int64(len(body))
				res.Header.Set("Content-Type", "application/xml")
				res.Header.Set("Content-Length", fmt.Sprint(len(body)))
				return nil
			}
		})
		f.server.storage = faultyStore
		code, result := f.request(http.MethodPost, "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if !applied.Load() || code != 200 || result["status"] != "failed" || result["freed_bytes"] != float64(0) {
			t.Fatalf("ambiguous deletion invented success: applied=%v status=%d result=%v", applied.Load(), code, result)
		}
		f.expectObject(key, false)
		var state string
		if err := db.QueryRow(context.Background(), `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&state); err != nil || state != "purging" {
			t.Fatalf("ambiguous deletion lost durable intent: %q %v", state, err)
		}
		f.server.storage = store
		resumed := f.confirm(plan)
		if resumed["operation_id"] != plan["preview_id"] || resumed["freed_bytes"] != float64(0) {
			t.Fatalf("retry duplicated operation or invented bytes: %v", resumed)
		}
		f.expectObject(key, false)
		f.expectMessage(message, true)
	})
}
