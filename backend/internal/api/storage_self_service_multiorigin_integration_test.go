package api

// These are acceptance checks against native PostgreSQL and real MinIO. The
// expected state comes from domain rows and object bytes, not adapter snapshots.
import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

func storageMultiOriginQAServices(t *testing.T) (*pgxpool.Pool, *storage.Storage) {
	t.Helper()
	if os.Getenv("CLARIN_STORAGE_QA_PGLITE") == "1" {
		t.Skip("multi-origin acceptance requires native PostgreSQL")
	}
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_STORAGE_SELF_SERVICE_INTEGRATION", "clarin_storage_multi_qa_")
	if os.Getenv("MINIO_ENDPOINT") != storageQAMinioEndpoint(t) || !strings.HasPrefix(os.Getenv("MINIO_BUCKET"), "clarin-qa") {
		t.Fatal("disposable loopback MinIO and clarin-qa bucket required")
	}
	store, err := storage.New(storage.Config{Endpoint: os.Getenv("MINIO_ENDPOINT"), AccessKey: os.Getenv("MINIO_ACCESS_KEY"), SecretKey: os.Getenv("MINIO_SECRET_KEY"), Bucket: os.Getenv("MINIO_BUCKET"), PublicURL: os.Getenv("MINIO_PUBLIC_URL")})
	if err != nil {
		t.Fatal("disposable QA storage unavailable")
	}
	return db, store
}

type storageMultiOriginQAFixture struct{ *storageQAFixture }

func newStorageMultiOriginQAFixture(t *testing.T, db *pgxpool.Pool, store *storage.Storage) *storageMultiOriginQAFixture {
	t.Helper()
	f := &storageMultiOriginQAFixture{newStorageQAFixture(t, db, store)}
	f.permissions(domain.PermSettings, domain.PermChats, domain.PermBroadcasts, domain.PermQuickRepliesManage, domain.PermTasks, domain.PermWhiteboards)
	f.app.Get("/storage/uses", f.server.handleStorageSelfServiceUses)
	return f
}

func (f *storageMultiOriginQAFixture) permissions(values ...string) {
	f.t.Helper()
	f.exec(`UPDATE roles SET permissions=$2 WHERE id=$1`, f.role, values)
}

// Unlike the older fixture this does not write roles on each request. Tests can
// revoke permission between preview and confirm while JWT claims remain stale.
func (f *storageMultiOriginQAFixture) request(method, path string, body any, headers map[string]string) (int, map[string]any) {
	f.t.Helper()
	var payload []byte
	var err error
	if body != nil {
		payload, err = json.Marshal(body)
		if err != nil {
			f.t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	res, err := f.app.Test(req, 15000)
	if err != nil {
		f.t.Fatal(err)
	}
	defer res.Body.Close()
	var data map[string]any
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &data); err != nil {
		f.t.Fatalf("non-JSON status=%d response=%s", res.StatusCode, raw)
	}
	return res.StatusCode, data
}

func (f *storageMultiOriginQAFixture) uses(key string, headers map[string]string) []map[string]any {
	f.t.Helper()
	code, data := f.request("GET", "/storage/uses?limit=200&object_key="+url.QueryEscape(key), nil, headers)
	if code != 200 {
		f.t.Fatalf("uses status=%d response=%v", code, data)
	}
	return storageQAItems(f.t, data, "uses")
}

func (f *storageMultiOriginQAFixture) previewUses(key string, ids ...string) map[string]any {
	f.t.Helper()
	mode := "uses"
	if len(ids) == 0 {
		mode = "file"
	}
	code, data := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "trash", "targets": []map[string]any{{"object_key": key, "mode": mode, "use_ids": ids}}}, nil)
	if code != 200 || data["preview_id"] == nil {
		f.t.Fatalf("preview status=%d response=%v", code, data)
	}
	return data
}

func (f *storageMultiOriginQAFixture) confirmUse(plan map[string]any) map[string]any {
	f.t.Helper()
	code, data := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
	if code != 200 || data["status"] != "completed" {
		f.t.Fatalf("confirm status=%d response=%v", code, data)
	}
	return data
}

func (f *storageMultiOriginQAFixture) recover(action string, ids ...string) map[string]any {
	f.t.Helper()
	code, data := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": action, "recovery_ids": ids}, nil)
	if code != 200 || data["preview_id"] == nil {
		f.t.Fatalf("%s preview status=%d response=%v", action, code, data)
	}
	return f.confirmUse(data)
}

func (f *storageMultiOriginQAFixture) recoveryID(key, useID string) string {
	f.t.Helper()
	var id string
	if err := f.db.QueryRow(context.Background(), `SELECT id::text FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND use_id=$3 AND state='removed'`, f.account, key, useID).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *storageMultiOriginQAFixture) objectBytes(key string) []byte {
	f.t.Helper()
	data, err := f.store.GetFile(context.Background(), key)
	if err != nil {
		f.t.Fatal(err)
	}
	return data
}

func storageQAUseOfType(t *testing.T, uses []map[string]any, kind string) map[string]any {
	t.Helper()
	for _, use := range uses {
		if use["type"] == kind {
			return use
		}
	}
	t.Fatalf("missing %s use: %v", kind, uses)
	return nil
}

func (f *storageMultiOriginQAFixture) additionalMessage(key string, asset, original uuid.UUID) uuid.UUID {
	f.t.Helper()
	id := uuid.New()
	f.exec(`INSERT INTO messages(id,account_id,chat_id,message_id,body,message_type,media_url,media_mimetype,media_filename,media_size,media_asset_id,timestamp)
	 SELECT $1,account_id,chat_id,$2,body,message_type,media_url,media_mimetype,media_filename,media_size,$3,NOW() FROM messages WHERE id=$4 AND account_id=$5`, id, uuid.NewString(), asset, original, f.account)
	return id
}

func (f *storageMultiOriginQAFixture) campaign(key string) (uuid.UUID, uuid.UUID) {
	f.t.Helper()
	device, campaign, attachment := uuid.New(), uuid.New(), uuid.New()
	f.exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Offline synthetic device')`, device, f.account)
	f.exec(`INSERT INTO campaigns(id,account_id,device_id,name,message_template,status,media_url,media_type) VALUES($1,$2,$3,'Synthetic campaign','Keep campaign text','draft',$4,'document')`, campaign, f.account, device, mediaProxyURLFromObjectKey(key))
	f.exec(`INSERT INTO campaign_attachments(id,campaign_id,media_url,media_type,caption,file_name,position) VALUES($1,$2,$3,'document','Keep campaign caption','campaign.pdf',0)`, attachment, campaign, mediaProxyURLFromObjectKey(key))
	return campaign, attachment
}

func (f *storageMultiOriginQAFixture) quickReply(key string, asset uuid.UUID) (uuid.UUID, uuid.UUID) {
	f.t.Helper()
	reply, attachment := uuid.New(), uuid.New()
	items, _ := json.Marshal([]map[string]any{{"id": uuid.NewString(), "type": "text", "text": "Keep reusable text"}, {"id": uuid.NewString(), "type": "media", "attachment_id": attachment.String()}})
	f.exec(`INSERT INTO quick_replies(id,account_id,shortcut,title,body,media_url,media_type,media_filename,items) VALUES($1,$2,$3,'Synthetic reply','Keep reusable text',$4,'document','reply.pdf',$5)`, reply, f.account, "qa-"+reply.String(), mediaProxyURLFromObjectKey(key), items)
	f.exec(`INSERT INTO quick_reply_attachments(id,quick_reply_id,account_id,media_url,media_type,media_filename,caption,position,media_asset_id) VALUES($1,$2,$3,$4,'document','reply.pdf','Keep reply caption',0,$5)`, attachment, reply, f.account, mediaProxyURLFromObjectKey(key), asset)
	return reply, attachment
}

func TestStorageSelfServiceMultiOriginIntegration(t *testing.T) {
	db, store := storageMultiOriginQAServices(t)
	ctx := context.Background()
	t.Run("contact photos stickers and compound recovery", func(t *testing.T) {
		runStorageOrdinaryExtraIntegrationChecks(t, db, store)
	})
	t.Run("one selected chat use preserves every other origin and exact bytes", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, first := f.media(f.account, "chats", "shared.pdf", true)
		second := f.additionalMessage(key, asset, first)
		campaign, attachment := f.campaign(key)
		reply, replyAttachment := f.quickReply(key, asset)
		original := f.objectBytes(key)
		uses := f.uses(key, nil)
		if len(uses) != 4 {
			t.Fatalf("expected 4 business uses, without counting compatibility mirrors twice: %v", uses)
		}
		selected := storageQAUseOfType(t, uses, "chats")["use_id"].(string)
		plan := f.previewUses(key, selected)
		if plan["estimated_bytes"] != float64(len(original)) || plan["estimated_freed_bytes"] != float64(0) || plan["selected_uses_count"] != float64(1) || plan["retained_uses_visible_count"] != float64(3) {
			t.Fatalf("review confused selected file size with freed space or reference count: %v", plan)
		}
		f.expectMessage(first, false)
		f.expectMessage(second, false)
		result := f.confirmUse(plan)
		if result["freed_bytes"] != float64(0) {
			t.Fatalf("detaching one shared use freed bytes: %v", result)
		}
		var deleted, active int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FILTER(WHERE media_deleted),COUNT(*) FILTER(WHERE NOT COALESCE(media_deleted,false)) FROM messages WHERE id=ANY($1::uuid[])`, []uuid.UUID{first, second}).Scan(&deleted, &active); err != nil {
			t.Fatal(err)
		}
		if deleted != 1 || active != 1 {
			t.Fatalf("selected use affected %d removed/%d active messages", deleted, active)
		}
		var retained int
		if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM campaign_attachments WHERE id=$1 AND campaign_id=$2)+(SELECT COUNT(*) FROM quick_reply_attachments WHERE id=$3 AND quick_reply_id=$4)`, attachment, campaign, replyAttachment, reply).Scan(&retained); err != nil {
			t.Fatal(err)
		}
		if retained != 2 || !bytes.Equal(original, f.objectBytes(key)) {
			t.Fatal("unselected origin or physical bytes changed")
		}
		id := f.recoveryID(key, selected)
		f.confirmUse(plan)
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_removed_references WHERE account_id=$1 AND object_key=$2`, f.account, key).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("replay duplicated recovery: %d", count)
		}
		f.recover("restore", id)
		f.expectMessage(first, false)
		f.expectMessage(second, false)
		if len(f.uses(key, nil)) != 4 || !bytes.Equal(original, f.objectBytes(key)) {
			t.Fatal("restoration did not recover the selected use alone")
		}
	})
	t.Run("quick reply detachment restores ordered items and preserves text", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, message := f.media(f.account, "chats", "reply.pdf", true)
		reply, attachment := f.quickReply(key, asset)
		var before string
		if err := db.QueryRow(ctx, `SELECT jsonb_build_object('body',body,'items',items,'media_url',media_url,'media_type',media_type,'media_filename',media_filename)::text FROM quick_replies WHERE id=$1`, reply).Scan(&before); err != nil {
			t.Fatal(err)
		}
		use := storageQAUseOfType(t, f.uses(key, nil), "quick_replies")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		var body, mediaURL string
		var attachments, mediaItems int
		if err := db.QueryRow(ctx, `SELECT body,COALESCE(media_url,''),(SELECT COUNT(*) FROM quick_reply_attachments WHERE quick_reply_id=$1),(SELECT COUNT(*) FROM jsonb_array_elements(items) item WHERE item->>'type'='media') FROM quick_replies WHERE id=$1`, reply).Scan(&body, &mediaURL, &attachments, &mediaItems); err != nil {
			t.Fatal(err)
		}
		if body != "Keep reusable text" || mediaURL != "" || attachments != 0 || mediaItems != 0 {
			t.Fatalf("broken quick reply: body=%q url=%q attachments=%d media_items=%d", body, mediaURL, attachments, mediaItems)
		}
		f.expectMessage(message, false)
		f.expectObject(key, true)
		f.recover("restore", f.recoveryID(key, use))
		var after, caption string
		if err := db.QueryRow(ctx, `SELECT jsonb_build_object('body',body,'items',items,'media_url',media_url,'media_type',media_type,'media_filename',media_filename)::text FROM quick_replies WHERE id=$1`, reply).Scan(&after); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT caption FROM quick_reply_attachments WHERE id=$1 AND account_id=$2`, attachment, f.account).Scan(&caption); err != nil {
			t.Fatal(err)
		}
		if after != before || caption != "Keep reply caption" {
			t.Fatalf("quick reply restoration lost ordering or compatibility fields: before=%s after=%s", before, after)
		}
	})
	t.Run("account and revoked module cannot consume a prepared selection", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "isolated.pdf", true)
		use := storageQAUseOfType(t, f.uses(key, nil), "chats")["use_id"].(string)
		plan := f.previewUses(key, use)
		code, data := f.request("GET", "/storage/uses?object_key="+url.QueryEscape(key), nil, map[string]string{"X-QA-Account": "other"})
		if code == 200 && len(storageQAItems(t, data, "uses")) != 0 {
			t.Fatalf("foreign account received uses: %v", data)
		}
		code, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, map[string]string{"X-QA-Account": "other"})
		if code < 400 {
			t.Fatalf("foreign account confirmed preview: %v", data)
		}
		f.permissions(domain.PermSettings)
		code, data = f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code < 400 && data["status"] == "completed" {
			t.Fatalf("stale claims authorized revoked Chat removal: %v", data)
		}
		f.expectMessage(message, false)
		f.expectObject(key, true)
		var removed int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_removed_references WHERE account_id=$1`, f.account).Scan(&removed); err != nil {
			t.Fatal(err)
		}
		if removed != 0 {
			t.Fatalf("denied operation left %d recoveries", removed)
		}
	})
	t.Run("campaign draft attachment round trip preserves text and scheduled campaign is protected", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "campaign.pdf", true)
		campaign, attachment := f.campaign(key)
		use := storageQAUseOfType(t, f.uses(key, nil), "campaigns")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		var messageText, mediaURL string
		var attachmentCount int
		if err := db.QueryRow(ctx, `SELECT message_template,COALESCE(media_url,''),(SELECT COUNT(*) FROM campaign_attachments WHERE campaign_id=$1) FROM campaigns WHERE id=$1 AND account_id=$2`, campaign, f.account).Scan(&messageText, &mediaURL, &attachmentCount); err != nil {
			t.Fatal(err)
		}
		if messageText != "Keep campaign text" || mediaURL != "" || attachmentCount != 0 {
			t.Fatalf("draft campaign is inconsistent after detach: text=%q media=%q count=%d", messageText, mediaURL, attachmentCount)
		}
		f.expectMessage(message, false)
		f.expectObject(key, true)
		f.recover("restore", f.recoveryID(key, use))
		var caption string
		var position int
		if err := db.QueryRow(ctx, `SELECT caption,position FROM campaign_attachments WHERE id=$1 AND campaign_id=$2`, attachment, campaign).Scan(&caption, &position); err != nil {
			t.Fatal(err)
		}
		if caption != "Keep campaign caption" || position != 0 {
			t.Fatal("campaign restore lost attachment identity or caption")
		}
		plan := f.previewUses(key, use)
		f.exec(`UPDATE campaigns SET status='scheduled' WHERE account_id=$1 AND id=$2`, f.account, campaign)
		code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
		if code < 400 && result["status"] == "completed" {
			t.Fatalf("campaign started after review but lost its media: %v", result)
		}
		protected := storageQAUseOfType(t, f.uses(key, nil), "campaigns")
		if protected["can_remove"] != false || protected["blocked_reason"] == "" {
			t.Fatalf("scheduled campaign was not visibly protected: %v", protected)
		}
		f.expectObject(key, true)
	})
	t.Run("hidden module protects physical bytes without revealing its label or count", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "hidden-origin.pdf", true)
		campaign, _ := f.campaign(key)
		f.exec(`UPDATE campaigns SET name='Private campaign label must not leak' WHERE account_id=$1 AND id=$2`, f.account, campaign)
		f.permissions(domain.PermSettings, domain.PermChats)
		uses := f.uses(key, nil)
		if len(uses) != 1 || uses[0]["type"] != "chats" {
			t.Fatalf("hidden module exposed its use: %v", uses)
		}
		plan := f.previewUses(key, uses[0]["use_id"].(string))
		raw, _ := json.Marshal(plan)
		if bytes.Contains(raw, []byte("Private campaign")) || plan["retained_elsewhere"] != true || plan["retained_uses_visible_count"] != float64(0) {
			t.Fatalf("hidden retention must be a boolean without metadata: %v", plan)
		}
		f.confirmUse(plan)
		f.expectMessage(message, true)
		f.expectObject(key, true)
		var mediaURL string
		if err := db.QueryRow(ctx, `SELECT media_url FROM campaigns WHERE account_id=$1 AND id=$2`, f.account, campaign).Scan(&mediaURL); err != nil {
			t.Fatal(err)
		}
		if mediaURL != mediaProxyURLFromObjectKey(key) {
			t.Fatal("unreadable module attachment changed")
		}
	})
	t.Run("quick reply restore rejects later edits without losing recovery or new content", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, asset, _ := f.media(f.account, "chats", "edited-reply.pdf", true)
		reply, _ := f.quickReply(key, asset)
		use := storageQAUseOfType(t, f.uses(key, nil), "quick_replies")["use_id"].(string)
		f.confirmUse(f.previewUses(key, use))
		id := f.recoveryID(key, use)
		f.exec(`UPDATE quick_replies SET body='Keep this newer text',items=jsonb_build_array(jsonb_build_object('id',$3::text,'type','text','text','Keep this newer text')),updated_at=NOW() WHERE id=$1 AND account_id=$2`, reply, f.account, uuid.NewString())
		code, plan := f.request("POST", "/storage/cleanup/preview", map[string]any{"action": "restore", "recovery_ids": []string{id}}, nil)
		if code == 200 && plan["eligible_count"] != float64(0) {
			code, result := f.request("POST", "/storage/cleanup/confirm", map[string]any{"preview_id": plan["preview_id"]}, nil)
			if code < 400 && result["status"] == "completed" {
				t.Fatalf("restore overwrote later reply edits: %v", result)
			}
		}
		var body, state string
		var count int
		if err := db.QueryRow(ctx, `SELECT body,(SELECT COUNT(*) FROM quick_reply_attachments WHERE quick_reply_id=$1) FROM quick_replies WHERE id=$1`, reply).Scan(&body, &count); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(ctx, `SELECT state FROM storage_removed_references WHERE id=$1`, id).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if body != "Keep this newer text" || count != 0 || state != "removed" {
			t.Fatalf("failed restore changed state: body=%q count=%d state=%s", body, count, state)
		}
		f.expectObject(key, true)
	})
	t.Run("two previews racing for the same use produce one recovery", func(t *testing.T) {
		f := newStorageMultiOriginQAFixture(t, db, store)
		key, _, message := f.media(f.account, "chats", "race.pdf", true)
		use := storageQAUseOfType(t, f.uses(key, nil), "chats")["use_id"].(string)
		first, second := f.previewUses(key, use), f.previewUses(key, use)
		tx, err := db.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:' || $1::text,0))`, f.account); err != nil {
			t.Fatal(err)
		}
		a, b := storageQAConfirmAsync(f.storageQAFixture, first), storageQAConfirmAsync(f.storageQAFixture, second)
		storageQAWaitForLock(t, db, 2, `SELECT COUNT(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%storage-self-service:%'`)
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		responses := []storageQAResponse{storageQAAwait(t, a), storageQAAwait(t, b)}
		completed := 0
		for _, response := range responses {
			if response.status == 200 && response.data["status"] == "completed" {
				completed++
			}
		}
		if completed != 1 {
			t.Fatalf("expected exactly one successful stale-preview race: %+v", responses)
		}
		var removed int
		if err = db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_removed_references WHERE account_id=$1 AND use_id=$2 AND state='removed'`, f.account, use).Scan(&removed); err != nil {
			t.Fatal(err)
		}
		if removed != 1 {
			t.Fatalf("race created %d active recoveries", removed)
		}
		f.expectMessage(message, true)
		f.expectObject(key, true)
	})
}
