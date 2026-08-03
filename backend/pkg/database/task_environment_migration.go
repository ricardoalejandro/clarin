package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateTaskEnvironments adds the collaboration boundary above folders and
// lists. The migration is deliberately additive: all existing Work data is
// attached to one public/full "General" environment per account, preserving
// every existing identifier, workflow, status, list and task.
func migrateTaskEnvironments(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin task environment migration: %w", err)
	}
	defer tx.Rollback(ctx)

	statements := []string{
		`CREATE TABLE IF NOT EXISTS task_environments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(120) NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			color VARCHAR(20) NOT NULL DEFAULT '#6366F1',
			icon TEXT NOT NULL DEFAULT 'layers',
			sort_order INT NOT NULL DEFAULT 0,
			visibility VARCHAR(20) NOT NULL DEFAULT 'restricted',
			default_access_level VARCHAR(16) NOT NULL DEFAULT 'none',
			is_default BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			archived_at TIMESTAMPTZ,
			version BIGINT NOT NULL DEFAULT 1,
			access_revision BIGINT NOT NULL DEFAULT 1,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_environments_visibility_check CHECK (visibility IN ('account','restricted')),
			CONSTRAINT task_environments_access_check CHECK (default_access_level IN ('none','view','comment','edit','full'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_environments_account_id ON task_environments(account_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_environments_default ON task_environments(account_id) WHERE is_default AND archived_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_environments_active_name ON task_environments(account_id,LOWER(name)) WHERE archived_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_environments_account_order ON task_environments(account_id,archived_at,sort_order,id)`,
		`INSERT INTO task_environments(account_id,name,description,color,icon,sort_order,visibility,default_access_level,is_default,created_by)
		 SELECT account.id,'General','Entorno migrado con el trabajo existente','#6366F1','layers',0,'account','full',TRUE,owner.user_id
		 FROM accounts account
		 LEFT JOIN LATERAL (
			SELECT membership.user_id
			FROM user_accounts membership
			JOIN users account_user ON account_user.id=membership.user_id
			WHERE membership.account_id=account.id
			ORDER BY CASE WHEN membership.role IN ('super_admin','admin') THEN 0 ELSE 1 END,account_user.created_at,membership.user_id
			LIMIT 1
		 ) owner ON TRUE
		 WHERE NOT EXISTS (SELECT 1 FROM task_environments current WHERE current.account_id=account.id AND current.is_default AND current.archived_at IS NULL)
		 ON CONFLICT DO NOTHING`,
		`ALTER TABLE task_workflows ADD COLUMN IF NOT EXISTS environment_id UUID`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS environment_id UUID`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS workflow_inherited BOOLEAN NOT NULL DEFAULT TRUE`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS environment_id UUID`,
		`UPDATE task_workflows workflow SET environment_id=environment.id,updated_at=NOW()
		 FROM task_environments environment
		 WHERE workflow.account_id=environment.account_id AND environment.is_default AND environment.archived_at IS NULL
		   AND workflow.environment_id IS NULL`,
		`UPDATE task_folders folder SET environment_id=COALESCE(workflow.environment_id,environment.id),updated_at=NOW()
		 FROM task_environments environment
		 LEFT JOIN task_workflows workflow ON workflow.account_id=environment.account_id
		 WHERE folder.account_id=environment.account_id AND environment.is_default AND environment.archived_at IS NULL
		   AND (folder.workflow_id IS NULL OR workflow.id=folder.workflow_id) AND folder.environment_id IS NULL`,
		`UPDATE task_lists list_item SET environment_id=COALESCE(folder.environment_id,workflow.environment_id,environment.id),updated_at=NOW()
		 FROM task_environments environment
		 LEFT JOIN task_folders folder ON folder.account_id=environment.account_id
		 LEFT JOIN task_workflows workflow ON workflow.account_id=environment.account_id
		 WHERE list_item.account_id=environment.account_id AND environment.is_default AND environment.archived_at IS NULL
		   AND (list_item.folder_id IS NULL OR folder.id=list_item.folder_id)
		   AND (list_item.workflow_id IS NULL OR workflow.id=list_item.workflow_id)
		   AND list_item.environment_id IS NULL`,
		`UPDATE task_folders folder SET workflow_id=workflow.id,workflow_inherited=TRUE,updated_at=NOW()
		 FROM task_workflows workflow
		 WHERE folder.account_id=workflow.account_id AND folder.environment_id=workflow.environment_id
		   AND workflow.is_default AND folder.workflow_id IS NULL`,
		`UPDATE task_folders folder SET workflow_inherited=(folder.workflow_id=workflow.id)
		 FROM task_workflows workflow
		 WHERE folder.account_id=workflow.account_id AND folder.environment_id=workflow.environment_id AND workflow.is_default`,
		`UPDATE task_lists list_item SET workflow_id=COALESCE(folder.workflow_id,workflow.id),workflow_inherited=TRUE,updated_at=NOW()
		 FROM task_workflows workflow
		 LEFT JOIN task_folders folder ON folder.account_id=workflow.account_id AND folder.environment_id=workflow.environment_id
		 WHERE list_item.account_id=workflow.account_id AND list_item.environment_id=workflow.environment_id AND workflow.is_default
		   AND (list_item.folder_id IS NULL OR folder.id=list_item.folder_id) AND list_item.workflow_id IS NULL`,
		`ALTER TABLE task_workflows ALTER COLUMN environment_id SET NOT NULL`,
		`ALTER TABLE task_folders ALTER COLUMN environment_id SET NOT NULL`,
		`ALTER TABLE task_lists ALTER COLUMN environment_id SET NOT NULL`,
		`ALTER TABLE task_workflows DROP CONSTRAINT IF EXISTS task_workflows_account_id_name_key`,
		`DROP INDEX IF EXISTS uq_task_workflows_default`,
		`DROP INDEX IF EXISTS uq_task_lists_default`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_workflows_environment_name ON task_workflows(account_id,environment_id,name)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_workflows_default ON task_workflows(account_id,environment_id) WHERE is_default`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_workflows_environment_id ON task_workflows(account_id,environment_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_folders_environment_id ON task_folders(account_id,environment_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_lists_environment_id ON task_lists(account_id,environment_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_task_lists_default ON task_lists(account_id,environment_id) WHERE is_default AND archived_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_workflows_environment ON task_workflows(account_id,environment_id,is_default,name,id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_folders_environment_order ON task_folders(account_id,environment_id,archived_at,sort_order,id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_lists_environment_order ON task_lists(account_id,environment_id,folder_id,archived_at,sort_order,id)`,
		`DO $$ BEGIN ALTER TABLE task_workflows ADD CONSTRAINT task_workflows_environment_account_fk
			FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_folders ADD CONSTRAINT task_folders_environment_account_fk
			FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_environment_account_fk
			FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_folders ADD CONSTRAINT task_folders_workflow_environment_fk
			FOREIGN KEY(account_id,environment_id,workflow_id) REFERENCES task_workflows(account_id,environment_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_folder_environment_fk
			FOREIGN KEY(account_id,environment_id,folder_id) REFERENCES task_folders(account_id,environment_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_workflow_environment_fk
			FOREIGN KEY(account_id,environment_id,workflow_id) REFERENCES task_workflows(account_id,environment_id,id) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE task_workflows VALIDATE CONSTRAINT task_workflows_environment_account_fk`,
		`ALTER TABLE task_folders VALIDATE CONSTRAINT task_folders_environment_account_fk`,
		`ALTER TABLE task_lists VALIDATE CONSTRAINT task_lists_environment_account_fk`,
		`ALTER TABLE task_folders VALIDATE CONSTRAINT task_folders_workflow_environment_fk`,
		`ALTER TABLE task_lists VALIDATE CONSTRAINT task_lists_folder_environment_fk`,
		`ALTER TABLE task_lists VALIDATE CONSTRAINT task_lists_workflow_environment_fk`,
		`ALTER TABLE task_saved_views DROP CONSTRAINT IF EXISTS task_saved_views_scope_check`,
		`ALTER TABLE task_saved_views ADD CONSTRAINT task_saved_views_scope_check CHECK (scope_type IN ('all','environment','folder','list'))`,
		`ALTER TABLE task_saved_views DROP CONSTRAINT IF EXISTS task_saved_views_scope_id_check`,
		`ALTER TABLE task_saved_views ADD CONSTRAINT task_saved_views_scope_id_check CHECK (
			(scope_type='all' AND scope_id IS NULL) OR
			(scope_type IN ('environment','folder','list') AND scope_id IS NOT NULL)
		)`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS access_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS access_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'`,
		`ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS access_mode VARCHAR(16) NOT NULL DEFAULT 'inherit'`,
		`ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS access_revision BIGINT NOT NULL DEFAULT 1`,
		`DO $$ BEGIN ALTER TABLE tasks ADD CONSTRAINT tasks_access_mode_check CHECK (access_mode IN ('inherit','private'));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_folders ADD CONSTRAINT task_folders_access_mode_check CHECK (access_mode IN ('inherit','private'));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE task_lists ADD CONSTRAINT task_lists_access_mode_check CHECK (access_mode IN ('inherit','private'));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`UPDATE tasks child SET access_mode='inherit' WHERE child.parent_task_id IS NOT NULL AND child.access_mode<>'inherit'`,
		`CREATE TABLE IF NOT EXISTS task_environment_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			environment_id UUID NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_level VARCHAR(16) NOT NULL,
			can_manage_access BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_environment_grants_level_check CHECK (access_level IN ('none','view','comment','edit','full')),
			CONSTRAINT task_environment_grants_manage_check CHECK (NOT can_manage_access OR access_level='full'),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,environment_id,user_id)
		)`,
		`ALTER TABLE task_environment_grants ALTER COLUMN created_by DROP NOT NULL`,
		`ALTER TABLE task_environment_grants DROP CONSTRAINT IF EXISTS task_environment_grants_account_id_created_by_fkey`,
		`ALTER TABLE task_environment_grants DROP CONSTRAINT IF EXISTS task_environment_grants_created_by_fkey`,
		`DO $$ BEGIN ALTER TABLE task_environment_grants ADD CONSTRAINT task_environment_grants_created_by_fkey
			FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_environment_grants_user ON task_environment_grants(account_id,user_id,environment_id)`,
		`CREATE TABLE IF NOT EXISTS task_folder_access_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			folder_id UUID NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_level VARCHAR(16) NOT NULL,
			can_manage_access BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_folder_access_grants_level_check CHECK (access_level IN ('none','view','comment','edit','full')),
			CONSTRAINT task_folder_access_grants_manage_check CHECK (NOT can_manage_access OR access_level='full'),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,folder_id) REFERENCES task_folders(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,folder_id,user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_folder_access_grants_user ON task_folder_access_grants(account_id,user_id,folder_id)`,
		`CREATE TABLE IF NOT EXISTS task_list_access_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			list_id UUID NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			access_level VARCHAR(16) NOT NULL,
			can_manage_access BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_list_access_grants_level_check CHECK (access_level IN ('none','view','comment','edit','full')),
			CONSTRAINT task_list_access_grants_manage_check CHECK (NOT can_manage_access OR access_level='full'),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,list_id) REFERENCES task_lists(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,list_id,user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_task_list_access_grants_user ON task_list_access_grants(account_id,user_id,list_id)`,
		`CREATE TABLE IF NOT EXISTS task_access_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			task_id UUID NOT NULL,
			access_level VARCHAR(16) NOT NULL,
			can_manage_access BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_access_grants_level_check CHECK (access_level IN ('none','view','comment','edit','full')),
			CONSTRAINT task_access_grants_manage_check CHECK (NOT can_manage_access OR access_level='full'),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,task_id) REFERENCES tasks(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,task_id,user_id)
		)`,
		`ALTER TABLE task_access_grants ALTER COLUMN created_by DROP NOT NULL`,
		`ALTER TABLE task_access_grants DROP CONSTRAINT IF EXISTS task_access_grants_account_id_created_by_fkey`,
		`ALTER TABLE task_access_grants DROP CONSTRAINT IF EXISTS task_access_grants_created_by_fkey`,
		`DO $$ BEGIN ALTER TABLE task_access_grants ADD CONSTRAINT task_access_grants_created_by_fkey
			FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE SET NULL;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_access_grants_user_task ON task_access_grants(account_id,user_id,task_id)`,
		`CREATE OR REPLACE FUNCTION enforce_root_task_access_grant() RETURNS TRIGGER AS $$
		 BEGIN
			IF NOT EXISTS(SELECT 1 FROM tasks task WHERE task.account_id=NEW.account_id AND task.id=NEW.task_id AND task.parent_task_id IS NULL) THEN
				RAISE EXCEPTION 'task access grants can only target root tasks' USING ERRCODE='23514';
			END IF;
			RETURN NEW;
		 END;
		 $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS task_access_grants_root_only ON task_access_grants`,
		`CREATE TRIGGER task_access_grants_root_only BEFORE INSERT OR UPDATE OF account_id,task_id ON task_access_grants
		 FOR EACH ROW EXECUTE FUNCTION enforce_root_task_access_grant()`,
		`CREATE OR REPLACE FUNCTION prevent_granted_task_from_becoming_child() RETURNS TRIGGER AS $$
		 BEGIN
			IF NEW.parent_task_id IS NOT NULL AND EXISTS(
				SELECT 1 FROM task_access_grants grant_item WHERE grant_item.account_id=NEW.account_id AND grant_item.task_id=NEW.id
			) THEN
				RAISE EXCEPTION 'a task with direct grants cannot become a subtask' USING ERRCODE='23514';
			END IF;
			RETURN NEW;
		 END;
		 $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS tasks_prevent_granted_child ON tasks`,
		`CREATE TRIGGER tasks_prevent_granted_child BEFORE UPDATE OF parent_task_id ON tasks
		 FOR EACH ROW EXECUTE FUNCTION prevent_granted_task_from_becoming_child()`,
		`CREATE TABLE IF NOT EXISTS task_access_audit (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			target_type VARCHAR(20) NOT NULL,
			target_id UUID NOT NULL,
			action VARCHAR(40) NOT NULL,
			before_state JSONB NOT NULL DEFAULT '{}',
			after_state JSONB NOT NULL DEFAULT '{}',
			operation_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT task_access_audit_target_check CHECK (target_type IN ('environment','folder','list','task'))
		)`,
		`ALTER TABLE task_access_audit DROP CONSTRAINT IF EXISTS task_access_audit_target_check`,
		`ALTER TABLE task_access_audit ADD CONSTRAINT task_access_audit_target_check CHECK (target_type IN ('environment','folder','list','task'))`,
		`ALTER TABLE task_access_audit ALTER COLUMN actor_id DROP NOT NULL`,
		`ALTER TABLE task_access_audit DROP CONSTRAINT IF EXISTS task_access_audit_account_id_actor_id_fkey`,
		`ALTER TABLE task_access_audit DROP CONSTRAINT IF EXISTS task_access_audit_actor_id_fkey`,
		`DO $$ BEGIN ALTER TABLE task_access_audit ADD CONSTRAINT task_access_audit_actor_id_fkey
			FOREIGN KEY(actor_id) REFERENCES users(id) ON DELETE SET NULL;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_access_audit_target ON task_access_audit(account_id,target_type,target_id,created_at DESC,id)`,
		`CREATE INDEX IF NOT EXISTS idx_task_access_audit_actor ON task_access_audit(account_id,actor_id,created_at DESC,id)`,
		`CREATE OR REPLACE FUNCTION ensure_account_task_workflow() RETURNS TRIGGER AS $$
		 DECLARE environment_uuid UUID; workflow_uuid UUID;
		 BEGIN
			INSERT INTO task_environments(account_id,name,description,color,icon,sort_order,visibility,default_access_level,is_default)
			VALUES(NEW.id,'General','Entorno general de la cuenta','#6366F1','layers',0,'account','full',TRUE)
			ON CONFLICT (account_id) WHERE is_default AND archived_at IS NULL
			DO UPDATE SET updated_at=NOW()
			RETURNING id INTO environment_uuid;
			INSERT INTO task_workflows(account_id,environment_id,name,is_default)
			VALUES(NEW.id,environment_uuid,'Flujo general',TRUE)
			ON CONFLICT(account_id,environment_id,name) DO UPDATE SET is_default=TRUE,updated_at=NOW()
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
		`CREATE OR REPLACE FUNCTION ensure_account_task_default_list() RETURNS TRIGGER AS $$
		 BEGIN
			INSERT INTO task_lists(account_id,environment_id,workflow_id,workflow_inherited,name,description,color,icon,sort_order,created_by,is_default)
			SELECT NEW.account_id,environment.id,workflow.id,TRUE,'Bandeja general','Tareas sin una lista específica','#10B981','inbox',0,NEW.user_id,TRUE
			FROM task_environments environment
			JOIN task_workflows workflow ON workflow.account_id=environment.account_id AND workflow.environment_id=environment.id AND workflow.is_default
			WHERE environment.account_id=NEW.account_id AND environment.is_default AND environment.archived_at IS NULL
			ON CONFLICT (account_id,environment_id) WHERE is_default AND archived_at IS NULL DO NOTHING;
			RETURN NEW;
		 END;
		 $$ LANGUAGE plpgsql`,
	}

	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("task environment schema migration failed: %w\nSQL: %s", err, statement)
		}
	}

	return tx.Commit(ctx)
}
