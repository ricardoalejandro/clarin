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
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS task_trash_retention_days SMALLINT DEFAULT 30`,
		`DO $$ BEGIN ALTER TABLE accounts ADD CONSTRAINT accounts_task_trash_retention_days_check
			CHECK (task_trash_retention_days IS NULL OR task_trash_retention_days BETWEEN 7 AND 365);
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
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
		`DELETE FROM task_reminders WHERE id IN (
			SELECT id FROM (
				SELECT id,ROW_NUMBER() OVER(PARTITION BY task_id ORDER BY delivered ASC,reminder_at DESC,id DESC) AS position
				FROM task_reminders
			) ranked WHERE ranked.position>1
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_reminders_task_id ON task_reminders(task_id)`,
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
			color VARCHAR(20) NOT NULL DEFAULT '#64748B',
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
			color VARCHAR(20) NOT NULL DEFAULT '#10B981',
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
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS archived_with_folder BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'list'`,
		`UPDATE task_lists SET icon=CASE WHEN is_default THEN 'inbox' ELSE 'list' END
		 WHERE icon IS NULL OR BTRIM(icon)='' OR icon NOT IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench')`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'folder'`,
		`UPDATE task_folders SET icon='folder'
		 WHERE icon IS NULL OR BTRIM(icon)='' OR icon NOT IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench')`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_icon_check
			CHECK (icon IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench'));
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_folders ADD CONSTRAINT task_folders_icon_check
			CHECK (icon IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench'));
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE task_lists DROP CONSTRAINT IF EXISTS task_lists_icon_check`,
		`ALTER TABLE task_lists ADD CONSTRAINT task_lists_icon_check CHECK (icon IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench'))`,
		`ALTER TABLE task_folders DROP CONSTRAINT IF EXISTS task_folders_icon_check`,
		`ALTER TABLE task_folders ADD CONSTRAINT task_folders_icon_check CHECK (icon IN ('inbox','list','folder','briefcase','rocket','target','users','megaphone','graduation-cap','building','clipboard-list','layers','calendar','flag','phone','message-circle','bell','check-square','archive','award','book-open','box','brain','bug','camera','money','cloud','code','coffee','compass','file-text','gem','gift','globe','heart','home','key','laptop','lightbulb','link','lock','map-pin','package','palette','plane','settings','shield','shopping-cart','sparkles','star','store','tag','thumbs-up','trophy','truck','user','video','wallet','wrench'))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_lists_account_id ON task_lists(account_id, id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_lists_default ON task_lists(account_id) WHERE is_default AND archived_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_lists_folder_order ON task_lists(account_id, folder_id, archived_at, sort_order)`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS status_id UUID REFERENCES task_statuses(id) ON DELETE RESTRICT`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_all_day BOOLEAN NOT NULL DEFAULT FALSE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id UUID REFERENCES tasks(id) ON DELETE CASCADE`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress SMALLINT NOT NULL DEFAULT 0`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS progress_mode VARCHAR(16) NOT NULL DEFAULT 'manual'`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS manual_progress SMALLINT NOT NULL DEFAULT 0`,
		`UPDATE tasks SET manual_progress=LEAST(100,GREATEST(0,COALESCE(progress,0)))
		 WHERE manual_progress=0 AND COALESCE(progress,0)<>0`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_progress_mode_check CHECK (progress_mode IN ('manual','automatic'));
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_manual_progress_check CHECK (manual_progress BETWEEN 0 AND 100);
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
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
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_board_order ON tasks(account_id, list_id, sort_order, id) WHERE deleted_at IS NULL AND parent_task_id IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_child_order ON tasks(account_id, parent_task_id, sort_order, id) WHERE deleted_at IS NULL AND parent_task_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_created_filter ON tasks(account_id, created_at, id) WHERE deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_completed_filter ON tasks(account_id, completed_at, id) WHERE deleted_at IS NULL AND completed_at IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_priority_filter ON tasks(account_id, priority) WHERE deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_type_filter ON tasks(account_id, type) WHERE deleted_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_account_creator_filter ON tasks(account_id, created_by) WHERE deleted_at IS NULL`,
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
		`CREATE TABLE IF NOT EXISTS task_media_gc_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
			object_key TEXT NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			attempts INT NOT NULL DEFAULT 0,
			available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			claim_token UUID,
			last_error TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_media_gc_jobs_status_check CHECK (status IN ('pending','processing')),
			UNIQUE(account_id,media_asset_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_media_gc_jobs_due
			ON task_media_gc_jobs(available_at,id) WHERE status='pending'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_comments_account_task_id ON task_comments(account_id,task_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_attachments_account_task_id ON task_attachments(account_id,task_id,id)`,
		`CREATE TABLE IF NOT EXISTS task_comment_mentions (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL,
			comment_id UUID NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(comment_id,user_id),
			FOREIGN KEY(account_id,task_id,comment_id) REFERENCES task_comments(account_id,task_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_comment_mentions_user ON task_comment_mentions(account_id,user_id,created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS task_comment_attachments (
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL,
			comment_id UUID NOT NULL,
			attachment_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(comment_id,attachment_id),
			FOREIGN KEY(account_id,task_id,comment_id) REFERENCES task_comments(account_id,task_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,task_id,attachment_id) REFERENCES task_attachments(account_id,task_id,id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_comment_attachments_comment ON task_comment_attachments(account_id,task_id,comment_id,created_at)`,
		`CREATE TABLE IF NOT EXISTS task_saved_views (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			name VARCHAR(120) NOT NULL,
			scope_type VARCHAR(20) NOT NULL DEFAULT 'all',
			scope_id UUID,
			view_mode VARCHAR(20) NOT NULL DEFAULT 'board',
			filters JSONB NOT NULL DEFAULT '{}',
			collapsed_status_ids TEXT[] NOT NULL DEFAULT '{}',
			is_default BOOLEAN NOT NULL DEFAULT FALSE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_saved_views_scope_check CHECK (scope_type IN ('all','folder','list')),
			CONSTRAINT task_saved_views_mode_check CHECK (view_mode IN ('list','board','calendar','gantt','summary')),
			CONSTRAINT task_saved_views_scope_id_check CHECK (
				(scope_type='all' AND scope_id IS NULL) OR
				(scope_type IN ('folder','list') AND scope_id IS NOT NULL)
			),
			UNIQUE(account_id,user_id,name),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`ALTER TABLE task_saved_views ADD COLUMN IF NOT EXISTS group_by VARCHAR(24) NOT NULL DEFAULT 'status'`,
		`ALTER TABLE task_saved_views ADD COLUMN IF NOT EXISTS group_direction VARCHAR(8) NOT NULL DEFAULT 'asc'`,
		`ALTER TABLE task_saved_views ADD COLUMN IF NOT EXISTS collapsed_group_keys TEXT[] NOT NULL DEFAULT '{}'`,
		`DO $$ BEGIN ALTER TABLE task_saved_views ADD CONSTRAINT task_saved_views_group_by_check
			CHECK (group_by IN ('none','status','list','assignee','priority','type','due'));
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_saved_views ADD CONSTRAINT task_saved_views_group_direction_check
			CHECK (group_direction IN ('asc','desc'));
			EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`UPDATE task_saved_views SET collapsed_group_keys=collapsed_status_ids
		 WHERE COALESCE(array_length(collapsed_group_keys,1),0)=0 AND COALESCE(array_length(collapsed_status_ids,1),0)>0`,
		`CREATE TABLE IF NOT EXISTS task_attachment_previews (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL,
			attachment_id UUID NOT NULL,
			kind VARCHAR(20) NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			derivative_asset_id UUID,
			page_count INT NOT NULL DEFAULT 0,
			error TEXT NOT NULL DEFAULT '',
			version BIGINT NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(account_id,attachment_id),
			FOREIGN KEY(account_id,task_id,attachment_id) REFERENCES task_attachments(account_id,task_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,derivative_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT,
			CONSTRAINT task_attachment_previews_kind_check CHECK (kind IN ('image','pdf','text','word_pdf','unsupported')),
			CONSTRAINT task_attachment_previews_status_check CHECK (status IN ('pending','processing','ready','failed','unsupported'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachment_previews_task ON task_attachment_previews(account_id,task_id,created_at)`,
		`CREATE TABLE IF NOT EXISTS task_attachment_preview_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			preview_id UUID NOT NULL REFERENCES task_attachment_previews(id) ON DELETE CASCADE,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			attempts INT NOT NULL DEFAULT 0,
			available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			locked_at TIMESTAMPTZ,
			locked_by TEXT,
			last_error TEXT NOT NULL DEFAULT '',
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(preview_id),
			CONSTRAINT task_attachment_preview_jobs_status_check CHECK (status IN ('pending','processing','complete','failed'))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachment_preview_jobs_queue ON task_attachment_preview_jobs(status,available_at)`,
		`CREATE TABLE IF NOT EXISTS task_attachment_comments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			task_id UUID NOT NULL,
			attachment_id UUID NOT NULL,
			parent_id UUID REFERENCES task_attachment_comments(id) ON DELETE CASCADE,
			author_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			body TEXT NOT NULL,
			anchor JSONB NOT NULL DEFAULT '{}',
			resolved_at TIMESTAMPTZ,
			resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
			deleted_at TIMESTAMPTZ,
			version BIGINT NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE(account_id,task_id,attachment_id,id),
			FOREIGN KEY(account_id,task_id,attachment_id) REFERENCES task_attachments(account_id,task_id,id) ON DELETE CASCADE
		)`,
		`ALTER TABLE task_attachment_comments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachment_comments_feed ON task_attachment_comments(account_id,task_id,attachment_id,created_at,id) WHERE deleted_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS task_attachment_comment_mentions (
			comment_id UUID NOT NULL REFERENCES task_attachment_comments(id) ON DELETE CASCADE,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(comment_id,user_id),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE
		)`,
		`DO $$ BEGIN
			IF EXISTS (
				SELECT 1 FROM information_schema.columns
				WHERE table_schema='public' AND table_name='task_saved_views'
				  AND column_name='collapsed_status_ids' AND udt_name='_uuid'
			) THEN
				ALTER TABLE task_saved_views ALTER COLUMN collapsed_status_ids DROP DEFAULT;
				ALTER TABLE task_saved_views ALTER COLUMN collapsed_status_ids TYPE TEXT[] USING collapsed_status_ids::text[];
				ALTER TABLE task_saved_views ALTER COLUMN collapsed_status_ids SET DEFAULT '{}'::text[];
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_saved_views_owner ON task_saved_views(account_id,user_id,updated_at DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_saved_views_default ON task_saved_views(account_id,user_id) WHERE is_default`,
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
				(NEW.id,workflow_uuid,'Por hacer','#64748B','not_started',0,TRUE),
				(NEW.id,workflow_uuid,'En curso','#3B82F6','active',1,FALSE),
				(NEW.id,workflow_uuid,'Completada','#10B981','done',2,FALSE),
				(NEW.id,workflow_uuid,'Cancelada','#EF4444','cancelled',3,FALSE)
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
		`CREATE OR REPLACE FUNCTION ensure_account_task_default_list() RETURNS TRIGGER AS $$
		BEGIN
			INSERT INTO task_lists(account_id,workflow_id,workflow_inherited,name,description,color,icon,sort_order,created_by,is_default)
			SELECT NEW.account_id,w.id,TRUE,'Bandeja general','Tareas sin una lista específica','#10B981','inbox',0,NEW.user_id,TRUE
			FROM task_workflows w
			WHERE w.account_id=NEW.account_id AND w.is_default
			ON CONFLICT (account_id) WHERE is_default AND archived_at IS NULL DO NOTHING;
			RETURN NEW;
		END;
		$$ LANGUAGE plpgsql`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_user_accounts_task_default_list') THEN
				CREATE TRIGGER trg_user_accounts_task_default_list AFTER INSERT ON user_accounts
				FOR EACH ROW EXECUTE FUNCTION ensure_account_task_default_list();
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
			('Por hacer', '#64748B', 'not_started', 0, TRUE),
			('En curso', '#3B82F6', 'active', 1, FALSE),
			('Completada', '#10B981', 'done', 2, FALSE),
			('Cancelada', '#EF4444', 'cancelled', 3, FALSE)
		) AS seed(name,color,category,sort_order,is_default)
		WHERE w.is_default
		  AND NOT EXISTS (SELECT 1 FROM task_statuses s WHERE s.workflow_id=w.id AND s.name=seed.name)
	`); err != nil {
		return fmt.Errorf("task work default statuses migration failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE task_statuses SET is_default=FALSE,updated_at=NOW()
		WHERE is_default AND category<>'not_started'
	`); err != nil {
		return fmt.Errorf("task work invalid default status repair failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		WITH candidates AS (
			SELECT id,workflow_id,ROW_NUMBER() OVER(PARTITION BY workflow_id ORDER BY sort_order,created_at,id) AS position
			FROM task_statuses WHERE category='not_started'
		), missing AS (
			SELECT candidate.id FROM candidates candidate
			WHERE candidate.position=1 AND NOT EXISTS(
				SELECT 1 FROM task_statuses current_default
				WHERE current_default.workflow_id=candidate.workflow_id AND current_default.is_default
			)
		)
		UPDATE task_statuses status SET is_default=TRUE,updated_at=NOW()
		FROM missing WHERE status.id=missing.id
	`); err != nil {
		return fmt.Errorf("task work missing default status repair failed: %w", err)
	}

	// Reuse an existing root list named Bandeja general when possible, then
	// create exactly one durable default list for every account membership.
	if _, err := db.Exec(ctx, `
		WITH ranked AS (
			SELECT id,account_id,ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at,id) AS position
			FROM task_lists
			WHERE folder_id IS NULL AND archived_at IS NULL AND LOWER(BTRIM(name))='bandeja general'
		), missing AS (
			SELECT ranked.id FROM ranked
			WHERE ranked.position=1
			  AND NOT EXISTS (SELECT 1 FROM task_lists current_default WHERE current_default.account_id=ranked.account_id AND current_default.is_default AND current_default.archived_at IS NULL)
		)
		UPDATE task_lists list SET is_default=TRUE,updated_at=NOW()
		FROM missing WHERE list.id=missing.id
	`); err != nil {
		return fmt.Errorf("task work default list adoption failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO task_lists(account_id,workflow_id,workflow_inherited,name,description,color,icon,sort_order,created_by,is_default)
		SELECT a.id,w.id,TRUE,'Bandeja general','Tareas sin una lista específica','#10B981','inbox',0,owner.user_id,TRUE
		FROM accounts a
		JOIN task_workflows w ON w.account_id=a.id AND w.is_default
		JOIN LATERAL (
			SELECT candidate.user_id
			FROM (
				SELECT ua.user_id,u.created_at FROM user_accounts ua JOIN users u ON u.id=ua.user_id WHERE ua.account_id=a.id
				UNION ALL
				SELECT u.id,u.created_at FROM users u WHERE u.account_id=a.id
			) candidate
			ORDER BY candidate.created_at,candidate.user_id LIMIT 1
		) owner ON TRUE
		WHERE NOT EXISTS (SELECT 1 FROM task_lists existing WHERE existing.account_id=a.id AND existing.is_default AND existing.archived_at IS NULL)
		ON CONFLICT (account_id) WHERE is_default AND archived_at IS NULL DO NOTHING
	`); err != nil {
		return fmt.Errorf("task work default list creation failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE task_lists SET folder_id=NULL,sort_order=0,icon='inbox',updated_at=NOW()
		WHERE is_default AND archived_at IS NULL
	`); err != nil {
		return fmt.Errorf("task work default list root repair failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		WITH ranked AS (
			SELECT id,account_id,folder_id,
				ROW_NUMBER() OVER(PARTITION BY account_id,folder_id ORDER BY sort_order,created_at,id) AS position
			FROM task_lists WHERE NOT is_default AND archived_at IS NULL
		), normalized AS (
			SELECT id,CASE WHEN folder_id IS NULL THEN (position+1)*1024 ELSE position*1024 END AS repaired_order
			FROM ranked
		)
		UPDATE task_lists list SET sort_order=normalized.repaired_order,updated_at=NOW()
		FROM normalized WHERE list.id=normalized.id AND list.sort_order IS DISTINCT FROM normalized.repaired_order
	`); err != nil {
		return fmt.Errorf("task work list hierarchy order repair failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE tasks task SET list_id=list.id,updated_at=NOW()
		FROM task_lists list
		WHERE list.account_id=task.account_id AND list.is_default AND list.archived_at IS NULL
		  AND task.parent_task_id IS NULL AND task.list_id IS NULL
	`); err != nil {
		return fmt.Errorf("task work default list backfill failed: %w", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE tasks child SET list_id=parent.list_id,updated_at=NOW()
		FROM tasks parent
		WHERE child.account_id=parent.account_id AND child.parent_task_id=parent.id
		  AND child.list_id IS DISTINCT FROM parent.list_id
	`); err != nil {
		return fmt.Errorf("task work child list backfill failed: %w", err)
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

	// Legacy clients historically wrote zero-based or repeated positions. Only
	// repair groups that are demonstrably invalid; healthy user-defined order is
	// left untouched. Gaps make normal insertions and board moves inexpensive.
	if _, err := db.Exec(ctx, `
		WITH invalid_groups AS (
			SELECT account_id,list_id,parent_task_id
			FROM tasks
			WHERE deleted_at IS NULL
			GROUP BY account_id,list_id,parent_task_id
			HAVING MIN(sort_order) <= 0 OR COUNT(*) <> COUNT(DISTINCT sort_order)
		), ranked AS (
			SELECT task.id,
				(ROW_NUMBER() OVER (
					PARTITION BY task.account_id,task.list_id,task.parent_task_id
					ORDER BY task.sort_order,task.created_at,task.id
				) * 1024)::int AS repaired_order
			FROM tasks task
			JOIN invalid_groups invalid
			  ON invalid.account_id=task.account_id
			 AND invalid.list_id IS NOT DISTINCT FROM task.list_id
			 AND invalid.parent_task_id IS NOT DISTINCT FROM task.parent_task_id
			WHERE task.deleted_at IS NULL
		)
		UPDATE tasks task SET sort_order=ranked.repaired_order
		FROM ranked WHERE ranked.id=task.id AND task.sort_order IS DISTINCT FROM ranked.repaired_order
	`); err != nil {
		return fmt.Errorf("task board order normalization failed: %w", err)
	}

	return nil
}
