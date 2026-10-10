package api

import (
	"context"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func runStorageLegacyCoexistenceIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	ctx := context.Background()
	for _, legacyFirst := range []bool{true, false} {
		name := "legacy recovery restores before the new use"
		if !legacyFirst {
			name = "new use restores without consuming legacy recovery"
		}
		t.Run(name, func(t *testing.T) {
			f := newStorageMultiOriginQAFixture(t, db, store)
			key, asset, messageA := f.media(f.account, "chats", "coexisting-recovery.pdf", true)
			code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "object_keys": []string{key}}, nil)
			if code != 200 {
				t.Fatalf("legacy trash preview=%d %v", code, plan)
			}
			f.confirmUse(plan)
			f.exec(`UPDATE storage_media_trash SET removed_at=NOW()-INTERVAL '8 days',purge_after=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND object_key=$2`, f.account, key)
			legacySnapshot := func() (string, string) {
				t.Helper()
				var id, snapshot string
				if err := db.QueryRow(ctx, `SELECT id::text,jsonb_build_object('actor_id',actor_id,'message_backups',message_backups,'filename',filename,'removed_at',removed_at,'purge_after',purge_after)::text FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&id, &snapshot); err != nil {
					t.Fatal(err)
				}
				return id, snapshot
			}
			legacyID, before := legacySnapshot()
			code, listing := f.storageQAFixture.request("GET", "/storage/files?status=trash", nil, nil)
			legacyFiles := storageQAItems(t, listing, "files")
			if code != 200 || len(legacyFiles) != 1 || legacyFiles[0]["recovery_id"] != legacyID {
				t.Fatalf("legacy recovery is not selectable in the current UI contract: %d %v", code, listing)
			}
			code, oldPurgePlan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "purge", "recovery_ids": []string{legacyID}}, nil)
			if code != 200 || oldPurgePlan["eligible_count"] != float64(1) {
				t.Fatalf("legacy purge precondition=%d %v", code, oldPurgePlan)
			}
			messageB := uuid.New()
			f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp)
			 SELECT $1,account_id,chat_id,$2,'Keep new message','document',$3,'application/pdf','coexisting-recovery.pdf',$4,$5,NOW() FROM messages WHERE account_id=$6 AND id=$7`, messageB, uuid.NewString(), mediaProxyURLFromObjectKey(key), len(f.objectBytes(key)), asset, f.account, messageA)
			expectNewMessage := func(deleted bool) {
				t.Helper()
				var body, mediaURL string
				var removed bool
				var mediaAsset *uuid.UUID
				if err := db.QueryRow(ctx, `SELECT body,COALESCE(media_deleted,false),COALESCE(media_url,''),media_asset_id FROM messages WHERE account_id=$1 AND id=$2`, f.account, messageB).Scan(&body, &removed, &mediaURL, &mediaAsset); err != nil {
					t.Fatal(err)
				}
				if body != "Keep new message" || removed != deleted {
					t.Fatalf("new message content/state changed: body=%q deleted=%v expected=%v", body, removed, deleted)
				}
				if deleted && (mediaURL != "" || mediaAsset != nil) || !deleted && (mediaURL != mediaProxyURLFromObjectKey(key) || mediaAsset == nil || *mediaAsset != asset) {
					t.Fatal("new message did not preserve its exact media identity")
				}
			}
			second := map[string]string{"X-QA-User": "second"}
			use := storageQAUseOfType(t, f.uses(key, second), "chats")["use_id"].(string)
			code, plan = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "targets": []map[string]any{{"object_key": key, "mode": "uses", "use_ids": []string{use}}}}, second)
			if code != 200 {
				t.Fatalf("new trash preview=%d %v", code, plan)
			}
			code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, second)
			if code != 200 || result["status"] != "completed" {
				t.Fatalf("new trash confirm=%d %v", code, result)
			}
			newID := f.recoveryID(key, use)
			if _, after := legacySnapshot(); before != after {
				t.Fatal("new withdrawal replaced legacy backups, actor or retention")
			}
			f.expectMessage(messageA, true)
			expectNewMessage(true)
			f.exec(`UPDATE storage_removed_references SET retain_until=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND id=$2`, f.account, newID)
			for _, headers := range []map[string]string{nil, second} {
				code, listing = f.storageQAFixture.request("GET", "/storage/files?status=trash", nil, headers)
				if code != 200 {
					t.Fatalf("mixed recovery listing=%d %v", code, listing)
				}
				files := storageQAItems(t, listing, "files")
				expectedID := legacyID
				if headers["X-QA-User"] == "second" {
					expectedID = newID
				}
				if len(files) != 1 || files[0]["recovery_id"] != expectedID {
					t.Fatalf("mixed recovery lost or disclosed another actor's recovery: %v", listing)
				}
				for _, file := range files {
					if file["can_purge"] == true {
						t.Fatalf("mixed recovery advertised an implicit purge: %v", file)
					}
				}
			}
			// Neither a new review nor a previously valid legacy preview may
			// consume the other actor's independent recovery implicitly.
			for _, action := range []string{"restore", "purge"} {
				code, result = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": action, "recovery_ids": []string{legacyID}}, second)
				if code < 400 {
					t.Fatalf("new owner accessed legacy %s: %d %v", action, code, result)
				}
			}
			code, result = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "purge", "recovery_ids": []string{newID}}, second)
			if code != 200 || result["eligible_count"] != float64(0) {
				t.Fatalf("new purge omitted legacy recovery: %d %v", code, result)
			}
			code, result = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "purge", "recovery_ids": []string{legacyID}}, nil)
			if code < 400 {
				t.Fatalf("legacy purge omitted new recovery: %d %v", code, result)
			}
			code, result = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": oldPurgePlan["preview_id"]}, nil)
			if code != 409 {
				t.Fatalf("stale legacy purge consumed a later recovery: %d %v", code, result)
			}
			f.expectObject(key, true)
			restoreNew := func() {
				t.Helper()
				code, plan = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{newID}}, second)
				if code != 200 {
					t.Fatalf("new restore preview=%d %v", code, plan)
				}
				code, result = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, second)
				if code != 200 || result["status"] != "completed" {
					t.Fatalf("new restore confirm=%d %v", code, result)
				}
			}
			if legacyFirst {
				f.recover("restore", legacyID)
				f.expectMessage(messageA, false)
				expectNewMessage(true)
				restoreNew()
			} else {
				restoreNew()
				var state string
				if err := db.QueryRow(ctx, `SELECT state FROM storage_media_trash WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&state); err != nil || state != "trash" {
					t.Fatalf("new restoration consumed legacy state=%s err=%v", state, err)
				}
				f.recover("restore", legacyID)
			}
			f.expectMessage(messageA, false)
			expectNewMessage(false)
			f.expectObject(key, true)
		})
	}
	t.Run("campaign recovery content rejects revoked module despite retained Chats permission", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "uploads", "campaign-recovery.pdf", false)
		f.campaign(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "campaigns")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		contentStatus := func() int {
			t.Helper()
			response, err := f.app.Test(httptest.NewRequest("GET", "/storage/content?object_key="+url.QueryEscape(key), nil), 15000)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			return response.StatusCode
		}
		if status := contentStatus(); status != 200 {
			t.Fatalf("authorized campaign recovery unavailable=%d", status)
		}
		f.permissions(domain.PermSettings, domain.PermChats)
		if status := contentStatus(); status != 404 {
			t.Fatalf("new recovery bypassed revoked Broadcasts via legacy marker=%d", status)
		}
		f.expectObject(key, true)
	})
}
