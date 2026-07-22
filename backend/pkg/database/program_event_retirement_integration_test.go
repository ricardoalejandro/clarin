package database

import (
	"context"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestProgramEventRetirementMigration requires an explicitly enabled,
// disposable PostgreSQL server. It proves safe migration, account isolation,
// preservation of participants, blocking of non-lossless rows and idempotency.
func TestProgramEventRetirementMigration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_PROGRAM_EVENT_RETIREMENT_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_PROGRAM_EVENT_RETIREMENT_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_program_event_retirement_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
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

	accountID, otherAccountID := uuid.New(), uuid.New()
	userID := uuid.New()
	defaultPipelineID, crossAccountPipelineID := uuid.New(), uuid.New()
	eligibleProgramID, blockedProgramID := uuid.New(), uuid.New()
	contactA, contactB := uuid.New(), uuid.New()
	participantA, participantB := uuid.New(), uuid.New()
	blockedSessionID := uuid.New()
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Cuenta A'),($2,'Cuenta B')`, []any{accountID, otherAccountID}},
		{`INSERT INTO users (id,account_id,username,email,password_hash) VALUES ($1,$2,$3,$4,'test')`, []any{userID, accountID, "event-retirement-" + userID.String(), userID.String() + "@example.test"}},
		{`INSERT INTO event_pipelines (id,account_id,name,is_default) VALUES ($1,$2,'Principal',TRUE),($3,$4,'Otra cuenta',TRUE)`, []any{defaultPipelineID, accountID, crossAccountPipelineID, otherAccountID}},
		{`INSERT INTO contacts (id,account_id,jid,name,phone) VALUES ($1,$3,$4,'Contacto A','51900000001'),($2,$3,$5,'Contacto B','51900000002')`, []any{contactA, contactB, accountID, contactA.String() + "@test", contactB.String() + "@test"}},
		{`INSERT INTO programs (id,account_id,type,name,description,status,color,created_by,pipeline_id,event_date,location)
		  VALUES ($1,$2,'event','Evento migrable','Descripción','active','#112233',$3,$4,'2026-08-01T15:00:00Z','Auditorio')`, []any{eligibleProgramID, accountID, userID, crossAccountPipelineID}},
		{`INSERT INTO program_participants (id,program_id,contact_id,status) VALUES ($1,$2,$3,'active'),($4,$2,$5,'completed')`, []any{participantA, eligibleProgramID, contactA, participantB, contactB}},
		{`INSERT INTO programs (id,account_id,type,name,status,pipeline_id) VALUES ($1,$2,'event','Evento con actividad','active',$3)`, []any{blockedProgramID, accountID, defaultPipelineID}},
		{`INSERT INTO program_sessions (id,account_id,program_id,date,title) VALUES ($1,$2,$3,'2026-08-02','Sesión existente')`, []any{blockedSessionID, accountID, blockedProgramID}},
	}
	for _, fixture := range fixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed fixture: %v\n%s", err, fixture.query)
		}
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("retirement migrate: %v", err)
	}

	var eventID, migratedPipelineID uuid.UUID
	var migrationStatus, sourceStatus, eventStatus, color, location string
	var migratedCount int
	if err := db.QueryRow(ctx, `
		SELECT retirement.event_id,retirement.status,retirement.migrated_participant_count,
		       p.status,e.status,e.color,e.location,e.pipeline_id
		FROM program_event_retirements retirement
		JOIN programs p ON p.account_id=retirement.account_id AND p.id=retirement.program_id
		JOIN events e ON e.account_id=retirement.account_id AND e.id=retirement.event_id
		WHERE retirement.account_id=$1 AND retirement.program_id=$2
	`, accountID, eligibleProgramID).Scan(&eventID, &migrationStatus, &migratedCount, &sourceStatus, &eventStatus, &color, &location, &migratedPipelineID); err != nil {
		t.Fatalf("load migrated relation: %v", err)
	}
	if migrationStatus != "migrated" || sourceStatus != "archived" || eventStatus != "active" || migratedCount != 2 {
		t.Fatalf("unexpected migration state: relation=%s source=%s event=%s participants=%d", migrationStatus, sourceStatus, eventStatus, migratedCount)
	}
	if color != "#112233" || location != "Auditorio" {
		t.Fatalf("event metadata was not preserved: color=%q location=%q", color, location)
	}
	if migratedPipelineID != defaultPipelineID {
		t.Fatalf("cross-account pipeline was not replaced with account pipeline: %s", migratedPipelineID)
	}
	var participantCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM event_participants WHERE event_id=$1 AND contact_id=ANY($2)`, eventID, []uuid.UUID{contactA, contactB}).Scan(&participantCount); err != nil || participantCount != 2 {
		t.Fatalf("participants were not copied exactly: count=%d err=%v", participantCount, err)
	}

	var blockedStatus, blockedReason, blockedSourceStatus string
	var blockedEventID *uuid.UUID
	if err := db.QueryRow(ctx, `
		SELECT retirement.status,retirement.reason,retirement.event_id,p.status
		FROM program_event_retirements retirement
		JOIN programs p ON p.account_id=retirement.account_id AND p.id=retirement.program_id
		WHERE retirement.account_id=$1 AND retirement.program_id=$2
	`, accountID, blockedProgramID).Scan(&blockedStatus, &blockedReason, &blockedEventID, &blockedSourceStatus); err != nil {
		t.Fatalf("load blocked relation: %v", err)
	}
	if blockedStatus != "blocked" || blockedEventID != nil || blockedSourceStatus != "active" || !strings.Contains(blockedReason, "sessions") {
		t.Fatalf("non-lossless program was not preserved as blocked: status=%s reason=%q event=%v source=%s", blockedStatus, blockedReason, blockedEventID, blockedSourceStatus)
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent migrate: %v", err)
	}
	var eventCount, finalParticipantCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM events WHERE id=$1 AND account_id=$2`, eventID, accountID).Scan(&eventCount); err != nil {
		t.Fatalf("count migrated event: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM event_participants WHERE event_id=$1`, eventID).Scan(&finalParticipantCount); err != nil {
		t.Fatalf("count migrated participants: %v", err)
	}
	if eventCount != 1 || finalParticipantCount != 2 {
		t.Fatalf("migration was not idempotent: events=%d participants=%d", eventCount, finalParticipantCount)
	}
}
