package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskWork upgrades the legacy agenda-style task model into the
// account-scoped Clarin Work hierarchy. It is intentionally additive so the
// legacy dashboard and CRM task surfaces can keep reading the same rows while
// the richer UI is rolled out.
func migrateTaskWork(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS task_lists (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			color TEXT NOT NULL DEFAULT '',
			sort_order INT NOT NULL DEFAULT 0,
			created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_lists_account_id ON task_lists(account_id)`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS list_id UUID REFERENCES task_lists(id) ON DELETE SET NULL`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS starred BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 0`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_list_id ON tasks(list_id) WHERE list_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_starred ON tasks(account_id,starred) WHERE starred`,
		`CREATE TABLE IF NOT EXISTS task_workflows (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			is_default BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(account_id, name)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_workflows_account_id ON task_workflows(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_workflows_default ON task_workflows(account_id) WHERE is_default`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_account_user_task_work ON user_accounts(account_id, user_id)`,
		`CREATE TABLE IF NOT EXISTS task_statuses (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			workflow_id UUID NOT NULL REFERENCES task_workflows(id) ON DELETE CASCADE,
			name TEXT NOT NULL,
			color VARCHAR(20) NOT NULL DEFAULT '#64748b',
			category VARCHAR(20) NOT NULL DEFAULT 'not_started',
			sort_order INT NOT NULL DEFAULT 0,
			is_default BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_statuses_category_check CHECK (category IN ('not_started','active','done','cancelled')),
			UNIQUE(workflow_id, name)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_statuses_account_id ON task_statuses(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_statuses_default ON task_statuses(workflow_id) WHERE is_default`,
		`CREATE INDEX IF NOT EXISTS idx_task_statuses_workflow_order ON task_statuses(account_id, workflow_id, sort_order)`,
		`CREATE TABLE IF NOT EXISTS task_folders (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			workflow_id UUID REFERENCES task_workflows(id) ON DELETE RESTRICT,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			color VARCHAR(20) NOT NULL DEFAULT '#10b981',
			sort_order INT NOT NULL DEFAULT 0,
			created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			archived_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_folders_account_id ON task_folders(account_id, id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_folders_account_order ON task_folders(account_id, archived_at, sort_order)`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES task_folders(id) ON DELETE SET NULL`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES task_workflows(id) ON DELETE RESTRICT`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS workflow_inherited BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_lists_account_id ON task_lists(account_id, id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_lists_folder_order ON task_lists(account_id, folder_id, archived_at, sort_order)`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_id UUID REFERENCES task_statuses(id) ON DELETE RESTRICT`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_all_day BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS overdue_notified_at TIMESTAMPTZ`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS legacy_subtask_id UUID`,
		`DO $$ BEGIN
			ALTER TABLE tasks ADD CONSTRAINT tasks_progress_check CHECK (progress BETWEEN 0 AND 100);
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_account_id ON tasks(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_legacy_subtask ON tasks(account_id, legacy_subtask_id) WHERE legacy_subtask_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_parent ON tasks(account_id, parent_task_id, deleted_at)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_status_due ON tasks(account_id, status_id, due_at) WHERE deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_list_order_v2 ON tasks(account_id, list_id, sort_order) WHERE deleted_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_recurring_occurrence ON tasks(account_id, recurrence_parent_id, due_at) WHERE recurrence_parent_id IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS task_collaborators (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(task_id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_collaborators_user ON task_collaborators(account_id, user_id, task_id)`,
		`CREATE TABLE IF NOT EXISTS task_dependencies (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			predecessor_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			successor_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			dependency_type VARCHAR(20) NOT NULL DEFAULT 'finish_to_start',
			lag_minutes INT NOT NULL DEFAULT 0,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_dependencies_not_self CHECK (predecessor_task_id <> successor_task_id),
			CONSTRAINT task_dependencies_type_check CHECK (dependency_type='finish_to_start'),
			UNIQUE(predecessor_task_id, successor_task_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_dependencies_successor ON task_dependencies(account_id, successor_task_id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_dependencies_predecessor ON task_dependencies(account_id, predecessor_task_id)`,
		`CREATE TABLE IF NOT EXISTS task_comments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			body TEXT NOT NULL,
			edited_at TIMESTAMPTZ,
			deleted_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_comments_task_created ON task_comments(account_id, task_id, created_at) WHERE deleted_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS task_activity (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			action VARCHAR(50) NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_activity_task_created ON task_activity(account_id, task_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS task_attachments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
			media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
			uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(task_id, media_asset_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachments_task ON task_attachments(account_id, task_id, created_at)`,
		`DO $$ BEGIN ALTER TABLE task_statuses ADD CONSTRAINT task_statuses_workflow_account_fk
			FOREIGN KEY (account_id,workflow_id) REFERENCES task_workflows(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_folders ADD CONSTRAINT task_folders_workflow_account_fk
			FOREIGN KEY (account_id,workflow_id) REFERENCES task_workflows(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_folder_account_fk
			FOREIGN KEY (account_id,folder_id) REFERENCES task_folders(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_workflow_account_fk
			FOREIGN KEY (account_id,workflow_id) REFERENCES task_workflows(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_list_account_fk
			FOREIGN KEY (account_id,list_id) REFERENCES task_lists(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_status_account_fk
			FOREIGN KEY (account_id,status_id) REFERENCES task_statuses(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_parent_account_fk
			FOREIGN KEY (account_id,parent_task_id) REFERENCES tasks(account_id,id) NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_collaborators ADD CONSTRAINT task_collaborators_task_account_fk
			FOREIGN KEY (account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_collaborators ADD CONSTRAINT task_collaborators_membership_fk
			FOREIGN KEY (account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_predecessor_account_fk
			FOREIGN KEY (account_id,predecessor_task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_dependencies ADD CONSTRAINT task_dependencies_successor_account_fk
			FOREIGN KEY (account_id,successor_task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_comments ADD CONSTRAINT task_comments_task_account_fk
			FOREIGN KEY (account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_activity ADD CONSTRAINT task_activity_task_account_fk
			FOREIGN KEY (account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_task_account_fk
			FOREIGN KEY (account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_attachments ADD CONSTRAINT task_attachments_media_account_fk
			FOREIGN KEY (account_id,media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT NOT VALID;
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE OR REPLACE FUNCTION ensure_account_task_workflow() RETURNS TRIGGER AS $$
		DECLARE workflow_uuid UUID;
		BEGIN
			INSERT INTO task_workflows(account_id,name,is_default)
			VALUES(NEW.id,'Flujo general',TRUE)
			ON CONFLICT(account_id,name) DO UPDATE SET is_default=TRUE,updated_at=NOW()
			RETURNING id INTO workflow_uuid;
			INSERT INTO task_statuses(account_id,workflow_id,name,color,category,sort_order,is_default)
			VALUES
				(NEW.id,workflow_uuid,'Por hacer','#64748b','not_started',0,TRUE),
				(NEW.id,workflow_uuid,'En curso','#3b82f6','active',1,FALSE),
				(NEW.id,workflow_uuid,'Completada','#10b981','done',2,FALSE),
				(NEW.id,workflow_uuid,'Cancelada','#ef4444','cancelled',3,FALSE)
			ON CONFLICT(workflow_id,name) DO NOTHING;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_accounts_task_workflow') THEN
				CREATE TRIGGER trg_accounts_task_workflow AFTER INSERT ON accounts
				FOR EACH ROW EXECUTE FUNCTION ensure_account_task_workflow();
			END IF;
		END $$`,
	}

	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task work schema migration failed: %w\nSQL: %s", err, statement)
		}
	}

	// Every account receives a reusable default workflow. Folder/list overrides
	// can point at another workflow, but legacy root lists use this default.
	if _, err := db.Exec(ctx, `
		INSERT INTO task_workflows (account_id, name, is_default)
		SELECT a.id, 'Flujo general', TRUE
		FROM accounts a
		WHERE NOT EXISTS (SELECT 1 FROM task_workflows w WHERE w.account_id=a.id AND w.is_default)
		ON CONFLICT (account_id,name) DO UPDATE SET is_default=TRUE,updated_at=NOW()
	`); err != nil {
		return fmt.Errorf("task work default workflow migration failed: %w", err)
	}

	if _, err := db.Exec(ctx, `
		INSERT INTO task_statuses (account_id, workflow_id, name, color, category, sort_order, is_default)
		SELECT w.account_id, w.id, seed.name, seed.color, seed.category, seed.sort_order,
			CASE WHEN seed.is_default AND NOT EXISTS (SELECT 1 FROM task_statuses existing_default WHERE existing_default.workflow_id=w.id AND existing_default.is_default) THEN TRUE ELSE FALSE END
		FROM task_workflows w
		CROSS JOIN (VALUES
			('Por hacer', '#64748b', 'not_started', 0, TRUE),
			('En curso', '#3b82f6', 'active', 1, FALSE),
			('Completada', '#10b981', 'done', 2, FALSE),
			('Cancelada', '#ef4444', 'cancelled', 3, FALSE)
		) AS seed(name,color,category,sort_order,is_default)
		WHERE w.is_default
		  AND NOT EXISTS (SELECT 1 FROM task_statuses s WHERE s.workflow_id=w.id AND s.name=seed.name)
	`); err != nil {
		return fmt.Errorf("task work default statuses migration failed: %w", err)
	}

	if _, err := db.Exec(ctx, `
		UPDATE task_lists l
		SET workflow_id=w.id
		FROM task_workflows w
		WHERE w.account_id=l.account_id AND w.is_default AND l.workflow_id IS NULL
	`); err != nil {
		return fmt.Errorf("task list workflow backfill failed: %w", err)
	}

	if _, err := db.Exec(ctx, `
		UPDATE tasks t SET status_id=(
			SELECT s.id FROM task_workflows w
			JOIN task_statuses s ON s.workflow_id=w.id AND s.account_id=w.account_id
			WHERE w.account_id=t.account_id AND w.is_default
			  AND s.category=CASE t.status
				WHEN 'completed' THEN 'done'
				WHEN 'cancelled' THEN 'cancelled'
				ELSE 'not_started'
			  END
			ORDER BY s.is_default DESC,s.sort_order LIMIT 1
		)
		WHERE t.status_id IS NULL
	`); err != nil {
		return fmt.Errorf("task status backfill failed: %w", err)
	}

	// The legacy due_end_at field was never used by the deployed UI. If an
	// external client did provide it, retain its range semantics in start/due.
	if _, err := db.Exec(ctx, `
		UPDATE tasks
		SET start_at=due_at, due_at=due_end_at
		WHERE due_end_at IS NOT NULL AND start_at IS NULL
	`); err != nil {
		return fmt.Errorf("task date range backfill failed: %w", err)
	}

	// Promote legacy checklist rows into full child tasks while retaining the
	// old rows for compatibility during rollout.
	if _, err := db.Exec(ctx, `
		INSERT INTO tasks (
			id, account_id, created_by, assigned_to, title, description, type,
			priority, status, status_id, completed_at, completed_by, list_id,
			parent_task_id, progress, legacy_subtask_id, sort_order, created_at, updated_at
		)
		SELECT
			s.id, s.account_id, p.created_by, p.assigned_to, s.title, '', 'reminder',
			p.priority, CASE WHEN s.completed THEN 'completed' ELSE 'pending' END,
			status_match.id, s.completed_at,
			CASE WHEN s.completed THEN p.assigned_to ELSE NULL END,
			p.list_id, p.id, CASE WHEN s.completed THEN 100 ELSE 0 END,
			s.id, s.sort_order, s.created_at, s.updated_at
		FROM subtasks s
		JOIN tasks p ON p.id=s.task_id AND p.account_id=s.account_id
		JOIN task_workflows w ON w.account_id=s.account_id AND w.is_default
		JOIN LATERAL (
			SELECT candidate.id FROM task_statuses candidate
			WHERE candidate.workflow_id=w.id AND candidate.account_id=w.account_id
			  AND candidate.category=CASE WHEN s.completed THEN 'done' ELSE 'not_started' END
			ORDER BY candidate.is_default DESC,candidate.sort_order LIMIT 1
		) status_match ON TRUE
		WHERE NOT EXISTS (SELECT 1 FROM tasks existing WHERE existing.account_id=s.account_id AND existing.legacy_subtask_id=s.id)
		  AND NOT EXISTS (SELECT 1 FROM tasks collision WHERE collision.id=s.id)
	`); err != nil {
		return fmt.Errorf("legacy subtask promotion failed: %w", err)
	}

	return nil
}
