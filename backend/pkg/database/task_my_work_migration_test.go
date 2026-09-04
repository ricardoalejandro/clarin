package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTaskMyWorkMigrationKeepsPersonalOrderAccountScopedAndWired(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_my_work_migration.go"))
	if err != nil {
		t.Fatalf("read task my work migration: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"CREATE TABLE IF NOT EXISTS task_focus_days",
		"PRIMARY KEY (account_id,user_id,focus_date)",
		"REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE",
		"CREATE TABLE IF NOT EXISTS task_focus_items",
		"PRIMARY KEY (account_id,user_id,focus_date,task_id)",
		"REFERENCES tasks(account_id,id) ON DELETE CASCADE",
		"ON task_focus_items(account_id,user_id,focus_date,position,task_id)",
		"ON tasks(account_id,assigned_to,due_at,id) WHERE deleted_at IS NULL",
		"CREATE TABLE IF NOT EXISTS task_focus_operations",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task my work migration lost invariant %q", invariant)
		}
	}
	databaseRaw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "database.go"))
	if err != nil {
		t.Fatalf("read migration wiring: %v", err)
	}
	if !strings.Contains(string(databaseRaw), "migrateTaskMyWork(ctx, db)") {
		t.Fatal("task my work migration is not wired into Migrate")
	}
}
