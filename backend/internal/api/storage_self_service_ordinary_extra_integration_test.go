package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

func runStorageOrdinaryExtraIntegrationChecks(t *testing.T, db *pgxpool.Pool, store *storage.Storage) {
	ctx := context.Background()
	runStorageLegacyCoexistenceIntegrationChecks(t, db, store)
	t.Run("deleting last shared contact preserves another contacts recoverable photo", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		f.permissions(domain.PermSettings, domain.PermContacts)
		contactA, contactB := uuid.New(), uuid.New()
		f.exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$3,$4,'Contact A'),($2,$3,$5,'Contact B')`, contactA, contactB, f.account, contactA.String()+"@test.invalid", contactB.String()+"@test.invalid")
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
			t.Fatal(err)
		}
		a, err := f.server.repos.ContactAvatar.Save(ctx, store, f.account, contactA, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		b, err := f.server.repos.ContactAvatar.Save(ctx, store, f.account, contactB, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if a.MediaAssetID == nil || b.MediaAssetID == nil || *a.MediaAssetID != *b.MediaAssetID {
			t.Fatal("fixture did not produce one canonical shared photo")
		}
		key, before := *a.ObjectKey, f.objectBytes(*a.ObjectKey)
		use := ""
		for _, candidate := range f.uses(key, nil) {
			if candidate["type"] == "contacts" && candidate["label"] == "Foto de Contact A" {
				use, _ = candidate["use_id"].(string)
			}
		}
		if use == "" {
			t.Fatal("contact A use was not visible")
		}
		f.confirmUse(f.previewUses(key, use))
		f.exec(`DELETE FROM contacts WHERE account_id=$1 AND id=$2`, f.account, contactB)
		var state string
		if err = db.QueryRow(ctx, `SELECT status FROM media_assets WHERE account_id=$1 AND id=$2`, f.account, *a.MediaAssetID).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state != "active" {
			t.Fatalf("last Contact deletion made a recoverable asset unavailable: %s", state)
		}
		if _, err = f.server.repos.ContactAvatar.DrainGC(ctx, store, 25); err != nil {
			t.Fatal(err)
		}
		f.recover("restore", f.recoveryID(key, use))
		restored, err := f.server.repos.ContactAvatar.Get(ctx, f.account, contactA)
		if err != nil {
			t.Fatal(err)
		}
		if restored.MediaAssetID == nil || *restored.MediaAssetID != *a.MediaAssetID || !bytes.Equal(before, f.objectBytes(key)) {
			t.Fatal("contact A recovery lost its original shared photo")
		}
	})
	t.Run("contact avatar recovery survives ordinary GC and advances revision", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		f.permissions(domain.PermSettings, domain.PermContacts)
		contact := uuid.New()
		f.exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Recoverable contact photo')`, contact, f.account, contact.String()+"@test.invalid")
		pic := image.NewRGBA(image.Rect(0, 0, 2, 2))
		pic.Set(0, 0, color.RGBA{R: 190, G: 70, B: 20, A: 255})
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, pic, nil); err != nil {
			t.Fatal(err)
		}
		record, err := f.server.repos.ContactAvatar.Save(ctx, store, f.account, contact, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if record.ObjectKey == nil || record.MediaAssetID == nil {
			t.Fatal("canonical avatar upload missing object identity")
		}
		key, asset, beforeRevision := *record.ObjectKey, *record.MediaAssetID, record.Revision
		before := f.objectBytes(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "contacts")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		var removed bool
		var removedRevision int64
		if err = db.QueryRow(ctx, `SELECT avatar_url IS NULL AND avatar_media_asset_id IS NULL,avatar_revision FROM contacts WHERE account_id=$1 AND id=$2`, f.account, contact).Scan(&removed, &removedRevision); err != nil {
			t.Fatal(err)
		}
		if !removed || removedRevision <= beforeRevision {
			t.Fatal("avatar removal did not change canonical photo revision")
		}
		if err = f.server.repos.ContactAvatar.ScheduleAssetGC(ctx, f.account, asset); err != nil {
			t.Fatal(err)
		}
		if _, err = f.server.repos.ContactAvatar.DrainGC(ctx, store, 25); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, f.objectBytes(key)) {
			t.Fatal("avatar GC removed recoverable bytes")
		}
		f.recover("restore", f.recoveryID(key, use))
		restored, err := f.server.repos.ContactAvatar.Get(ctx, f.account, contact)
		if err != nil {
			t.Fatal(err)
		}
		if restored.MediaAssetID == nil || *restored.MediaAssetID != asset || restored.Revision <= removedRevision || !bytes.Equal(before, f.objectBytes(key)) {
			t.Fatal("avatar recovery lost canonical identity, revision or bytes")
		}
	})
	t.Run("saved sticker recovery recreates only its favorite", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "favorite.webp", true)
		favorite := uuid.New()
		url := mediaProxyURLFromObjectKey(key)
		f.exec(`INSERT INTO saved_stickers(id,account_id,media_url) VALUES($1,$2,$3)`, favorite, f.account, url)
		use := storageQAUseOfType(t, f.uses(key, nil), "stickers")["use_id"].(string)
		before := f.objectBytes(key)
		f.confirmUse(f.previewUses(key, use))
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM saved_stickers WHERE account_id=$1 AND id=$2`, f.account, favorite).Scan(&count); err != nil || count != 0 {
			t.Fatalf("favorite not removed count=%d err=%v", count, err)
		}
		f.expectMessage(message, false)
		f.recover("restore", f.recoveryID(key, use))
		var actual string
		if err := db.QueryRow(ctx, `SELECT media_url FROM saved_stickers WHERE account_id=$1 AND id=$2`, f.account, favorite).Scan(&actual); err != nil || actual != url {
			t.Fatalf("favorite restore failed %v", err)
		}
		if !bytes.Equal(before, f.objectBytes(key)) {
			t.Fatal("favorite removal changed physical bytes")
		}
	})
	t.Run("two quick reply files restore in reverse snapshot order regardless selection order", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		keyA, assetA, _ := f.media(f.account, "chats", "first.pdf", true)
		keyB, assetB, _ := f.media(f.account, "chats", "second.pdf", true)
		reply, attachmentA := f.quickReply(keyA, assetA)
		attachmentB := uuid.New()
		itemB := uuid.New()
		f.exec(`INSERT INTO quick_reply_attachments(id,quick_reply_id,account_id,media_url,media_type,media_filename,caption,position,media_asset_id) VALUES($1,$2,$3,$4,'document','second.pdf','Second caption',1,$5)`, attachmentB, reply, f.account, mediaProxyURLFromObjectKey(keyB), assetB)
		f.exec(`UPDATE quick_replies SET items=items||jsonb_build_array(jsonb_build_object('id',$2::text,'type','media','attachment_id',$3::text)) WHERE id=$1`, reply, itemB, attachmentB)
		var before string
		if err := db.QueryRow(ctx, `SELECT jsonb_build_object('body',body,'items',items,'media_url',media_url,'media_filename',media_filename)::text FROM quick_replies WHERE id=$1`, reply).Scan(&before); err != nil {
			t.Fatal(err)
		}
		useA := storageQAUseOfType(t, f.uses(keyA, nil), "quick_replies")["use_id"].(string)
		useB := storageQAUseOfType(t, f.uses(keyB, nil), "quick_replies")["use_id"].(string)
		code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "targets": []map[string]any{{"object_key": keyA, "mode": "uses", "use_ids": []string{useA}}, {"object_key": keyB, "mode": "uses", "use_ids": []string{useB}}}}, nil)
		if code != 200 {
			t.Fatalf("preview status=%d %v", code, plan)
		}
		f.confirmUse(plan)
		f.recover("restore", f.recoveryID(keyA, useA), f.recoveryID(keyB, useB))
		var after string
		var ids []uuid.UUID
		if err := db.QueryRow(ctx, `SELECT jsonb_build_object('body',body,'items',items,'media_url',media_url,'media_filename',media_filename)::text FROM quick_replies WHERE id=$1`, reply).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT array_agg(id ORDER BY position) FROM quick_reply_attachments WHERE account_id=$1 AND quick_reply_id=$2`, f.account, reply).Scan(&ids); err != nil {
			t.Fatal(err)
		}
		var original, actual any
		_ = json.Unmarshal([]byte(before), &original)
		_ = json.Unmarshal([]byte(after), &actual)
		if mustStorageUseJSON(original) != mustStorageUseJSON(actual) || len(ids) != 2 || ids[0] != attachmentA || ids[1] != attachmentB {
			t.Fatalf("compound recovery did not preserve content and order: %s", after)
		}
	})
	t.Run("campaign edit waiting behind media withdrawal returns reload conflict", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "race-campaign.pdf", true)
		campaign, _ := f.campaign(key)
		f.app.Put("/qa/campaigns/:id", f.server.handleUpdateCampaign)
		gate, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer gate.Rollback(ctx)
		if _, err = gate.Exec(ctx, storageSelfServiceReferenceLock, f.account); err != nil {
			t.Fatal(err)
		}
		var pid int
		if err = gate.QueryRow(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil {
			t.Fatal(err)
		}
		done := make(chan storageQAResponse, 1)
		go func() {
			req := httptest.NewRequest("PUT", "/qa/campaigns/"+campaign.String(), strings.NewReader(`{"name":"A stale edit"}`))
			req.Header.Set("Content-Type", "application/json")
			res, e := f.app.Test(req, 15000)
			if e != nil {
				done <- storageQAResponse{err: e}
				return
			}
			defer res.Body.Close()
			var data map[string]any
			e = json.NewDecoder(res.Body).Decode(&data)
			done <- storageQAResponse{status: res.StatusCode, data: data, err: e}
		}()
		storageQAWaitForLock(t, db, 1, `SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'SELECT pg_advisory_xact_lock_shared(%'`, pid)
		if _, err = gate.Exec(ctx, `UPDATE campaigns SET media_url=NULL,media_type=NULL,updated_at=clock_timestamp() WHERE account_id=$1 AND id=$2`, f.account, campaign); err != nil {
			t.Fatal(err)
		}
		if err = gate.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		response := storageQAAwait(t, done)
		if response.status != 409 || response.data["code"] != "campaign_conflict" {
			t.Fatalf("stale edit response=%d %v", response.status, response.data)
		}
		var name string
		var removed bool
		if err = db.QueryRow(ctx, `SELECT name,media_url IS NULL FROM campaigns WHERE account_id=$1 AND id=$2`, f.account, campaign).Scan(&name, &removed); err != nil {
			t.Fatal(err)
		}
		if name != "Synthetic campaign" || !removed {
			t.Fatal("stale edit overwrote a committed media removal")
		}
	})

	t.Run("completed use operation revalidates revoked origin access", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, _ := f.media(f.account, "chats", "completed-private-name.pdf", true)
		use := storageQAUseOfType(t, f.uses(key, nil), "chats")["use_id"].(string)
		plan := f.previewUses(key, use)
		f.confirmUse(plan)
		f.permissions(domain.PermSettings)
		code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		raw, _ := json.Marshal(result)
		if code != 403 || bytes.Contains(raw, []byte("completed-private-name")) {
			t.Fatalf("completed result leaked after revocation status=%d result=%v", code, result)
		}
	})

	t.Run("avatar GC lost acknowledgement keeps a durable intent and rejects reattachment", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		f.permissions(domain.PermSettings, domain.PermContacts)
		contact := uuid.New()
		f.exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'GC retry photo')`, contact, f.account, contact.String()+"@test.invalid")
		var encoded bytes.Buffer
		if err := jpeg.Encode(&encoded, image.NewRGBA(image.Rect(0, 0, 2, 2)), nil); err != nil {
			t.Fatal(err)
		}
		original, err := f.server.repos.ContactAvatar.Save(ctx, store, f.account, contact, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		key, asset := *original.ObjectKey, *original.MediaAssetID
		if _, err = f.server.repos.ContactAvatar.Remove(ctx, f.account, contact); err != nil {
			t.Fatal(err)
		}
		var applied atomic.Bool
		_, faulty := storageQAProxy(t, func(proxy *httputil.ReverseProxy) {
			proxy.ModifyResponse = func(res *http.Response) error {
				if res.Request.Method != http.MethodDelete || !strings.Contains(res.Request.URL.Path, key) {
					return nil
				}
				if res.StatusCode != http.StatusNoContent {
					return fmt.Errorf("actual MinIO delete failed: %d", res.StatusCode)
				}
				applied.Store(true)
				res.Body.Close()
				body := `<Error><Code>AccessDenied</Code><Message>Synthetic lost avatar delete acknowledgement</Message></Error>`
				res.StatusCode = http.StatusForbidden
				res.Status = "403 Forbidden"
				res.Body = io.NopCloser(strings.NewReader(body))
				res.ContentLength = int64(len(body))
				res.Header.Set("Content-Type", "application/xml")
				res.Header.Set("Content-Length", fmt.Sprint(len(body)))
				return nil
			}
		})
		deleted, err := f.server.repos.ContactAvatar.DrainGC(ctx, faulty, 25)
		if err != nil || deleted != 0 || !applied.Load() {
			t.Fatalf("ambiguous GC result deleted=%d applied=%v err=%v", deleted, applied.Load(), err)
		}
		f.expectObject(key, false)
		var state, inventory string
		if err = db.QueryRow(ctx, `SELECT a.status,o.status FROM media_assets a JOIN storage_objects o ON o.account_id=a.account_id AND o.object_key=a.object_key WHERE a.account_id=$1 AND a.id=$2`, f.account, asset).Scan(&state, &inventory); err != nil {
			t.Fatal(err)
		}
		if state != "avatar_gc_deleting" || inventory != "avatar_gc_deleting" {
			t.Fatalf("lost durable GC intent: %s/%s", state, inventory)
		}
		_, err = db.Exec(ctx, `UPDATE contacts SET avatar_media_asset_id=$3 WHERE account_id=$1 AND id=$2`, f.account, contact, asset)
		var pgerr *pgconn.PgError
		if !errors.As(err, &pgerr) || pgerr.Code != "23514" {
			t.Fatalf("reattachment bypassed avatar tombstone: %v", err)
		}
		if _, err = f.server.repos.ContactAvatar.Save(ctx, store, f.account, contact, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{}); !errors.Is(err, repository.ErrMediaAssetDeletionInProgress) {
			t.Fatalf("same photo resurrected pending deletion: %v", err)
		}
		f.exec(`UPDATE storage_objects SET next_delete_at=NOW() WHERE account_id=$1 AND object_key=$2`, f.account, key)
		if deleted, err = f.server.repos.ContactAvatar.DrainGC(ctx, store, 25); err != nil || deleted != 1 {
			t.Fatalf("avatar retry failed deleted=%d err=%v", deleted, err)
		}
		replacement, err := f.server.repos.ContactAvatar.Save(ctx, store, f.account, contact, "manual", encoded.Bytes(), repository.SaveContactAvatarOptions{})
		if err != nil {
			t.Fatal(err)
		}
		if replacement.ObjectKey == nil || *replacement.ObjectKey == key {
			t.Fatal("deleted avatar reused a retired object key")
		}
		f.expectObject(key, false)
		f.expectObject(*replacement.ObjectKey, true)
	})

}
