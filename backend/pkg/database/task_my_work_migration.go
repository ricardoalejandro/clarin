package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskMyWork adds the private, date-keyed personal planning layer used
// by "Mi trabajo". A focus item points to its canonical task; it never copies
// or changes the task's list, status, shared priority, or durable list order.
func migrateTaskMyWork(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS task_focus_days (
			account_id UUID NOT NULL,
			user_id UUID NOT NULL,
			focus_date DATE NOT NULL,
			revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (account_id,user_id,focus_date),
			CONSTRAINT task_focus_days_account_user_fk
				FOREIGN KEY (account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS task_focus_items (
			account_id UUID NOT NULL,
			user_id UUID NOT NULL,
			focus_date DATE NOT NULL,
			task_id UUID NOT NULL,
			position BIGINT NOT NULL CHECK (position > 0),
			added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (account_id,user_id,focus_date,task_id),
			CONSTRAINT task_focus_items_day_fk
				FOREIGN KEY (account_id,user_id,focus_date)
				REFERENCES task_focus_days(account_id,user_id,focus_date) ON DELETE CASCADE,
			CONSTRAINT task_focus_items_task_fk
				FOREIGN KEY (account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_focus_items_personal_order
			ON task_focus_items(account_id,user_id,focus_date,position,task_id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_focus_items_previous_days
			ON task_focus_items(account_id,user_id,focus_date DESC,task_id)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_my_work_assigned_due
			ON tasks(account_id,assigned_to,due_at,id) WHERE deleted_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS task_focus_operations (
			account_id UUID NOT NULL,
			user_id UUID NOT NULL,
			focus_date DATE NOT NULL,
			operation_id UUID NOT NULL,
			action VARCHAR(24) NOT NULL,
			result_revision BIGINT NOT NULL CHECK (result_revision >= 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (account_id,user_id,focus_date,operation_id),
			CONSTRAINT task_focus_operations_day_fk
				FOREIGN KEY (account_id,user_id,focus_date)
				REFERENCES task_focus_days(account_id,user_id,focus_date) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_focus_operations_created_at
			ON task_focus_operations(account_id,user_id,focus_date,created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task my work migration failed: %w", err)
		}
	}
	return nil
}
