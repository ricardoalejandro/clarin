package repository_test

import (
	"context"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/database"
)

func TestWhatsAppStatusPersistenceAndViewerIsolation(t *testing.T) {
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
	const databaseName = "clarin_status_repository_test"
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
	if err := database.Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatalf("idempotent migrate: %v", err)
	}

	accountID, otherAccountID := uuid.New(), uuid.New()
	deviceID, otherDeviceID := uuid.New(), uuid.New()
	contactID, otherContactID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES ($1,'Status account'),($2,'Other status account')`, accountID, otherAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO devices(id,account_id,name) VALUES ($1,$2,'Status device'),($3,$4,'Other device')`, deviceID, accountID, otherDeviceID, otherAccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO contacts(id,account_id,device_id,jid,phone,name)
		VALUES ($1,$2,$3,'51999000111@s.whatsapp.net','51999000111','Viewer'),
		       ($4,$5,$6,'51999000222@s.whatsapp.net','51999000222','Other viewer')
	`, contactID, accountID, deviceID, otherContactID, otherAccountID, otherDeviceID); err != nil {
		t.Fatal(err)
	}

	repos := repository.NewRepositories(db)
	now := time.Now().UTC().Truncate(time.Millisecond)
	status := &domain.WhatsAppStatus{
		AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: "text",
		Status: "pending", ExpiresAt: now.Add(24 * time.Hour),
	}
	if err := repos.WhatsAppStatus.Create(ctx, status); err != nil {
		t.Fatalf("create pending status: %v", err)
	}
	matchedContactID, err := repos.WhatsAppStatus.FindExistingContactForStatusViewer(ctx, accountID, "51999000111@s.whatsapp.net")
	if err != nil || matchedContactID == nil || *matchedContactID != contactID {
		t.Fatalf("match existing viewer: id=%v err=%v", matchedContactID, err)
	}
	// Reproduce the real race between the HTTP publication response and the
	// from-me event. A viewer receipt attached to the event-created duplicate
	// must move to the request row when MarkSent reconciles both identities.
	messageID := "status-message-1"
	mirror := &domain.WhatsAppStatus{
		AccountID: accountID, DeviceID: deviceID, WhatsAppMessageID: &messageID,
		Source: "device", Kind: "text", Status: "sent", SentAt: &now,
		ExpiresAt: now.Add(24 * time.Hour),
	}
	if err := repos.WhatsAppStatus.UpsertOwnDeviceStatus(ctx, mirror); err != nil {
		t.Fatalf("create from-me status mirror: %v", err)
	}
	view, err := repos.WhatsAppStatus.UpsertView(ctx, repository.WhatsAppStatusViewUpsert{
		AccountID: accountID, DeviceID: deviceID, MessageID: messageID,
		ViewerJID: "51999000111@s.whatsapp.net", ContactID: matchedContactID,
		ReceiptType: "read", ViewedAt: now.Add(time.Minute),
	})
	if err != nil || view == nil || view.StatusID != mirror.ID {
		t.Fatalf("attach viewer to from-me mirror: view=%#v err=%v", view, err)
	}
	if err := repos.WhatsAppStatus.MarkSent(ctx, accountID, status.ID, "status-message-1", "contacts", now); err != nil {
		t.Fatalf("mark sent with timestamptz: %v", err)
	}
	persisted, err := repos.WhatsAppStatus.GetByID(ctx, accountID, status.ID)
	if err != nil || persisted == nil || persisted.SentAt == nil || persisted.WhatsAppMessageID == nil {
		t.Fatalf("read marked status: status=%#v err=%v", persisted, err)
	}

	views, total, err := repos.WhatsAppStatus.ListViews(ctx, accountID, status.ID, 20, 0)
	if err != nil || total != 1 || len(views) != 1 || views[0].ContactID == nil || *views[0].ContactID != contactID {
		t.Fatalf("preserve viewer while merging status mirror: total=%d views=%#v err=%v", total, views, err)
	}
	if _, err := repos.WhatsAppStatus.UpsertView(ctx, repository.WhatsAppStatusViewUpsert{
		AccountID: accountID, DeviceID: deviceID, MessageID: "status-message-1",
		ViewerJID: "51999000111@s.whatsapp.net", ContactID: matchedContactID,
		ReceiptType: "played", ViewedAt: now.Add(2 * time.Minute),
	}); err != nil {
		t.Fatalf("idempotent viewer receipt: %v", err)
	}
	views, total, err = repos.WhatsAppStatus.ListViews(ctx, accountID, status.ID, 20, 0)
	if err != nil || total != 1 || len(views) != 1 || views[0].ReceiptType != "played" {
		t.Fatalf("list deduplicated viewers: total=%d views=%#v err=%v", total, views, err)
	}
	active, err := repos.WhatsAppStatus.ListActive(ctx, accountID, deviceID)
	if err != nil || len(active) != 1 || active[0].ViewCount != 1 {
		t.Fatalf("list active view count: statuses=%#v err=%v", active, err)
	}
	foreignView, err := repos.WhatsAppStatus.UpsertView(ctx, repository.WhatsAppStatusViewUpsert{
		AccountID: otherAccountID, DeviceID: otherDeviceID, MessageID: "status-message-1",
		ViewerJID: "51999000111@s.whatsapp.net", ContactID: &otherContactID,
		ReceiptType: "read", ViewedAt: now,
	})
	if err != nil || foreignView != nil {
		t.Fatalf("cross-account viewer matched status: view=%#v err=%v", foreignView, err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO whatsapp_status_views(account_id,device_id,status_id,viewer_jid,contact_id,receipt_type,viewed_at)
		VALUES ($1,$2,$3,'51999000222@s.whatsapp.net',$4,'read',$5)
	`, accountID, deviceID, status.ID, otherContactID, now); err == nil {
		t.Fatal("database accepted a cross-account viewer Contact")
	}

	deleted, err := repos.WhatsAppStatus.DeleteByWhatsAppMessageID(ctx, accountID, deviceID, "status-message-1")
	if err != nil || deleted == nil || deleted.ID != status.ID {
		t.Fatalf("delete remotely revoked status: deleted=%#v err=%v", deleted, err)
	}
	var remainingViews int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whatsapp_status_views WHERE status_id=$1`, status.ID).Scan(&remainingViews); err != nil || remainingViews != 0 {
		t.Fatalf("viewer cascade after status deletion: count=%d err=%v", remainingViews, err)
	}

	stale := &domain.WhatsAppStatus{AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: "text", Status: "pending", ExpiresAt: now.Add(24 * time.Hour)}
	fresh := &domain.WhatsAppStatus{AccountID: accountID, DeviceID: deviceID, Source: "clarin", Kind: "text", Status: "pending", ExpiresAt: now.Add(24 * time.Hour)}
	if err := repos.WhatsAppStatus.Create(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if err := repos.WhatsAppStatus.Create(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE whatsapp_statuses SET updated_at=$3 WHERE account_id=$1 AND id=$2`, accountID, stale.ID, now.Add(-20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	staleDeleted, err := repos.WhatsAppStatus.DeleteStalePending(ctx, now.Add(-10*time.Minute))
	if err != nil || len(staleDeleted) != 1 || staleDeleted[0].ID != stale.ID {
		t.Fatalf("delete stale pending: deleted=%#v err=%v", staleDeleted, err)
	}
	if removed, err := repos.WhatsAppStatus.DeleteByID(ctx, otherAccountID, fresh.ID); err != nil || removed != nil {
		t.Fatalf("cross-account local delete: removed=%#v err=%v", removed, err)
	}
}
