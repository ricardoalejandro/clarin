package api

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

// This fixture creates its own database and tests real reference barriers,
// inventory and detach transactions. It never instantiates a provider or S3.
func TestChatLinkPreviewStorageIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_LINK_PREVIEW_STORAGE_INTEGRATION") != "1" {
		t.Skip("requires isolated PostgreSQL")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Host == "" {
		t.Fatal("DATABASE_URL required")
	}
	ctx := context.Background()
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	name := "clarin_link_preview_storage_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") })
	parsed.Path = "/" + name
	db, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	if err = database.Migrate(db); err != nil {
		t.Fatal("migration is not idempotent:", err)
	}
	exec := func(q string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, q, args...); e != nil {
			t.Fatal(e)
		}
	}
	repos := repository.NewRepositories(db)
	s := &Server{repos: repos, services: service.NewServices(repos, nil, nil)}
	account, other, device := uuid.New(), uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name,storage_limit_bytes) VALUES($1,'Preview storage QA',1048576),($2,'Other QA',1048576)`, account, other)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Preview QA')`, device, account)
	chat, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "120077000001@g.us", "Preview QA")
	if err != nil {
		t.Fatal(err)
	}
	hash := "link_preview:" + strings.Repeat("a", 64)
	asset, key, reused, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, hash, 120)
	if err != nil || reused {
		t.Fatalf("reserve: %v", err)
	}
	var inventoryCount int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2 AND source='link_preview'`, account, key).Scan(&inventoryCount); err != nil || inventoryCount != 1 {
		t.Fatal("upload not durably inventoried")
	}
	if _, _, _, err = repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, hash, 120); err == nil {
		t.Fatal("concurrent unfinished upload reused")
	}
	if err = repos.MediaAsset.CompleteLinkPreviewMedia(ctx, account, asset, key, true); err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE media_assets SET updated_at=NOW()-INTERVAL '2 days' WHERE id=$1`, asset)
	_, leaseKey, reused, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, hash, 120)
	if err != nil || !reused || leaseKey != key {
		t.Fatal("active deduplication lost canonical object")
	}
	var leased bool
	if err = db.QueryRow(ctx, `SELECT `+storageLinkPreviewAssetLeaseSQL+` FROM media_assets WHERE id=$1`, asset).Scan(&leased); err != nil || !leased {
		t.Fatal("dedupe did not renew GC lease")
	}
	message := uuid.New()
	preview := `{"url":"https://example.org/","title":"Example","description":"Card text","thumbnail_url":"/api/media/file/` + key + `"}`
	exec(`INSERT INTO messages(id,account_id,device_id,chat_id,message_id,from_jid,body,message_type,media_url,media_asset_id,link_preview,link_preview_media_asset_id,timestamp,is_read,status) VALUES($1,$2,$3,$4,'preview-original','51999001@s.whatsapp.net','https://example.org','image',$5,$6,$7,$6,NOW(),true,'read')`, message, account, device, chat.ID, "/api/media/file/"+key, asset, preview)
	previewRevision := func() int64 {
		t.Helper()
		var version int64
		if e := db.QueryRow(ctx, `SELECT link_preview_version FROM messages WHERE account_id=$1 AND id=$2`, account, message).Scan(&version); e != nil {
			t.Fatal(e)
		}
		return version
	}
	initialRevision := previewRevision()
	exec(`INSERT INTO chat_group_message_state(account_id,chat_id,message_id,edited_body,edited_at,edited_link_preview,edited_link_preview_media_asset_id) VALUES($1,$2,'pending-edit','https://example.org',NOW(),$3,$4)`, account, chat.ID, preview, asset)
	refs, err := storageSelfServiceObjectReferences(ctx, db, account, key)
	if err != nil || len(refs) != 3 {
		t.Fatalf("independent main/preview/pending references: %d %v", len(refs), err)
	}
	foreignRefs, err := storageSelfServiceObjectReferences(ctx, db, other, key)
	if err == nil && len(foreignRefs) != 0 {
		t.Fatal("cross-account references leaked")
	}
	actor := storageUseActor{AccountID: account, UserID: uuid.New(), Claims: &service.JWTClaims{AccountID: account, Role: "member", Permissions: []string{domain.PermChats, domain.PermSettings}}}
	adapter := storageLinkPreviewUseAdapter{}
	uses, err := adapter.List(ctx, s, db, actor, key)
	if err != nil || len(uses) != 2 {
		t.Fatalf("preview uses: %d %v", len(uses), err)
	}
	var snapshots []storageUseSnapshot
	for _, use := range uses {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, storageSelfServiceReferenceLock, account); e != nil {
			t.Fatal(e)
		}
		snap, e := adapter.Detach(ctx, s, tx, actor, use)
		if e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		snapshotJSON, _ := json.Marshal(snap)
		if _, e = tx.Exec(ctx, `INSERT INTO storage_removed_references(account_id,actor_id,operation_id,object_key,use_id,adapter,origin_type,label,filename,media_type,size_bytes,snapshot) VALUES($1,$2,$3,$4,$5,'link_preview','chats','Preview QA','link-preview.jpg','image',120,$6)`, account, actor.UserID, uuid.New(), key, snap.UseID, snapshotJSON); e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		snapshots = append(snapshots, snap)
	}
	var mainURL, body, status string
	var read bool
	var thumbnail *string
	if err = db.QueryRow(ctx, `SELECT media_url,body,status,is_read,link_preview->>'thumbnail_url' FROM messages WHERE id=$1`, message).Scan(&mainURL, &body, &status, &read, &thumbnail); err != nil {
		t.Fatal(err)
	}
	if mainURL != "/api/media/file/"+key || body != "https://example.org" || status != "read" || !read || thumbnail != nil {
		t.Fatal("thumbnail detach modified primary media or lifecycle")
	}
	detachedRevision := previewRevision()
	if detachedRevision != initialRevision+1 {
		t.Fatal("thumbnail detach did not advance its canonical revision exactly once")
	}
	canonical, e := repos.Message.ListStorageCleanupMessages(ctx, account, []string{key}, uuid.Nil)
	if e != nil || len(canonical) != 1 || canonical[0].LinkPreviewVersion != detachedRevision || canonical[0].LinkPreview == nil || canonical[0].LinkPreview.ThumbnailURL != nil {
		t.Fatal("cleanup event projection lost canonical preview revision", e)
	}
	// A duplicated provider delivery is not permission to undo a user's removal.
	author := "51999001@s.whatsapp.net"
	candidatePreview := domain.ReceivedMessageLinkPreview(body, "https://example.org/", "Example", "Card text")
	if candidatePreview == nil {
		t.Fatal("invalid enrichment fixture")
	}
	thumbnailURL := "/api/media/file/" + key
	candidatePreview.ThumbnailURL = &thumbnailURL
	candidate := &domain.Message{AccountID: account, ChatID: chat.ID, DeviceID: &device, MessageID: "preview-original", FromJID: &author, Body: &body, LinkPreview: candidatePreview, LinkPreviewMediaAssetID: &asset}
	if enriched, e := repos.Message.EnrichLinkPreview(ctx, candidate); e != nil || enriched {
		t.Fatal("provider duplicate restored an explicitly removed thumbnail", e)
	}
	if err = db.QueryRow(ctx, `SELECT link_preview->>'thumbnail_url' FROM messages WHERE id=$1`, message).Scan(&thumbnail); err != nil || thumbnail != nil {
		t.Fatal("removed thumbnail returned after enrichment", err)
	}
	if previewRevision() != detachedRevision {
		t.Fatal("rejected duplicate advanced the preview revision")
	}
	exec(`UPDATE messages SET status='read',is_read=true,read_at=NOW(),delivered_at=NOW() WHERE account_id=$1 AND id=$2`, account, message)
	if previewRevision() != detachedRevision {
		t.Fatal("receipt update changed the independent preview revision")
	}
	for _, snap := range snapshots {
		tx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		if e = adapter.Restore(ctx, s, tx, actor, snap); e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		if _, e = tx.Exec(ctx, `UPDATE storage_removed_references SET state='restored',restored_at=NOW() WHERE account_id=$1 AND use_id=$2 AND state='removed'`, account, snap.UseID); e != nil {
			tx.Rollback(ctx)
			t.Fatal(e)
		}
		if e = tx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
	}
	restoredRevision := previewRevision()
	if restoredRevision != detachedRevision+1 {
		t.Fatal("thumbnail restore did not advance its canonical revision")
	}
	canonical, e = repos.Message.ListStorageCleanupMessages(ctx, account, []string{key}, uuid.Nil)
	if e != nil || len(canonical) != 1 || canonical[0].LinkPreviewVersion != restoredRevision || canonical[0].LinkPreview == nil || canonical[0].LinkPreview.ThumbnailURL == nil || !canonical[0].IsRead || canonical[0].Status == nil || *canonical[0].Status != "read" || canonical[0].ReadAt == nil {
		t.Fatal("restored canonical snapshot regressed preview or receipt state", e)
	}
	// Main attachment removal is independent; preview+pending state retain bytes.
	exec(`UPDATE messages SET media_deleted=true,media_url=NULL,media_asset_id=NULL WHERE id=$1`, message)
	var live bool
	if err = db.QueryRow(ctx, `SELECT clarin_storage_has_live_references($1,$2,$3)`, account, key, asset).Scan(&live); err != nil || !live {
		t.Fatal("deleted main media erased preview GC protection")
	}
	exec(`UPDATE media_assets SET updated_at=NOW()-INTERVAL '2 days' WHERE id=$1`, asset)
	adminRefs, err := s.storageReferencedObjectKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := adminRefs[key]; !ok {
		t.Fatal("old shared preview became admin orphan")
	}
	// Index uses carry a row UUID separately from the two reference identities.
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.storageInventoryIndexSources(ctx, tx, account, storageInventorySources()); err != nil {
		tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM storage_inventory_references WHERE account_id=$1 AND object_key=$2 AND (ref_id LIKE 'preview:%' OR ref_id LIKE 'edit-preview:%') AND source_id ~ '^[0-9a-f-]{36}$'`, account, key).Scan(&inventoryCount); err != nil || inventoryCount != 2 {
		t.Fatalf("thumbnail inventory lost source generation: %d %v", inventoryCount, err)
	}
	// All statement variants are parsed by PostgreSQL, including indexed paging.
	args := append(storageInventoryArguments(account, actor.UserID, actor.Claims), key)
	var indexedUses int
	if err = db.QueryRow(ctx, storageInventoryObjectCTE(actor.Claims, false)+storageUseCandidatesSQL+` SELECT count(*) FROM use_candidates`, args...).Scan(&indexedUses); err != nil || indexedUses != 2 {
		t.Fatalf("indexed uses mismatch: %d %v", indexedUses, err)
	}
	// A retired key cannot acquire a new reference, even via pending-edit replay.
	retired, retiredKey, _, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, "link_preview:"+strings.Repeat("b", 64), 10)
	if err != nil {
		t.Fatal(err)
	}
	if err = repos.MediaAsset.CompleteLinkPreviewMedia(ctx, account, retired, retiredKey, false); err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE media_assets SET status='deleting' WHERE id=$1`, retired)
	if _, err = db.Exec(ctx, `UPDATE chat_group_message_state SET edited_link_preview_media_asset_id=$3 WHERE account_id=$1 AND chat_id=$2`, account, chat.ID, retired); err == nil {
		t.Fatal("late attach bypassed deletion tombstone")
	}
	if _, err = db.Exec(ctx, `UPDATE messages SET link_preview_media_asset_id=$2 WHERE id=$1`, message, uuid.New()); err == nil {
		t.Fatal("foreign/missing asset accepted")
	}
	t.Run("pending replay takes storage barrier before chat row", func(t *testing.T) {
		cleanupTx, e := db.Begin(ctx)
		if e != nil {
			t.Fatal(e)
		}
		defer cleanupTx.Rollback(ctx)
		if _, e = cleanupTx.Exec(ctx, storageSelfServiceReferenceLock, account); e != nil {
			t.Fatal(e)
		}
		text := "https://example.org"
		fromJID := "51999001@s.whatsapp.net"
		messageType, provider := "text", domain.DeviceProviderWhatsAppWeb
		incoming := &domain.Message{AccountID: account, DeviceID: &device, ChatID: chat.ID, MessageID: "pending-edit", FromJID: &fromJID, Body: &text, MessageType: &messageType, Provider: &provider, Timestamp: time.Now()}
		done := make(chan error, 1)
		writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		go func() { done <- repos.Message.Create(writeCtx, incoming) }()
		select {
		case e := <-done:
			t.Fatalf("writer bypassed held cleanup barrier: %v", e)
		case <-time.After(100 * time.Millisecond):
		}
		if _, e = cleanupTx.Exec(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE NOWAIT`, account, chat.ID); e != nil {
			t.Fatal("writer inverted chat/storage locks", e)
		}
		if e = cleanupTx.Commit(ctx); e != nil {
			t.Fatal(e)
		}
		if e = <-done; e != nil {
			t.Fatal(e)
		}
		var got uuid.UUID
		if e = db.QueryRow(ctx, `SELECT link_preview_media_asset_id FROM messages WHERE account_id=$1 AND chat_id=$2 AND message_id='pending-edit'`, account, chat.ID).Scan(&got); e != nil || got != asset {
			t.Fatal("pending edit did not replay its protected asset", e)
		}
	})
	// Delete/cascade removes references; unchanged old bytes become a cleanup
	// candidate, while recently reserved bytes remain protected by their lease.
	exec(`DELETE FROM messages WHERE account_id=$1 AND chat_id=$2`, account, chat.ID)
	exec(`DELETE FROM chats WHERE account_id=$1 AND id=$2`, account, chat.ID)
	if err = db.QueryRow(ctx, `SELECT clarin_storage_has_live_references($1,$2,$3)`, account, key, asset).Scan(&live); err != nil || live {
		t.Fatal("chat deletion left live preview references")
	}
	adminRefs, err = s.storageReferencedObjectKeys(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := adminRefs[key]; ok {
		t.Fatal("unreferenced old preview permanently retained")
	}
	// A terminal upload failure keeps both ledgers; no physical operation here.
	failed, failedKey, _, err := repos.MediaAsset.ReserveLinkPreviewMedia(ctx, account, "link_preview:"+strings.Repeat("c", 64), 11)
	if err != nil {
		t.Fatal(err)
	}
	if err = repos.MediaAsset.CompleteLinkPreviewMedia(ctx, account, failed, failedKey, false); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM media_assets m JOIN storage_objects o ON o.account_id=m.account_id AND o.object_key=m.object_key WHERE m.id=$1 AND m.status='orphan' AND o.status='orphan'`, failed).Scan(&inventoryCount); err != nil || inventoryCount != 1 {
		t.Fatal("failed upload lost durable cleanup")
	}
}
