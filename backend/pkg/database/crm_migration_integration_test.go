package database

import (
	"context"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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
