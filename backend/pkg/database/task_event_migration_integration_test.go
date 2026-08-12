package database

import (
	"context"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestTaskEventMigrationIntegration is opt-in because it creates and drops a
// disposable PostgreSQL database. It proves startup idempotency and the
// account-composite boundaries used by Work events.
func TestTaskEventMigrationIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_TASK_EVENT_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_TASK_EVENT_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_task_event_migration_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path, testURL.Path = "/postgres", "/"+databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent second migrate: %v", err)
	}

	accountA, accountB := uuid.New(), uuid.New()
	userA, userB := uuid.New(), uuid.New()
	var environmentA, environmentB uuid.UUID
	var workflowA, workflowB uuid.UUID
	var listA, listB uuid.UUID
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Events A'),($2,'Events B')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES
		($1,$2,$3,$4,'test'),($5,$6,$7,$8,'test')`, userA, accountA, "event-a-"+userA.String(), userA.String()+"@test.invalid",
		userB, accountB, "event-b-"+userB.String(), userB.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,TRUE),($3,$4,TRUE)`, userA, accountA, userB, accountB); err != nil {
		t.Fatal(err)
	}
	readGeneratedHierarchy := func(accountID uuid.UUID, environmentID, workflowID, listID *uuid.UUID) {
		t.Helper()
		if err := db.QueryRow(ctx, `SELECT environment.id,workflow.id,list.id
			FROM task_environments environment
			JOIN task_workflows workflow ON workflow.account_id=environment.account_id AND workflow.environment_id=environment.id AND workflow.is_default
			JOIN task_lists list ON list.account_id=environment.account_id AND list.environment_id=environment.id AND list.is_default
			WHERE environment.account_id=$1 AND environment.is_default
				AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
				AND list.archived_at IS NULL AND list.deleted_at IS NULL`, accountID).Scan(environmentID, workflowID, listID); err != nil {
			t.Fatalf("generated Work hierarchy for account %s: %v", accountID, err)
		}
	}
	readGeneratedHierarchy(accountA, &environmentA, &workflowA, &listA)
	readGeneratedHierarchy(accountB, &environmentB, &workflowB, &listB)

	eventA, eventB := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO work_events(id,account_id,list_id,organizer_id,title,is_all_day,start_at,end_at,timezone,created_by)
		VALUES($1,$2,$3,$4,'Account A event',FALSE,'2026-08-10T10:00:00Z','2026-08-10T11:00:00Z','UTC',$4),
		($5,$6,$7,$8,'Account B event',FALSE,'2026-08-10T12:00:00Z','2026-08-10T13:00:00Z','UTC',$8)`,
		eventA, accountA, listA, userA, eventB, accountB, listB, userB); err != nil {
		t.Fatalf("insert valid events: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO work_event_attendees(account_id,event_id,user_id) VALUES($1,$2,$3)`, accountA, eventA, userB); err == nil {
		t.Fatal("cross-account attendee was accepted")
	}
	if _, err := db.Exec(ctx, `UPDATE work_events SET series_root_id=$1 WHERE account_id=$2 AND id=$3`, eventB, accountA, eventA); err == nil {
		t.Fatal("cross-account series root was accepted")
	}
	if _, err := db.Exec(ctx, `UPDATE work_events SET color='#10b981' WHERE account_id=$1 AND id=$2`, accountA, eventA); err == nil {
		t.Fatal("non-canonical lowercase color was accepted")
	}
	var indexCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname='public' AND indexname IN
		('idx_work_events_timed_range','idx_work_events_all_day_range','idx_work_event_attendees_user','idx_work_event_reminders_pending')`).Scan(&indexCount); err != nil || indexCount != 4 {
		t.Fatalf("event indexes: count=%d err=%v", indexCount, err)
	}
}
