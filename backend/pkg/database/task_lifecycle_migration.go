package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskContainerLifecycle separates historical archive state from Trash.
// Before this migration task_lists.archived_at and task_folders.archived_at
// represented Trash. The marker makes that legacy conversion exactly-once:
// later archived rows must remain historical rows on every subsequent startup.
func migrateTaskContainerLifecycle(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin task container lifecycle migration: %w", err)
	}
	defer tx.Rollback(ctx)

	statements := []string{
		`CREATE TABLE IF NOT EXISTS task_schema_migrations (
			key TEXT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`ALTER TABLE task_environments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
		`ALTER TABLE task_environments ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS deleted_with_folder BOOLEAN NOT NULL DEFAULT FALSE`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("apply task container lifecycle schema: %w", err)
		}
	}

	var marker string
	err = tx.QueryRow(ctx, `INSERT INTO task_schema_migrations(key)
		VALUES('separate_archive_from_trash_v1') ON CONFLICT DO NOTHING RETURNING key`).Scan(&marker)
	switch err {
	case nil:
		if _, err := tx.Exec(ctx, `UPDATE task_lists
			SET deleted_at=archived_at,deleted_with_folder=archived_with_folder,
				archived_at=NULL,archived_with_folder=FALSE
			WHERE archived_at IS NOT NULL AND deleted_at IS NULL`); err != nil {
			return fmt.Errorf("convert legacy task list trash: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE task_folders
			SET deleted_at=archived_at,archived_at=NULL
			WHERE archived_at IS NOT NULL AND deleted_at IS NULL`); err != nil {
			return fmt.Errorf("convert legacy task folder trash: %w", err)
		}
	case pgx.ErrNoRows:
		// Already converted by a committed previous startup.
	default:
		return fmt.Errorf("claim task lifecycle migration: %w", err)
	}

	indexes := []string{
		`DROP INDEX IF EXISTS uq_task_environments_default`,
		`CREATE UNIQUE INDEX uq_task_environments_default ON task_environments(account_id) WHERE is_default AND archived_at IS NULL AND deleted_at IS NULL`,
		`DROP INDEX IF EXISTS uq_task_environments_active_name`,
		`CREATE UNIQUE INDEX uq_task_environments_active_name ON task_environments(account_id,LOWER(name)) WHERE archived_at IS NULL AND deleted_at IS NULL`,
		`DROP INDEX IF EXISTS uq_task_lists_default`,
		`CREATE UNIQUE INDEX uq_task_lists_default ON task_lists(account_id,environment_id) WHERE is_default AND archived_at IS NULL AND deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_environments_lifecycle ON task_environments(account_id,deleted_at,archived_at,sort_order,id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_folders_lifecycle ON task_folders(account_id,environment_id,deleted_at,archived_at,sort_order,id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_lists_lifecycle ON task_lists(account_id,environment_id,folder_id,deleted_at,archived_at,sort_order,id)`,
	}
	for _, statement := range indexes {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("apply task lifecycle index: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task container lifecycle migration: %w", err)
	}
	return nil
}
