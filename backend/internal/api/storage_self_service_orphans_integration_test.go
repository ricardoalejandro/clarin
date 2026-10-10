package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func (f *storageMultiOriginQAFixture) recordOwnUpload(key string, assetID, actorID uuid.UUID, created bool) {
	f.t.Helper()
	asset := &domain.MediaAsset{ID: assetID, AccountID: f.account, ObjectKey: key}
	if err := f.server.recordStorageUpload(context.Background(), f.account, actorID, asset, created); err != nil {
		f.t.Fatal(err)
	}
}

func (f *storageMultiOriginQAFixture) ageOwnUpload(key string) {
	f.exec(`UPDATE storage_upload_ownership SET first_uploaded_at=NOW()-INTERVAL '2 days',last_uploaded_at=NOW()-INTERVAL '2 days' WHERE account_id=$1 AND object_key=$2`, f.account, key)
}

func TestStorageSelfServiceOrphansIntegration(t *testing.T) {
	db, store := storageMultiOriginQAServices(t)
	ctx := context.Background()
	t.Run("administrative cleanup respects account barriers and user recovery", func(t *testing.T) {
		runStorageAdminIntegrationChecks(t, db, store)
	})
	t.Run("multipart upload registers canonical actor provenance and real bytes", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		f.app.Post("/media/upload", f.server.handleDirectUpload)
		payload := []byte("%PDF-1.4\n% synthetic isolated upload " + uuid.NewString() + "\n%%EOF")
		upload := func(actor, filename string) map[string]any {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			header := make(textproto.MIMEHeader)
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, filename))
			header.Set("Content-Type", "application/pdf")
			part, err := writer.CreatePart(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = part.Write(payload); err != nil {
				t.Fatal(err)
			}
			if err = writer.Close(); err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest("POST", "/media/upload", &body)
			req.Header.Set("Content-Type", writer.FormDataContentType())
			req.Header.Set("X-QA-User", actor)
			res, err := f.app.Test(req, 15000)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var result map[string]any
			if err = json.NewDecoder(res.Body).Decode(&result); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != 200 || result["success"] != true {
				t.Fatalf("multipart upload failed status=%d code=%v", res.StatusCode, result["code"])
			}
			return result
		}
		first, second := upload("", "private-first-name.pdf"), upload("second", "second-actor-name.pdf")
		if first["deduped"] != false || second["deduped"] != true || first["media_asset_id"] != second["media_asset_id"] || second["filename"] != "second-actor-name.pdf" {
			t.Fatalf("canonical upload or name isolation failed: first_asset=%v second_asset=%v first_dedup=%v second_dedup=%v second_filename=%v", first["media_asset_id"], second["media_asset_id"], first["deduped"], second["deduped"], second["filename"])
		}
		var key string
		var owners int
		if err := db.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2`, f.account, first["media_asset_id"]).Scan(&key); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=ANY($3::uuid[]) AND provenance_verified AND state='active'`, f.account, key, []uuid.UUID{f.user, f.secondUser}).Scan(&owners); err != nil {
			t.Fatal(err)
		}
		if owners != 2 || !bytes.Equal(payload, f.objectBytes(key)) {
			t.Fatalf("upload did not durably register both actors without altering bytes: owners=%d", owners)
		}
		var ownFilename string
		if err := db.QueryRow(ctx, `SELECT filename FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, key, f.secondUser).Scan(&ownFilename); err != nil {
			t.Fatal(err)
		}
		if ownFilename != "second-actor-name.pdf" {
			t.Fatalf("deduplicated ownership borrowed another actor's filename: %q", ownFilename)
		}
		if err := f.server.ReconcileStorageInventory(ctx, f.account); err != nil {
			t.Fatal(err)
		}
		code, listing := f.request("GET", "/storage/files?limit=40", nil, map[string]string{"X-QA-User": "second"})
		if code != 200 {
			t.Fatalf("second actor inventory status=%d", code)
		}
		files := storageQAItems(t, listing, "files")
		if len(files) != 1 || files[0]["filename"] != "second-actor-name.pdf" {
			t.Fatal("deduplicated inventory did not preserve actor-specific upload filename")
		}
	})
	t.Run("only verified aged own uploads are removable", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "own.pdf", false)
		f.recordOwnUpload(key, asset, f.user, true)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")
		if use["can_remove"] != false || use["blocked_reason"] == "" {
			t.Fatalf("recent upload was removable: %v", use)
		}
		f.ageOwnUpload(key)
		use = storageQAUseOfType(t, f.uses(key, nil), "own_uploads")
		if use["can_remove"] != true {
			t.Fatalf("aged verified upload remained blocked: %v", use)
		}
		for _, headers := range []map[string]string{{"X-QA-User": "second"}, {"X-QA-Account": "other"}} {
			code, data := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(key), nil, headers)
			if code != 404 {
				t.Fatalf("another actor/account learned about private upload: status=%d data=%v", code, data)
			}
		}
		unknown, unknownAsset, _ := f.media(f.account, "uploads", "legacy-unknown.pdf", false)
		f.recordOwnUpload(unknown, unknownAsset, f.user, false)
		f.ageOwnUpload(unknown)
		code, data := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(unknown), nil, nil)
		if code != 404 {
			t.Fatalf("dedup inferred old object provenance: status=%d data=%v", code, data)
		}
		original := f.objectBytes(key)
		f.confirmUse(f.previewUses(key, use["use_id"].(string)))
		id := f.recoveryID(key, use["use_id"].(string))
		var retained bool
		if err := db.QueryRow(ctx, `SELECT retain_until>=removed_at+INTERVAL '7 days' FROM storage_removed_references WHERE id=$1`, id).Scan(&retained); err != nil {
			t.Fatal(err)
		}
		if !retained || !bytes.Equal(original, f.objectBytes(key)) {
			t.Fatal("trash did not retain exact bytes for at least seven days")
		}
		f.recover("restore", id)
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, key, f.user).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "active" || !bytes.Equal(original, f.objectBytes(key)) {
			t.Fatal("own upload restoration did not recover provenance and bytes")
		}
	})
	t.Run("last own upload can be purged only after retention and cannot return", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "purge-own.pdf", false)
		f.recordOwnUpload(key, asset, f.user, true)
		f.ageOwnUpload(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		id := f.recoveryID(key, use)
		code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "purge", "recovery_ids": []string{id}}, nil)
		if code == 200 && plan["eligible_count"] != float64(0) {
			t.Fatalf("fresh recovery admitted purge: %v", plan)
		}
		f.expectObject(key, true)
		f.exec(`UPDATE storage_removed_references SET removed_at=NOW()-INTERVAL '9 days',retain_until=NOW()-INTERVAL '1 day' WHERE id=$1`, id)
		f.exec(`UPDATE storage_media_trash SET removed_at=NOW()-INTERVAL '9 days',purge_after=NOW()-INTERVAL '1 day' WHERE account_id=$1 AND object_key=$2`, f.account, key)
		f.recover("purge", id)
		f.expectObject(key, false)
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_removed_references WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "purged" {
			t.Fatalf("physical absence was not reconciled in recovery: %s", state)
		}
		code, plan = f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{id}}, nil)
		if code == 200 && plan["eligible_count"] != float64(0) {
			t.Fatalf("purged bytes could be restored: %v", plan)
		}
	})
	t.Run("reattaching after preview atomically retires orphan eligibility", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "attached.pdf", false)
		f.recordOwnUpload(key, asset, f.user, true)
		f.ageOwnUpload(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")["use_id"].(string)
		plan := f.previewUses(key, use)
		_, attachment := f.quickReply(key, asset)
		var state string
		if err := db.QueryRow(ctx, `SELECT state FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, key, f.user).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "attached" {
			t.Fatalf("business write did not promote ownership claim: %s", state)
		}
		code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code < 400 && result["status"] == "completed" {
			t.Fatalf("stale orphan preview succeeded: %v", result)
		}
		var exists bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM quick_reply_attachments WHERE id=$1 AND account_id=$2)`, attachment, f.account).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatal("orphan removal damaged new attachment")
		}
		f.expectObject(key, true)
	})
	t.Run("reupload invalidates age and prepared ownership version", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "reuploaded.pdf", false)
		f.recordOwnUpload(key, asset, f.user, true)
		f.ageOwnUpload(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")["use_id"].(string)
		plan := f.previewUses(key, use)
		f.recordOwnUpload(key, asset, f.user, false)
		code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code < 400 && result["status"] == "completed" {
			t.Fatalf("old review removed a new upload session: %v", result)
		}
		var version int
		var state string
		var recent bool
		if err := db.QueryRow(ctx, `SELECT version,state,last_uploaded_at>NOW()-INTERVAL '1 minute' FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, key, f.user).Scan(&version, &state, &recent); err != nil {
			t.Fatal(err)
		}
		if version != 2 || state != "active" || !recent {
			t.Fatalf("reupload provenance lost: version=%d state=%s recent=%v", version, state, recent)
		}
		f.expectObject(key, true)
	})
	t.Run("another actor claim prevents physical orphan deletion", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "shared-upload.pdf", false)
		f.recordOwnUpload(key, asset, f.user, true)
		f.recordOwnUpload(key, asset, f.secondUser, false)
		f.ageOwnUpload(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")["use_id"].(string)
		result := f.confirmUse(f.previewUses(key, use))
		if result["freed_bytes"] != float64(0) {
			t.Fatalf("shared upload freed bytes: %v", result)
		}
		var state string
		var verified bool
		if err := db.QueryRow(ctx, `SELECT state,provenance_verified FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND actor_id=$3`, f.account, key, f.secondUser).Scan(&state, &verified); err != nil {
			t.Fatal(err)
		}
		if state != "active" || !verified {
			t.Fatalf("other actor claim was damaged: %s verified=%v", state, verified)
		}
		f.expectObject(key, true)
		own := f.recoveryID(key, use)
		f.exec(`UPDATE storage_removed_references SET removed_at=NOW()-INTERVAL '9 days',retain_until=NOW()-INTERVAL '1 day' WHERE id=$1`, own)
		code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "purge", "recovery_ids": []string{own}}, nil)
		if code == 200 && plan["eligible_count"] != float64(0) {
			t.Fatalf("another private claim failed to block physical purge: %v", plan)
		}
		f.expectObject(key, true)
	})
	t.Run("removed upload cannot be restored as an orphan after a business attachment", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "uploads", "claimed-after-removal.pdf", false)
		// A second actor keeps the physical object live while the first removes
		// their own claim; ordinary attachment is therefore still allowed.
		f.recordOwnUpload(key, asset, f.user, true)
		f.recordOwnUpload(key, asset, f.secondUser, false)
		f.ageOwnUpload(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "own_uploads")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		id := f.recoveryID(key, use)
		reply, attachment := f.quickReply(key, asset)
		original := f.objectBytes(key)
		code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{id}}, nil)
		if code == 200 && plan["eligible_count"] != float64(0) {
			code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
			if code != 409 {
				t.Fatalf("attached upload restoration did not return conflict: status=%d response=%v", code, result)
			}
		} else if code != 409 && code != 200 {
			t.Fatalf("unexpected restore preview status=%d response=%v", code, plan)
		}
		var claimState, recoveryState, body, mediaURL string
		if err := db.QueryRow(ctx, `SELECT o.state,r.state,q.body,a.media_url FROM storage_upload_ownership o JOIN storage_removed_references r ON r.id=$4 JOIN quick_replies q ON q.id=$5 AND q.account_id=o.account_id JOIN quick_reply_attachments a ON a.id=$6 AND a.quick_reply_id=q.id WHERE o.account_id=$1 AND o.object_key=$2 AND o.actor_id=$3`, f.account, key, f.user, id, reply, attachment).Scan(&claimState, &recoveryState, &body, &mediaURL); err != nil {
			t.Fatal(err)
		}
		if claimState != "removed" || recoveryState != "removed" || body != "Keep reusable text" || mediaURL != mediaProxyURLFromObjectKey(key) || !bytes.Equal(original, f.objectBytes(key)) {
			t.Fatal("restore conflict altered business content, bytes, or private claim")
		}
	})
}
