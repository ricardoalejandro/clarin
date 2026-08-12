package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTaskEventMigrationKeepsCoreContracts(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve task event migration source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_event_migration.go"))
	if err != nil {
		t.Fatalf("read task event migration: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"ALTER TABLE tasks ADD COLUMN IF NOT EXISTS color VARCHAR(7)",
		"CREATE TABLE IF NOT EXISTS work_events",
		"REFERENCES task_lists(account_id,id)",
		"REFERENCES user_accounts(account_id,user_id)",
		"end_date_exclusive > start_date",
		"end_at > start_at",
		"CREATE TABLE IF NOT EXISTS work_event_attendees",
		"CREATE TABLE IF NOT EXISTS work_event_occurrence_overrides",
		"ADD COLUMN IF NOT EXISTS color_set BOOLEAN NOT NULL DEFAULT FALSE",
		"CREATE TABLE IF NOT EXISTS work_event_reminder_jobs",
		"UNIQUE(account_id,event_id,occurrence_key,user_id)",
		"FOREIGN KEY(account_id,series_root_id) REFERENCES work_events(account_id,id)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task event migration lost invariant %q", invariant)
		}
	}

	databaseRaw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "database.go"))
	if err != nil {
		t.Fatalf("read database migration wiring: %v", err)
	}
	if !strings.Contains(string(databaseRaw), "migrateTaskEvents(ctx, db)") {
		t.Fatal("task event migration is not wired into Migrate")
	}
}
