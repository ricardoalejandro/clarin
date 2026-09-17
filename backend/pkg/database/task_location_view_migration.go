package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// taskLocationViewMigrations adds location-owned Work views without folding
// them into task_saved_views. The base table is intentionally generic; each
// concrete view type owns a subtype table so future integrations cannot attach
// an arbitrary resource ID without an account-scoped foreign key.
func taskLocationViewMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS task_location_views (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			environment_id UUID NOT NULL,
			folder_id UUID,
			list_id UUID,
			view_type VARCHAR(32) NOT NULL,
			sort_order BIGINT NOT NULL DEFAULT 0,
			version BIGINT NOT NULL DEFAULT 1,
			access_revision BIGINT NOT NULL DEFAULT 1,
			created_by UUID,
			deleted_at TIMESTAMPTZ,
			deleted_by UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_location_views_scope_check CHECK ((folder_id IS NULL) <> (list_id IS NULL)),
			CONSTRAINT task_location_views_type_check CHECK (view_type IN ('whiteboard')),
			CONSTRAINT task_location_views_sort_order_check CHECK (sort_order>=0),
			CONSTRAINT task_location_views_version_check CHECK (version>0),
			CONSTRAINT task_location_views_access_revision_check CHECK (access_revision>0),
			FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(account_id,environment_id,folder_id) REFERENCES task_folders(account_id,environment_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(account_id,environment_id,list_id) REFERENCES task_lists(account_id,environment_id,id) ON DELETE RESTRICT
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_location_views_account_id
			ON task_location_views(account_id,id)`,
		`ALTER TABLE task_location_views ADD COLUMN IF NOT EXISTS visibility_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'`,
		`DO $$ BEGIN
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='task_location_views_visibility_mode_check'
				  AND conrelid='task_location_views'::regclass
			) THEN
				ALTER TABLE task_location_views ADD CONSTRAINT task_location_views_visibility_mode_check
					CHECK (visibility_mode IN ('inherit','restricted'));
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_location_views_folder_order
			ON task_location_views(account_id,environment_id,folder_id,deleted_at,sort_order,id)
			WHERE folder_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_location_views_list_order
			ON task_location_views(account_id,environment_id,list_id,deleted_at,sort_order,id)
			WHERE list_id IS NOT NULL`,
		`DO $$ BEGIN ALTER TABLE task_location_views ADD CONSTRAINT task_location_views_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_location_views ADD CONSTRAINT task_location_views_deleted_by_account_fk
			FOREIGN KEY(account_id,deleted_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (deleted_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

		`CREATE TABLE IF NOT EXISTS task_location_whiteboard_views (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_view_id UUID NOT NULL,
			whiteboard_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(task_view_id),
			UNIQUE(account_id,task_view_id),
			UNIQUE(account_id,whiteboard_id),
			FOREIGN KEY(account_id,task_view_id) REFERENCES task_location_views(account_id,id) ON DELETE RESTRICT,
			FOREIGN KEY(account_id,whiteboard_id) REFERENCES whiteboards(account_id,id) ON DELETE RESTRICT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_location_whiteboard_views_board
			ON task_location_whiteboard_views(account_id,whiteboard_id)`,

		`CREATE TABLE IF NOT EXISTS task_location_view_visibility_members (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_view_id UUID NOT NULL,
			user_id UUID NOT NULL,
			created_by UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(account_id,task_view_id,user_id),
			FOREIGN KEY(account_id,task_view_id) REFERENCES task_location_views(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`DO $$ BEGIN ALTER TABLE task_location_view_visibility_members ADD CONSTRAINT task_location_view_visibility_members_created_by_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_location_view_visibility_members_user
			ON task_location_view_visibility_members(account_id,user_id,task_view_id)`,

		`CREATE TABLE IF NOT EXISTS task_location_view_operations (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			actor_id UUID NOT NULL,
			operation_id UUID NOT NULL,
			action VARCHAR(32) NOT NULL,
			request_payload_hash CHAR(64) NOT NULL,
			result_task_view_id UUID NOT NULL,
			result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_location_view_operations_action_check CHECK (action IN ('create','update','duplicate','trash','restore')),
			UNIQUE(account_id,actor_id,operation_id),
			FOREIGN KEY(account_id,result_task_view_id) REFERENCES task_location_views(account_id,id) ON DELETE CASCADE
		)`,
		// Operation rows are an idempotency cache, not audit history. Invalid
		// pre-release NULL actors cannot deduplicate and are safe to discard while
		// preserving their canonical views. Membership removal must remain possible,
		// so the composite actor FK cascades only these replay rows.
		`DELETE FROM task_location_view_operations WHERE actor_id IS NULL`,
		`ALTER TABLE task_location_view_operations ALTER COLUMN actor_id SET NOT NULL`,
		`DO $$ BEGIN
			IF EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='task_location_view_operations_actor_account_fk'
				  AND conrelid='task_location_view_operations'::regclass
				  AND pg_get_constraintdef(oid) NOT ILIKE '%ON DELETE CASCADE%'
			) THEN
				ALTER TABLE task_location_view_operations DROP CONSTRAINT task_location_view_operations_actor_account_fk;
			END IF;
			IF NOT EXISTS (
				SELECT 1 FROM pg_constraint
				WHERE conname='task_location_view_operations_actor_account_fk'
				  AND conrelid='task_location_view_operations'::regclass
			) THEN
				ALTER TABLE task_location_view_operations ADD CONSTRAINT task_location_view_operations_actor_account_fk
					FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE;
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_location_view_operations_result
			ON task_location_view_operations(account_id,result_task_view_id,created_at DESC)`,
		`ALTER TABLE task_location_view_operations DROP CONSTRAINT IF EXISTS task_location_view_operations_action_check`,
		`ALTER TABLE task_location_view_operations ADD CONSTRAINT task_location_view_operations_action_check
			CHECK (action IN ('create','update','duplicate','trash','restore','replace_visibility'))`,
	}
}

func migrateTaskLocationViews(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin task location view migration: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, statement := range taskLocationViewMigrations() {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task location view migration failed: %w\nSQL: %s", err, statement)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit task location view migration: %w", err)
	}
	return nil
}
