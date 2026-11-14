package database

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskContainerRemoval records replay and exact Trash provenance. It
// deliberately never infers ownership for historical deleted rows.
func migrateTaskContainerRemoval(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	statements := []string{
		`CREATE TABLE IF NOT EXISTS task_container_removal_operations (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			operation_id UUID NOT NULL, actor_id UUID NOT NULL,
			target_type TEXT NOT NULL CHECK(target_type IN ('list','folder')),
			target_id UUID NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('trash_all','preserve_contents')),
			request_hash CHAR(64) NOT NULL, result_json JSONB NOT NULL,
			whiteboard_ids UUID[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			restored_at TIMESTAMPTZ, PRIMARY KEY(account_id,operation_id))`,
		`CREATE INDEX IF NOT EXISTS idx_task_container_removal_target ON task_container_removal_operations(account_id,target_type,target_id,created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS task_container_removal_items (
			account_id UUID NOT NULL, operation_id UUID NOT NULL,
			resource_type TEXT NOT NULL CHECK(resource_type IN ('list','folder','task','event','task_reminder')),
			resource_id UUID NOT NULL, previous_state JSONB NOT NULL DEFAULT '{}',
			PRIMARY KEY(account_id,operation_id,resource_type,resource_id),
			FOREIGN KEY(account_id,operation_id) REFERENCES task_container_removal_operations(account_id,operation_id) ON DELETE CASCADE)`,
	}
	for _, table := range []string{"task_folders", "task_lists", "tasks", "work_events"} {
		statements = append(statements, `ALTER TABLE `+table+` ADD COLUMN IF NOT EXISTS trash_operation_id UUID`,
			`CREATE INDEX IF NOT EXISTS idx_`+table+`_trash_operation ON `+table+`(account_id,trash_operation_id) WHERE trash_operation_id IS NOT NULL`,
			`DO $$ BEGIN ALTER TABLE `+table+` ADD CONSTRAINT `+table+`_trash_operation_account_fk FOREIGN KEY(account_id,trash_operation_id) REFERENCES task_container_removal_operations(account_id,operation_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$`)
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task container removal migration: %w", err)
		}
	}
	return tx.Commit(ctx)
}
