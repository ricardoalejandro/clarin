package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTaskLifecycleMigrationSeparatesArchiveAndTrashExactlyOnce(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve task lifecycle migration source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_lifecycle_migration.go"))
	if err != nil {
		t.Fatalf("read task lifecycle migration: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"CREATE TABLE IF NOT EXISTS task_schema_migrations",
		"key TEXT PRIMARY KEY",
		"separate_archive_from_trash_v1",
		"ON CONFLICT DO NOTHING RETURNING key",
		"ALTER TABLE task_environments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",
		"ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",
		"ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ",
		"deleted_with_environment BOOLEAN NOT NULL DEFAULT FALSE",
		"deleted_with_folder BOOLEAN NOT NULL DEFAULT FALSE",
		"SET deleted_at=archived_at,deleted_with_folder=archived_with_folder",
		"SET deleted_at=archived_at,archived_at=NULL",
		"WHERE archived_at IS NOT NULL AND deleted_at IS NULL",
		"WHERE is_default AND archived_at IS NULL AND deleted_at IS NULL",
		"idx_task_environments_lifecycle",
		"idx_task_folders_lifecycle",
		"idx_task_lists_lifecycle",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task lifecycle migration lost invariant %q", invariant)
		}
	}

	databaseRaw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "database.go"))
	if err != nil {
		t.Fatalf("read migration wiring: %v", err)
	}
	if !strings.Contains(string(databaseRaw), "migrateTaskContainerLifecycle(ctx, db)") {
		t.Fatal("task lifecycle migration is not wired into Migrate")
	}
}
