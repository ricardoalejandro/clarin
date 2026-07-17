package database

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// TestCRMMigrationDirtyAndIdempotent runs only against an explicitly enabled,
// disposable PostgreSQL database. It proves the startup migration repairs dirty
// pipeline data, preserves intentionally empty pipelines, runs the legacy event
// backfill once, and never forgets DNC after Contact deletion.
func TestCRMMigrationDirtyAndIdempotent(t *testing.T) {
	if os.Getenv("CLARIN_RUN_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}

	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_crm_migration_test"
	adminURL := *parsed
	adminURL.Path = "/postgres"
	testURL := *parsed
	testURL.Path = "/" + databaseName

	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()

	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}

	accountID := uuid.New()
	dirtyPipelineID := uuid.New()
	emptyPipelineID := uuid.New()
	activeStageID := uuid.New()
	contactID := uuid.New()
	leadID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts (id,name) VALUES ($1,'CRM migration test')`, accountID); err != nil {
		t.Fatal(err)
	}
	// WhatsApp status relationships must remain tenant-scoped even when a
	// caller supplies globally valid IDs from another account.
	otherAccountID, deviceID, otherDeviceID := uuid.New(), uuid.New(), uuid.New()
	assetID, otherAssetID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts (id,name) VALUES ($1,'Other account')`, otherAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO devices (id,account_id,name) VALUES ($1,$3,'A'),($2,$4,'B')`, deviceID, otherDeviceID, accountID, otherAccountID); err != nil {
		t.Fatal(err)
	}
	// Simulate an upgraded installation where contact_id is already NOT NULL
	// but the old single-column FK allowed a cross-account Contact parent.
	otherContactID, repairContactID, dirtyCrossAccountChatID := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO contacts (id,account_id,device_id,jid,phone,name)
		VALUES ($1,$2,$3,'51999900007@s.whatsapp.net','51999900007','Wrong tenant owner')
	`, otherContactID, otherAccountID, otherDeviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO contacts (id,account_id,device_id,jid,phone,name)
		VALUES ($1,$2,$3,'51999900070@s.whatsapp.net','51999900070','Correct tenant alias owner')
	`, repairContactID, accountID, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO contact_aliases (account_id,contact_id,alias_type,alias_value,normalized_value)
		VALUES ($1,$2,'phone','+51 999 900 007','51999900007')
	`, accountID, repairContactID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `ALTER TABLE chats DROP CONSTRAINT chats_account_contact_fkey`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO chats (id,account_id,device_id,contact_id,jid,name)
		VALUES ($1,$2,$3,$4,'51999900007@s.whatsapp.net','Repair parent')
	`, dirtyCrossAccountChatID, accountID, deviceID, otherContactID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO media_assets (id,account_id,content_hash,object_key) VALUES
		($1,$3,'status-a',$5),($2,$4,'status-b',$6)
	`, assetID, otherAssetID, accountID, otherAccountID, accountID.String()+"/statuses/a.jpg", otherAccountID.String()+"/statuses/b.jpg"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (account_id,device_id,kind,media_asset_id,status,expires_at)
		VALUES ($1,$2,'image',$3,'sent',NOW()+INTERVAL '24 hours')
	`, accountID, deviceID, assetID); err != nil {
		t.Fatalf("insert valid account-scoped status: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (account_id,device_id,kind,status,expires_at)
		VALUES ($1,$2,'text','sent',NOW()+INTERVAL '24 hours')
	`, accountID, otherDeviceID); err == nil {
		t.Fatal("cross-account device status was accepted")
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (account_id,device_id,kind,media_asset_id,status,expires_at)
		VALUES ($1,$2,'image',$3,'sent',NOW()+INTERVAL '24 hours')
	`, accountID, deviceID, otherAssetID); err == nil {
		t.Fatal("cross-account media status was accepted")
	}

	// Simulate an existing installation from before the composite constraints.
	for _, statement := range []string{
		`ALTER TABLE whatsapp_statuses DROP CONSTRAINT whatsapp_statuses_account_device_fkey`,
		`ALTER TABLE whatsapp_statuses DROP CONSTRAINT whatsapp_statuses_account_media_asset_fkey`,
	} {
		if _, err := db.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	invalidDeviceStatusID, invalidMediaStatusID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (id,account_id,device_id,kind,status,expires_at)
		VALUES ($1,$2,$3,'text','sent',NOW()+INTERVAL '24 hours')
	`, invalidDeviceStatusID, accountID, otherDeviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (id,account_id,device_id,kind,media_asset_id,status,expires_at)
		VALUES ($1,$2,$3,'image',$4,'sent',NOW()+INTERVAL '24 hours')
	`, invalidMediaStatusID, accountID, deviceID, otherAssetID); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("status tenant repair migrate: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM whatsapp_statuses WHERE id=$1`, 0, invalidDeviceStatusID)
	assertInt(t, db, `SELECT COUNT(*) FROM whatsapp_statuses WHERE id=$1 AND media_asset_id IS NULL AND media_url IS NULL`, 1, invalidMediaStatusID)
	assertInt(t, db, `
		SELECT COUNT(*) FROM chats ch
		JOIN contacts contact ON contact.id=ch.contact_id AND contact.account_id=ch.account_id
		WHERE ch.id=$1 AND ch.account_id=$2 AND ch.contact_id=$3
	`, 1, dirtyCrossAccountChatID, accountID, repairContactID)
	legacyStatusMessage := &domain.Message{
		AccountID: accountID, DeviceID: &deviceID, ChatID: dirtyCrossAccountChatID,
		MessageID: "must-not-reuse-legacy-status", MediaAssetID: &assetID, Timestamp: time.Now(),
	}
	if err := repository.NewRepositories(db).Message.Create(ctx, legacyStatusMessage); err == nil {
		t.Fatal("chat message reused a raw-hash asset from the protected status namespace")
	}
	// Reactivating a previously deleted hash must point at the newly uploaded
	// object. Keeping the old object key would make retention delete the wrong
	// file while leaking the replacement.
	reactivatedAssetID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO media_assets (
			id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,deleted_at
		) VALUES ($1,$2,'reactivated-hash',$3,'image','image/jpeg','old.jpg',10,'deleted',NOW())
	`, reactivatedAssetID, accountID, accountID.String()+"/statuses/old.jpg"); err != nil {
		t.Fatal(err)
	}
	reactivated, err := repository.NewRepositories(db).MediaAsset.Upsert(ctx, repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: "reactivated-hash",
		ObjectKey: accountID.String() + "/statuses/new.webp", MediaType: "image",
		ContentType: "image/webp", Filename: "new.webp", SizeBytes: 42,
	})
	if err != nil {
		t.Fatalf("reactivate media asset: %v", err)
	}
	if reactivated.ID != reactivatedAssetID || reactivated.ObjectKey != accountID.String()+"/statuses/new.webp" ||
		reactivated.ContentType != "image/webp" || reactivated.Filename != "new.webp" ||
		reactivated.SizeBytes != 42 || reactivated.Status != "active" || reactivated.DeletedAt != nil {
		t.Fatalf("reactivated media asset kept stale metadata: %#v", reactivated)
	}
	concurrent, err := repository.NewRepositories(db).MediaAsset.Upsert(ctx, repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: "reactivated-hash",
		ObjectKey: accountID.String() + "/statuses/concurrent.webp", MediaType: "image",
		ContentType: "image/webp", Filename: "concurrent.webp", SizeBytes: 42,
	})
	if err != nil {
		t.Fatalf("concurrent media asset upsert: %v", err)
	}
	if concurrent.ObjectKey != reactivated.ObjectKey || concurrent.Filename != reactivated.Filename {
		t.Fatalf("active media asset was replaced by concurrent upload: %#v", concurrent)
	}
	// Retention deletes metadata first, then creates a durable GC claim. MinIO
	// deletion occurs outside database locks; a same-hash upload therefore uses
	// a new key, while the token finalizes only the old object captured by GC.
	cleanupAssetID, cleanupStatusID := uuid.New(), uuid.New()
	cleanupObjectKey := accountID.String() + "/_private/statuses/cleanup-old.jpg"
	if _, err := db.Exec(ctx, `
		INSERT INTO media_assets (
			id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at
		) VALUES ($1,$2,'whatsapp_status:cleanup-race-hash',$3,'image','image/jpeg','cleanup-old.jpg',12,'active',NOW()-INTERVAL '1 hour')
	`, cleanupAssetID, accountID, cleanupObjectKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO storage_objects (account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
		VALUES ($1,$2,'image','image/jpeg','cleanup-old.jpg',12,'whatsapp_status','active')
	`, accountID, cleanupObjectKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_statuses (id,account_id,device_id,kind,media_url,media_asset_id,status,expires_at)
		VALUES ($1,$2,$3,'image',$4,$5,'sent',NOW()-INTERVAL '1 hour')
	`, cleanupStatusID, accountID, deviceID, "/api/media/file/"+cleanupObjectKey, cleanupAssetID); err != nil {
		t.Fatal(err)
	}
	statusRepos := repository.NewRepositories(db)
	cleanupAt := time.Now()
	deletedStatuses, err := statusRepos.WhatsAppStatus.DeleteExpired(ctx, cleanupAt)
	if err != nil || len(deletedStatuses) != 1 || deletedStatuses[0].ID != cleanupStatusID {
		t.Fatalf("delete expired status metadata: rows=%#v err=%v", deletedStatuses, err)
	}
	staged, err := statusRepos.WhatsAppStatus.ScheduleMediaCleanup(ctx, accountID, cleanupAssetID, cleanupAt)
	if err != nil || !staged {
		t.Fatalf("schedule expired status media: staged=%v err=%v", staged, err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM whatsapp_statuses WHERE id=$1`, 0, cleanupStatusID)
	assertInt(t, db, `SELECT COUNT(*) FROM media_assets WHERE id=$1 AND status='status_gc_pending'`, 1, cleanupAssetID)
	if leased, err := statusRepos.MediaAsset.GetByHash(ctx, accountID, "whatsapp_status:cleanup-race-hash"); err != nil || leased != nil {
		t.Fatalf("tombstoned asset was reusable: asset=%#v err=%v", leased, err)
	}
	claim, err := statusRepos.WhatsAppStatus.ClaimPendingMediaCleanup(ctx, cleanupAt.Add(time.Hour))
	if err != nil || claim == nil || claim.ObjectKey != cleanupObjectKey || claim.Token == uuid.Nil {
		t.Fatalf("claim status media GC: claim=%#v err=%v", claim, err)
	}
	blockedStatus := &domain.WhatsAppStatus{
		AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: "image",
		MediaAssetID: &cleanupAssetID, Status: "pending", ExpiresAt: cleanupAt.Add(24 * time.Hour),
	}
	if err := statusRepos.WhatsAppStatus.Create(ctx, blockedStatus); err == nil {
		t.Fatal("status creation reused an asset already claimed by GC")
	}
	cleanupNewObjectKey := accountID.String() + "/_private/statuses/cleanup-new.jpg"
	reactivatedCleanup, err := statusRepos.MediaAsset.Upsert(ctx, repository.MediaAssetUpsert{
		AccountID: accountID, ContentHash: "whatsapp_status:cleanup-race-hash",
		ObjectKey: cleanupNewObjectKey, MediaType: "image",
		ContentType: "image/jpeg", Filename: "cleanup-new.jpg", SizeBytes: 12,
	})
	if err != nil || reactivatedCleanup == nil || reactivatedCleanup.ObjectKey != cleanupNewObjectKey || reactivatedCleanup.Status != "active" {
		t.Fatalf("same-hash upload did not reactivate with a new object: asset=%#v err=%v", reactivatedCleanup, err)
	}
	reactivatedStatus := &domain.WhatsAppStatus{
		AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: "image",
		MediaAssetID: &cleanupAssetID, Status: "pending", ExpiresAt: cleanupAt.Add(24 * time.Hour),
	}
	if err := statusRepos.WhatsAppStatus.Create(ctx, reactivatedStatus); err != nil {
		t.Fatalf("status creation did not accept the reactivated private asset: %v", err)
	}
	if err := statusRepos.WhatsAppStatus.FinalizeMediaCleanup(ctx, *claim, nil, cleanupAt.Add(time.Hour)); err != nil {
		t.Fatalf("finalize status media GC: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2 AND status='deleted'`, 1, accountID, cleanupObjectKey)
	assertInt(t, db, `SELECT COUNT(*) FROM media_assets WHERE id=$1 AND object_key=$2 AND status='active'`, 1, cleanupAssetID, cleanupNewObjectKey)

	// Legacy status-only objects remain eligible for retention, while a
	// corrupted cross-account queue key is quarantined before a claim can ever
	// reach object storage.
	legacyAssetID := uuid.New()
	legacyObjectKey := accountID.String() + "/statuses/legacy.jpg"
	if _, err := db.Exec(ctx, `INSERT INTO media_assets (
		id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at
	) VALUES ($1,$2,'legacy-raw-hash',$3,'image','image/jpeg','legacy.jpg',8,'active',NOW()-INTERVAL '1 hour')`,
		legacyAssetID, accountID, legacyObjectKey); err != nil {
		t.Fatal(err)
	}
	if staged, err := statusRepos.WhatsAppStatus.ScheduleMediaCleanup(ctx, accountID, legacyAssetID, cleanupAt); err != nil || !staged {
		t.Fatalf("schedule legacy status asset: staged=%v err=%v", staged, err)
	}
	unsafeObjectKey := otherAccountID.String() + "/_private/statuses/not-owned.jpg"
	if _, err := db.Exec(ctx, `INSERT INTO storage_objects (
		account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at
	) VALUES ($1,$2,'image','image/jpeg','not-owned.jpg',1,'whatsapp_status','status_gc_pending',$3)`,
		accountID, unsafeObjectKey, cleanupAt); err != nil {
		t.Fatal(err)
	}
	legacyClaim, err := statusRepos.WhatsAppStatus.ClaimPendingMediaCleanup(ctx, cleanupAt.Add(time.Hour))
	if err != nil || legacyClaim == nil || legacyClaim.ObjectKey != legacyObjectKey {
		t.Fatalf("claim skipped/quarantined status jobs incorrectly: claim=%#v err=%v", legacyClaim, err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 AND status='status_gc_rejected'`, 1, accountID, unsafeObjectKey)
	if err := statusRepos.WhatsAppStatus.FinalizeMediaCleanup(ctx, *legacyClaim, nil, cleanupAt.Add(time.Hour)); err != nil {
		t.Fatalf("finalize legacy status asset: %v", err)
	}

	urlOnlyStatusID := uuid.New()
	urlOnlyObjectKey := accountID.String() + "/statuses/url-only.jpg"
	urlOnlyMediaURL := "/api/media/file/" + urlOnlyObjectKey
	if _, err := db.Exec(ctx, `INSERT INTO whatsapp_statuses (
		id,account_id,device_id,kind,media_url,status,expires_at
	) VALUES ($1,$2,$3,'image',$4,'sent',NOW()+INTERVAL '1 hour')`,
		urlOnlyStatusID, accountID, deviceID, urlOnlyMediaURL); err != nil {
		t.Fatal(err)
	}
	if staged, err := statusRepos.WhatsAppStatus.ScheduleLegacyObjectCleanup(ctx, accountID, urlOnlyObjectKey, cleanupAt); err != nil || staged {
		t.Fatalf("referenced URL-only status was scheduled: staged=%v err=%v", staged, err)
	}
	if _, err := db.Exec(ctx, `UPDATE whatsapp_statuses SET expires_at=$3
		WHERE account_id=$1 AND id=$2`, accountID, urlOnlyStatusID, cleanupAt.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	urlOnlyExpired, err := statusRepos.WhatsAppStatus.DeleteExpired(ctx, cleanupAt)
	if err != nil || len(urlOnlyExpired) != 1 || urlOnlyExpired[0].ID != urlOnlyStatusID {
		t.Fatalf("atomically delete/queue URL-only status: rows=%#v err=%v", urlOnlyExpired, err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 AND status='status_gc_pending'`, 1, accountID, urlOnlyObjectKey)
	urlOnlyClaim, err := statusRepos.WhatsAppStatus.ClaimPendingMediaCleanup(ctx, cleanupAt.Add(time.Hour))
	if err != nil || urlOnlyClaim == nil || urlOnlyClaim.ObjectKey != urlOnlyObjectKey {
		t.Fatalf("claim URL-only status cleanup: claim=%#v err=%v", urlOnlyClaim, err)
	}
	if err := statusRepos.WhatsAppStatus.FinalizeMediaCleanup(ctx, *urlOnlyClaim, nil, cleanupAt.Add(time.Hour)); err != nil {
		t.Fatalf("finalize URL-only status cleanup: %v", err)
	}
	pendingUploadKey := accountID.String() + "/_private/statuses/crash-before-asset.jpg"
	if err := statusRepos.WhatsAppStatus.PrepareMediaUpload(ctx, accountID, pendingUploadKey, "image", "image/jpeg", "crash.jpg", 5, cleanupAt.Add(-time.Hour)); err != nil {
		t.Fatalf("prepare durable status upload: %v", err)
	}
	if err := statusRepos.WhatsAppStatus.PrepareMediaUpload(ctx, accountID, unsafeObjectKey, "image", "image/jpeg", "unsafe.jpg", 5, cleanupAt); err == nil {
		t.Fatal("prepared a status upload in another account's namespace")
	}
	pendingUploadClaim, err := statusRepos.WhatsAppStatus.ClaimPendingMediaCleanup(ctx, cleanupAt)
	if err != nil || pendingUploadClaim == nil || pendingUploadClaim.ObjectKey != pendingUploadKey {
		t.Fatalf("claim crash-orphaned upload: claim=%#v err=%v", pendingUploadClaim, err)
	}
	if err := statusRepos.WhatsAppStatus.FinalizeMediaCleanup(ctx, *pendingUploadClaim, nil, cleanupAt); err != nil {
		t.Fatalf("finalize crash-orphaned upload: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO pipelines (id,account_id,name) VALUES ($1,$3,'Dirty'),($2,$3,'Empty')`, dirtyPipelineID, emptyPipelineID, accountID); err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_pipeline_position_key`,
		`ALTER TABLE pipeline_stages DROP CONSTRAINT IF EXISTS pipeline_stages_stage_type_check`,
		`DROP INDEX IF EXISTS uq_pipeline_stages_won`,
		`DROP INDEX IF EXISTS uq_pipeline_stages_lost`,
		`DROP INDEX IF EXISTS uq_pipeline_stages_normalized_name`,
	} {
		if _, err := db.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO pipeline_stages (id,pipeline_id,name,position,stage_type) VALUES
		($1,$2,' Contactado ',0,'active'),
		(gen_random_uuid(),$2,'contactado',0,'active'),
		(gen_random_uuid(),$2,'Ganado',0,'won'),
		(gen_random_uuid(),$2,'Ganado duplicado',0,'won')
	`, activeStageID, dirtyPipelineID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO contacts (id,account_id,jid,phone,name) VALUES ($1,$2,'51999900001@s.whatsapp.net','51999900001','Persona')`, contactID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO chats (account_id,device_id,contact_id,jid,name)
		VALUES ($1,$2,$3,'51999900009@s.whatsapp.net','Cross tenant device')
	`, accountID, otherDeviceID, contactID); err == nil {
		t.Fatal("database accepted a chat whose device belongs to another account")
	}
	temporaryDeviceID, temporaryChatID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO devices (id,account_id,name) VALUES ($1,$2,'Temporary')`, temporaryDeviceID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO chats (id,account_id,device_id,contact_id,jid) VALUES ($1,$2,$3,$4,'51999900008@s.whatsapp.net')`, temporaryChatID, accountID, temporaryDeviceID, contactID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM devices WHERE id=$1 AND account_id=$2`, temporaryDeviceID, accountID); err != nil {
		t.Fatalf("same-account device deletion broke composite chat FK: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND account_id=$2 AND device_id IS NULL`, 1, temporaryChatID, accountID)
	chatRepos := repository.NewRepositories(db)
	chat, err := chatRepos.Chat.GetOrCreateForContact(ctx, accountID, deviceID, contactID, "51999900001@s.whatsapp.net", "51999900001", "Persona")
	if err != nil {
		t.Fatalf("create explicitly linked chat: %v", err)
	}
	if chat.ContactID == nil || *chat.ContactID != contactID {
		t.Fatal("new chat did not preserve the selected Contact parent")
	}
	if _, err := chatRepos.Chat.GetOrCreateForContact(ctx, otherAccountID, otherDeviceID, contactID, "51999900001@s.whatsapp.net", "51999900001", "Persona"); err != pgx.ErrNoRows {
		t.Fatalf("cross-account Contact was accepted for new chat: %v", err)
	}
	if _, err := chatRepos.Chat.GetOrCreateForContact(ctx, accountID, otherDeviceID, contactID, "51999900003@s.whatsapp.net", "51999900003", "Persona"); err != pgx.ErrNoRows {
		t.Fatalf("cross-account device was accepted for new chat: %v", err)
	}
	// Exercise the defensive no-contact flow against a controlled legacy shape.
	// Current production migrations require Contact as parent; the column is
	// restored to NOT NULL before continuing the idempotency test.
	if _, err := db.Exec(ctx, `ALTER TABLE chats ALTER COLUMN contact_id DROP NOT NULL`); err != nil {
		t.Fatal(err)
	}
	unlinkedChatID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO chats (id,account_id,device_id,jid,name)
		VALUES ($1,$2,$3,'51999900004@s.whatsapp.net','Unlinked')
	`, unlinkedChatID, accountID, deviceID); err != nil {
		t.Fatal(err)
	}
	if err := chatRepos.Chat.LinkContact(ctx, accountID, unlinkedChatID, contactID); err != nil {
		t.Fatalf("link existing Contact to chat: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND account_id=$2 AND contact_id=$3`, 1, unlinkedChatID, accountID, contactID)
	assertInt(t, db, `SELECT COUNT(*) FROM contact_aliases WHERE account_id=$1 AND contact_id=$2 AND alias_type='phone' AND normalized_value='51999900004'`, 1, accountID, contactID)
	conflictingContactID, conflictingChatID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO contacts (id,account_id,jid,phone,name)
		VALUES ($1,$2,'51999900005@s.whatsapp.net','51999900005','Existing owner')
	`, conflictingContactID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO chats (id,account_id,device_id,jid,name)
		VALUES ($1,$2,$3,'51999900005@s.whatsapp.net','Conflict')
	`, conflictingChatID, accountID, deviceID); err != nil {
		t.Fatal(err)
	}
	if err := chatRepos.Chat.LinkContact(ctx, accountID, conflictingChatID, contactID); err != repository.ErrContactIdentityConflict {
		t.Fatalf("chat identity was allowed to move between Contacts: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM chats WHERE id=$1`, conflictingChatID); err != nil {
		t.Fatal(err)
	}
	createChatID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO chats (id,account_id,device_id,jid,name)
		VALUES ($1,$2,$3,'51999900006@s.whatsapp.net','Create atomically')
	`, createChatID, accountID, deviceID); err != nil {
		t.Fatal(err)
	}
	createdContactID, err := chatRepos.Chat.CreateAndLinkContact(ctx, accountID, createChatID, "Contacto creado")
	if err != nil {
		t.Fatalf("create and link Contact atomically: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM contacts WHERE id=$1 AND account_id=$2 AND phone='51999900006'`, 1, createdContactID, accountID)
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1 AND account_id=$2 AND contact_id=$3`, 1, createChatID, accountID, createdContactID)
	if _, err := db.Exec(ctx, `ALTER TABLE chats ALTER COLUMN contact_id SET NOT NULL`); err != nil {
		t.Fatalf("restore Contact parent invariant: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO messages (account_id,device_id,chat_id,message_id,body,is_from_me,status,timestamp)
		VALUES ($1,$2,$3,'isolation-message','tenant secret',FALSE,'sent',NOW())
	`, accountID, deviceID, chat.ID); err != nil {
		t.Fatal(err)
	}
	if messages, total, err := chatRepos.Message.SearchByChat(ctx, otherAccountID, chat.ID, "secret", 20, 0); err != nil || total != 0 || len(messages) != 0 {
		t.Fatalf("message search crossed account boundary: total=%d len=%d err=%v", total, len(messages), err)
	}
	if err := chatRepos.Chat.DeleteBatch(ctx, otherAccountID, []uuid.UUID{chat.ID}); err != pgx.ErrNoRows {
		t.Fatalf("cross-account batch deletion did not fail closed: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1`, 1, chat.ID)
	assertInt(t, db, `SELECT COUNT(*) FROM messages WHERE chat_id=$1`, 1, chat.ID)
	if err := chatRepos.Chat.DeleteBatch(ctx, accountID, []uuid.UUID{chat.ID}); err != nil {
		t.Fatalf("account-scoped batch deletion failed: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM chats WHERE id=$1`, 0, chat.ID)
	assertInt(t, db, `SELECT COUNT(*) FROM messages WHERE chat_id=$1`, 0, chat.ID)
	if _, err := db.Exec(ctx, `INSERT INTO leads (id,account_id,contact_id,jid,title,pipeline_id,stage_id,status) VALUES ($1,$2,$3,'51999900001@s.whatsapp.net','Oportunidad de prueba',$4,$5,'won')`, leadID, accountID, contactID, dirtyPipelineID, activeStageID); err != nil {
		t.Fatal(err)
	}

	// Re-open the one-time event migration with an intentionally legacy row.
	if _, err := db.Exec(ctx, `DELETE FROM app_data_migrations WHERE key='crm_event_contact_v1'`); err != nil {
		t.Fatal(err)
	}
	eventPipelineID, eventStageID, eventID, participantID, legacyLeadParticipantID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO event_pipelines (id,account_id,name) VALUES ($1,$2,'Eventos')`, eventPipelineID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO event_pipeline_stages (id,pipeline_id,name,position) VALUES ($1,$2,'Invitado',0)`, eventStageID, eventPipelineID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO events (id,account_id,name,pipeline_id) VALUES ($1,$2,'Evento legado',$3)`, eventID, accountID, eventPipelineID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO event_participants (id,event_id,name,phone,stage_id) VALUES ($1,$2,'Snapshot legado','51999900002',$3)`, participantID, eventID, eventStageID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO event_participants (id,event_id,lead_id,name,phone,stage_id) VALUES ($1,$2,$3,'Participante desde lead','51999900001',$4)`, legacyLeadParticipantID, eventID, leadID, eventStageID); err != nil {
		t.Fatal(err)
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("dirty-data migrate: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id=$1 AND stage_type='won'`, 1, dirtyPipelineID)
	assertInt(t, db, `SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id=$1 AND stage_type='lost'`, 1, dirtyPipelineID)
	assertInt(t, db, `SELECT COUNT(*) FROM (SELECT position FROM pipeline_stages WHERE pipeline_id=$1 GROUP BY position HAVING COUNT(*)>1) duplicates`, 0, dirtyPipelineID)
	assertInt(t, db, `SELECT COUNT(*) FROM (SELECT LOWER(REGEXP_REPLACE(BTRIM(name),'\s+',' ','g')) FROM pipeline_stages WHERE pipeline_id=$1 GROUP BY 1 HAVING COUNT(*)>1) duplicates`, 0, dirtyPipelineID)
	assertInt(t, db, `SELECT COUNT(*) FROM pipeline_stages WHERE pipeline_id=$1`, 0, emptyPipelineID)
	var leadStatus string
	if err := db.QueryRow(ctx, `SELECT status FROM leads WHERE id=$1`, leadID).Scan(&leadStatus); err != nil || leadStatus != "open" {
		t.Fatalf("lead lifecycle was not repaired: status=%q err=%v", leadStatus, err)
	}

	var syntheticContactID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT contact_id FROM event_participants WHERE id=$1`, participantID).Scan(&syntheticContactID); err != nil || syntheticContactID == uuid.Nil {
		t.Fatalf("legacy participant was not linked: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM event_participants WHERE id=$1 AND contact_id=$2 AND lead_id IS NULL`, 1, legacyLeadParticipantID, contactID)

	// Event rules are authoritative in strict mode, but membership history is
	// preserved and a restart must never recreate a removed contact tag from the
	// legacy participant_tags snapshot.
	membershipTagID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'JULIO','#10b981')`, membershipTagID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)`, contactID, membershipTagID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO participant_tags(participant_id,tag_id) VALUES($1,$2)`, legacyLeadParticipantID, membershipTagID); err != nil {
		t.Fatal(err)
	}
	if err := reposForMembership(db).Event.SetMembershipPolicy(ctx, accountID, "strict", nil); err != nil {
		t.Fatal(err)
	}
	cfg := repository.EventRuleConfig{FormulaType: "simple", FormulaMode: "OR", Includes: []uuid.UUID{membershipTagID}}
	preview, err := reposForMembership(db).Event.PreviewEventRule(ctx, eventID, accountID, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := reposForMembership(db).Event.SaveEventRule(ctx, eventID, accountID, cfg, preview.RuleRevision, preview.Fingerprint, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id=$1 AND tag_id=$2`, contactID, membershipTagID); err != nil {
		t.Fatal(err)
	}
	impact, err := reposForMembership(db).Event.ReconcileCurrentEvent(ctx, eventID, accountID, true, false, "integration_test", nil)
	if err != nil {
		t.Fatal(err)
	}
	if impact.Deactivated < 1 {
		t.Fatalf("expected authoritative deactivation, got %+v", impact)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM event_participants WHERE id=$1 AND membership_state='inactive'`, 1, legacyLeadParticipantID)
	if err := Migrate(db); err != nil {
		t.Fatalf("restart migration after tag removal: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM contact_tags WHERE contact_id=$1 AND tag_id=$2`, 0, contactID, membershipTagID)
	if _, err := db.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)`, contactID, membershipTagID); err != nil {
		t.Fatal(err)
	}
	if _, err := reposForMembership(db).Event.ReconcileCurrentEvent(ctx, eventID, accountID, true, false, "integration_test", nil); err != nil {
		t.Fatal(err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM event_participants WHERE id=$1 AND membership_state='active'`, 1, legacyLeadParticipantID)
	assertInt(t, db, `SELECT COUNT(*) FROM crm_audit_events WHERE event_id=$1 AND participant_id=$2 AND category='event_membership'`, 2, eventID, legacyLeadParticipantID)
	if _, err := db.Exec(ctx, `UPDATE contacts SET do_not_contact=TRUE, do_not_contact_reason='Solicitud del contacto' WHERE id=$1`, syntheticContactID); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("DNC backfill migrate: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM contacts WHERE id=$1`, syntheticContactID); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent migrate after contact deletion: %v", err)
	}
	assertInt(t, db, `SELECT COUNT(*) FROM event_participants WHERE id=$1 AND contact_id IS NOT NULL`, 0, participantID)
	assertInt(t, db, `SELECT COUNT(*) FROM contact_suppressions WHERE account_id=$1 AND active=TRUE AND normalized_value='51999900002'`, 1, accountID)

	// Recreating the same identity must surface as DNC immediately, not merely
	// rely on the last-moment sender guard.
	repos := repository.NewRepositories(db)
	recreated, err := repos.Contact.GetOrCreate(ctx, accountID, nil, "51999900002@s.whatsapp.net", "51999900002", "Persona recreada", "", false)
	if err != nil {
		t.Fatalf("recreate suppressed contact: %v", err)
	}
	if recreated == nil || !recreated.DoNotContact {
		t.Fatal("recreated suppressed identity was not restored as DNC")
	}
}

func reposForMembership(db *pgxpool.Pool) *repository.Repositories {
	return repository.NewRepositories(db)
}

func assertInt(t *testing.T, db *pgxpool.Pool, query string, expected int, args ...any) {
	t.Helper()
	var actual int
	if err := db.QueryRow(context.Background(), query, args...).Scan(&actual); err != nil {
		t.Fatalf("query %q: %v", query, err)
	}
	if actual != expected {
		t.Fatalf("query %q: got %d, want %d", query, actual, expected)
	}
}
