package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
	"time"

	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func TestStorageUseCursorIsResourceAndActorScoped(t *testing.T) {
	actor := storageUseActor{AccountID: uuid.New(), UserID: uuid.New()}
	key := actor.AccountID.String() + "/chats/video.mp4"
	encoded := storageEncodeUseCursor(actor, key, "ordinary/"+uuid.NewString()+"/chats")
	after, err := storageDecodeUseCursor(encoded, actor, key)
	if err != nil || !strings.HasPrefix(after, "ordinary/") {
		t.Fatal("valid cursor rejected")
	}
	for _, other := range []storageUseActor{{AccountID: uuid.New(), UserID: actor.UserID}, {AccountID: actor.AccountID, UserID: uuid.New()}} {
		if _, err := storageDecodeUseCursor(encoded, other, key); err == nil {
			t.Fatal("cursor crossed authority")
		}
	}
	for _, invalid := range []string{strings.Repeat("A", 4097), "!!!", base64.RawURLEncoding.EncodeToString([]byte(`{"Version":1}`)), base64.RawURLEncoding.EncodeToString(make([]byte, 2049))} {
		if _, err := storageDecodeUseCursor(invalid, actor, key); err == nil {
			t.Fatal("invalid cursor accepted")
		}
	}
	if _, err := storageDecodeUseCursor(encoded, actor, key+"other"); err == nil {
		t.Fatal("cursor crossed object")
	}
}

func TestStorageSelfServiceFastReadsIntegration(t *testing.T) {
	db, store := storageMultiOriginQAServices(t)

	t.Run("inventory reader scopes planner settings and forbids writes", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		var before string
		if err := db.QueryRow(context.Background(), "SHOW jit").Scan(&before); err != nil {
			t.Fatal(err)
		}
		tx, err := f.server.storageInventoryReader(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var jit, readOnly string
		if err = tx.QueryRow(context.Background(), "SELECT current_setting('jit'),current_setting('transaction_read_only')").Scan(&jit, &readOnly); err != nil || jit != "off" || readOnly != "on" {
			t.Fatal("inventory transaction is not bounded read-only")
		}
		_, err = tx.Exec(context.Background(), "INSERT INTO storage_inventory_totals(account_id) VALUES($1)", f.account)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "25006" {
			t.Fatal("inventory transaction admitted a write")
		}
		_ = tx.Rollback(context.Background())
		var after string
		if err = db.QueryRow(context.Background(), "SHOW jit").Scan(&after); err != nil || before != after {
			t.Fatal("inventory changed session planner setting")
		}
	})
	t.Run("percent-heavy unrelated template cannot delay a video or raw reference check", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "clip.mp4", true)
		design, _ := json.Marshal(map[string]any{"version": 3, "objects": []any{map[string]any{"type": "text", "text": strings.Repeat("ancho 50% — español 日本語 ", 4000)}}})
		f.exec(`INSERT INTO document_templates(account_id,name,canvas_json) VALUES($1,'Percent regression',$2::jsonb)`, f.account, design)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		refs, err := storageSelfServiceObjectReferences(ctx, db, f.account, key, store)
		if err != nil || len(refs) != 1 {
			t.Fatalf("scalar reference lookup failed: refs=%d err=%v", len(refs), err)
		}
		code, data := storageReportedRequest(t, f, "HEAD", "/storage/content?object_key="+url.QueryEscape(key), nil, nil)
		if code != 200 || len(data) != 0 {
			t.Fatalf("HEAD status=%d bytes=%d", code, len(data))
		}
		content := f.objectBytes(key)
		for _, tc := range []struct {
			raw  string
			code int
			want []byte
		}{
			{"bytes=0-3", 206, content[:4]}, {"bytes=-4", 206, content[len(content)-4:]},
			{"bytes=4-", 206, content[4:]}, {"bytes=999999-", 416, nil}, {"bytes=4-3", 416, nil},
			{"bytes=abc-3", 416, nil}, {"bytes=0-1,3-4", 416, nil},
		} {
			status, body := storageReportedRequest(t, f, "GET", "/storage/content?object_key="+url.QueryEscape(key), nil, map[string]string{"Range": tc.raw})
			if status != tc.code || (tc.code == 206 && string(body) != string(tc.want)) {
				t.Fatalf("range %q status=%d bytes=%d", tc.raw, status, len(body))
			}
		}
		f.permissions(domain.PermSettings)
		code, _ = storageReportedRequest(t, f, "HEAD", "/storage/content?object_key="+url.QueryEscape(key), nil, nil)
		if code != 404 {
			t.Fatalf("revoked HEAD returned %d", code)
		}
	})
	t.Run("indexed whiteboard summaries and pages revalidate the canonical grant", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		item := storagePrivateQASeedBoard(f)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		check := func(visible, removable bool) {
			t.Helper()
			page := storageInventoryRawGET(t, f.storageQAFixture, "/storage/files")
			found := false
			for _, file := range storageQAItems(t, page, "files") {
				if file["object_key"] == item.key {
					found = true
					if file["can_remove_uses"] != removable {
						t.Fatal("indexed capability ignored current board grant")
					}
				}
			}
			if found != visible {
				t.Fatal("indexed page ignored current board grant")
			}
			usage := storageInventoryRawGET(t, f.storageQAFixture, "/storage/usage")
			bytes, _ := usage["visible_bytes"].(float64)
			if (bytes > 0) != visible {
				t.Fatal("indexed summary ignored current board grant")
			}
		}
		check(true, true)
		f.exec(`UPDATE whiteboard_grants SET access_level='view' WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		check(true, false)
		f.exec(`DELETE FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2 AND user_id=$3`, f.account, item.board, f.user)
		check(false, false)
		f.exec(`INSERT INTO whiteboard_grants(account_id,board_id,user_id,access_level,created_by) VALUES($1,$2,$3,'edit',$4)`, f.account, item.board, f.user, f.secondUser)
		check(true, true)
		f.permissions(domain.PermSettings)
		check(false, false)
		status, data := f.request("GET", "/storage/files", nil, map[string]string{"X-QA-Account": "other"})
		if status != 200 || data["total"] != float64(0) {
			t.Fatal("indexed private page crossed account boundary")
		}
	})
	t.Run("ready shared-object uses page before canonical hydration", func(t *testing.T) {
		f := storagePerformanceSharedFixture(t, db, store, 1000)
		actor := storageUseActor{AccountID: f.account, UserID: f.user, Claims: &service.JWTClaims{AccountID: f.account, UserID: f.user, Permissions: []string{domain.PermChats, domain.PermSettings}}}
		key := f.account.String() + "/chats/" + storagePerformanceFilename(0)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		after := ""
		seen := map[string]bool{}
		for page := 0; page < 3; page++ {
			uses, total, next, err := f.server.storageReadUsesPage(ctx, actor, key, after, 17)
			if err != nil || total != 1000 || len(uses) != 17 || next == "" {
				t.Fatalf("page %d total=%d uses=%d next=%t err=%v", page, total, len(uses), next != "", err)
			}
			for _, use := range uses {
				if seen[use.UseID] || use.SourceID == uuid.Nil || !use.CanRemove {
					t.Fatal("invalid/duplicate canonical use")
				}
				seen[use.UseID] = true
			}
			after = next
		}
		// An unrelated source update invalidates account freshness. Canonical
		// fallback must retain bounded business hydration and complete page data.
		f.exec(`INSERT INTO document_templates(account_id,name,canvas_json) VALUES($1,'Unrelated indexing update','{"objects":[]}'::jsonb)`, f.account)
		freshness, err := f.server.storageInventoryFreshness(ctx, f.account)
		if err != nil || freshness.Complete {
			t.Fatal("fixture did not invalidate inventory freshness")
		}
		dirtyPage, dirtyTotal, dirtyNext, err := f.server.storageReadUsesPage(ctx, actor, key, "", 17)
		if err != nil || dirtyTotal != 1000 || len(dirtyPage) != 17 || dirtyNext == "" {
			t.Fatalf("dirty page total=%d count=%d next=%t error=%v", dirtyTotal, len(dirtyPage), dirtyNext != "", err)
		}
		for _, use := range dirtyPage {
			if use.Fingerprint == "" || use.Href == "" || !use.CanRemove {
				t.Fatal("canonical fallback returned an unhydrated identity")
			}
		}
		actor.Claims.Permissions = []string{domain.PermSettings}
		uses, total, next, err := f.server.storageReadUsesPage(ctx, actor, key, "", 17)
		if err != nil || len(uses) != 0 || total != 0 || next != "" {
			t.Fatal("revoked module still exposed indexed uses")
		}
	})
}
