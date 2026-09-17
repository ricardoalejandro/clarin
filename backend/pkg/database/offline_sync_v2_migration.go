package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineSyncV2 upgrades the original terminal prototype into the
// durable v2 control and data plane. The migration is intentionally additive:
// v1 columns remain readable during rollout, while all new writes use the v2
// tables and constraints.
func migrateOfflineSyncV2(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`ALTER TABLE offline_terminals
			ADD COLUMN IF NOT EXISTS install_instance_hash VARCHAR(64),
			ADD COLUMN IF NOT EXISTS protocol_version INTEGER NOT NULL DEFAULT 2,
			ADD COLUMN IF NOT EXISTS used_storage_bytes BIGINT NOT NULL DEFAULT 0 CHECK (used_storage_bytes >= 0),
			ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS wipe_required_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS wipe_acknowledged_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS last_error_code VARCHAR(96)`,
		`ALTER TABLE offline_terminal_grants
			ADD COLUMN IF NOT EXISTS selection_revision BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE offline_resource_selections
			ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid(),
			ADD COLUMN IF NOT EXISTS selected_by UUID REFERENCES users(id) ON DELETE SET NULL,
			ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		`UPDATE offline_resource_selections SET id=gen_random_uuid() WHERE id IS NULL`,
		`ALTER TABLE offline_resource_selections ALTER COLUMN id SET NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_resource_selection_id_account ON offline_resource_selections(id, account_id)`,
		`ALTER TABLE offline_sync_nonces ADD COLUMN IF NOT EXISTS challenge_id UUID DEFAULT gen_random_uuid()`,
		`UPDATE offline_sync_nonces SET challenge_id=gen_random_uuid() WHERE challenge_id IS NULL`,
		`ALTER TABLE offline_sync_nonces ALTER COLUMN challenge_id SET NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_sync_challenge_id ON offline_sync_nonces(challenge_id)`,
		`CREATE TABLE IF NOT EXISTS offline_resource_heads (
			selection_id UUID NOT NULL,
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			module VARCHAR(32) NOT NULL CHECK (module IN ('whiteboards','tasks','contacts','programs')),
			resource_type VARCHAR(48) NOT NULL CHECK (resource_type IN ('whiteboard','task_list','contact','program')),
			resource_id UUID NOT NULL,
			head_version BIGINT NOT NULL DEFAULT 1 CHECK (head_version > 0),
			content_hash BYTEA,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (selection_id),
			FOREIGN KEY (selection_id,account_id) REFERENCES offline_resource_selections(id,account_id) ON DELETE CASCADE,
			FOREIGN KEY (grant_id,account_id) REFERENCES offline_terminal_grants(id,account_id) ON DELETE CASCADE,
			UNIQUE (grant_id,module,resource_type,resource_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_resource_heads_inventory ON offline_resource_heads(grant_id,head_version,resource_id)`,
		`INSERT INTO offline_resource_heads(selection_id,grant_id,account_id,module,resource_type,resource_id)
		 SELECT id,grant_id,account_id,module,resource_type,resource_id
		 FROM offline_resource_selections
		 WHERE resource_type IN ('whiteboard','task_list','contact','program')
		 ON CONFLICT (selection_id) DO NOTHING`,
		`ALTER TABLE offline_sync_receipts
			ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL,
			ADD COLUMN IF NOT EXISTS module VARCHAR(32),
			ADD COLUMN IF NOT EXISTS resource_type VARCHAR(48),
			ADD COLUMN IF NOT EXISTS resource_id UUID,
			ADD COLUMN IF NOT EXISTS operation_type VARCHAR(80),
			ADD COLUMN IF NOT EXISTS base_version BIGINT,
			ADD COLUMN IF NOT EXISTS applied_version BIGINT,
			ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		`ALTER TABLE offline_sync_receipts DROP CONSTRAINT IF EXISTS offline_sync_receipts_status_check`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offline_sync_receipts_status_v2_check' AND conrelid='offline_sync_receipts'::regclass) THEN
				ALTER TABLE offline_sync_receipts ADD CONSTRAINT offline_sync_receipts_status_v2_check CHECK (status IN ('applied','noop','conflict','rejected','dependency_failed'));
			END IF;
		END $$`,
		`ALTER TABLE offline_change_log
			ADD COLUMN IF NOT EXISTS grant_id UUID,
			ADD COLUMN IF NOT EXISTS changed_fields TEXT[] NOT NULL DEFAULT '{}',
			ADD COLUMN IF NOT EXISTS head_version BIGINT`,
		`ALTER TABLE offline_sync_conflicts
			ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL,
			ADD COLUMN IF NOT EXISTS base_version BIGINT,
			ADD COLUMN IF NOT EXISTS base_value JSONB NOT NULL DEFAULT '{}'::jsonb,
			ADD COLUMN IF NOT EXISTS conflict_paths TEXT[] NOT NULL DEFAULT '{}',
			ADD COLUMN IF NOT EXISTS resolution_value JSONB,
			ADD COLUMN IF NOT EXISTS resolution_note TEXT`,
		`ALTER TABLE offline_sync_conflicts DROP CONSTRAINT IF EXISTS offline_sync_conflicts_status_check`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offline_sync_conflicts_status_v2_check' AND conrelid='offline_sync_conflicts'::regclass) THEN
				ALTER TABLE offline_sync_conflicts ADD CONSTRAINT offline_sync_conflicts_status_v2_check CHECK (status IN ('open','resolved_server','resolved_client','resolved_merged','dismissed'));
			END IF;
		END $$`,
		`CREATE TABLE IF NOT EXISTS offline_control_directives (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			terminal_id UUID NOT NULL REFERENCES offline_terminals(id) ON DELETE CASCADE,
			directive_type VARCHAR(32) NOT NULL CHECK (directive_type IN ('wipe','lock','policy_refresh')),
			payload JSONB NOT NULL,
			payload_hash BYTEA NOT NULL,
			signature TEXT,
			signer_key_version INTEGER,
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			signed_at TIMESTAMPTZ,
			delivered_at TIMESTAMPTZ,
			acknowledged_at TIMESTAMPTZ,
			acknowledgement JSONB,
			UNIQUE (terminal_id,directive_type,payload_hash)
		)`,
		`ALTER TABLE offline_control_directives ADD COLUMN IF NOT EXISTS payload_encoded TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_offline_control_pending ON offline_control_directives(terminal_id,created_at) WHERE acknowledged_at IS NULL`,
		`CREATE OR REPLACE FUNCTION offline_touch_resource_head(p_account UUID,p_resource_type TEXT,p_resource_id UUID) RETURNS VOID AS $$
		DECLARE resolved_module TEXT;
		BEGIN
			resolved_module := CASE p_resource_type WHEN 'whiteboard' THEN 'whiteboards' WHEN 'task_list' THEN 'tasks' WHEN 'contact' THEN 'contacts' WHEN 'program' THEN 'programs' END;
			IF p_account IS NULL OR p_resource_id IS NULL OR resolved_module IS NULL THEN RETURN; END IF;
			UPDATE offline_resource_heads SET head_version=head_version+1,content_hash=NULL,updated_at=NOW()
			 WHERE account_id=p_account AND module=resolved_module AND resource_type=p_resource_type AND resource_id=p_resource_id;
			IF FOUND THEN
				INSERT INTO offline_change_log(account_id,module,resource_type,resource_id,change_kind,resource_version,payload,changed_fields,head_version)
				VALUES(p_account,resolved_module,p_resource_type,p_resource_id,'upsert',txid_current(),'{}'::jsonb,'{}',txid_current());
			END IF;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_direct_resource() RETURNS TRIGGER AS $$
		BEGIN
			IF TG_OP='DELETE' THEN
				PERFORM offline_touch_resource_head(OLD.account_id,TG_ARGV[0],OLD.id);
				RETURN OLD;
			END IF;
			PERFORM offline_touch_resource_head(NEW.account_id,TG_ARGV[0],NEW.id);
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_task_list() RETURNS TRIGGER AS $$
		BEGIN
			IF TG_OP<>'INSERT' AND OLD.list_id IS NOT NULL THEN PERFORM offline_touch_resource_head(OLD.account_id,'task_list',OLD.list_id); END IF;
			IF TG_OP<>'DELETE' AND NEW.list_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.list_id IS DISTINCT FROM OLD.list_id) THEN PERFORM offline_touch_resource_head(NEW.account_id,'task_list',NEW.list_id); END IF;
			IF TG_OP='UPDATE' AND NEW.list_id IS NOT DISTINCT FROM OLD.list_id AND NEW.list_id IS NOT NULL THEN PERFORM offline_touch_resource_head(NEW.account_id,'task_list',NEW.list_id); END IF;
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_program_child() RETURNS TRIGGER AS $$
		DECLARE target_program UUID; target_account UUID; old_program UUID; old_account UUID;
		BEGIN
			IF TG_TABLE_NAME='program_sessions' THEN
				IF TG_OP<>'INSERT' THEN old_program:=OLD.program_id; old_account:=OLD.account_id; END IF;
				IF TG_OP<>'DELETE' THEN target_program:=NEW.program_id; target_account:=NEW.account_id; END IF;
			ELSIF TG_TABLE_NAME='program_participants' THEN
				IF TG_OP<>'INSERT' THEN old_program:=OLD.program_id; SELECT account_id INTO old_account FROM programs WHERE id=old_program; END IF;
				IF TG_OP<>'DELETE' THEN target_program:=NEW.program_id; SELECT account_id INTO target_account FROM programs WHERE id=target_program; END IF;
			ELSIF TG_TABLE_NAME='program_attendance' THEN
				IF TG_OP<>'INSERT' THEN SELECT pp.program_id,p.account_id INTO old_program,old_account FROM program_participants pp JOIN programs p ON p.id=pp.program_id WHERE pp.id=OLD.participant_id; END IF;
				IF TG_OP<>'DELETE' THEN SELECT pp.program_id,p.account_id INTO target_program,target_account FROM program_participants pp JOIN programs p ON p.id=pp.program_id WHERE pp.id=NEW.participant_id; END IF;
			END IF;
			IF old_program IS NOT NULL THEN PERFORM offline_touch_resource_head(old_account,'program',old_program); END IF;
			IF target_program IS DISTINCT FROM old_program THEN PERFORM offline_touch_resource_head(target_account,'program',target_program); END IF;
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_program_session_child() RETURNS TRIGGER AS $$
		DECLARE target_session UUID; target_account UUID; target_program UUID;
		BEGIN
			IF TG_OP='DELETE' THEN target_session:=OLD.session_id; target_account:=OLD.account_id; ELSE target_session:=NEW.session_id; target_account:=NEW.account_id; END IF;
			SELECT program_id INTO target_program FROM program_sessions WHERE account_id=target_account AND id=target_session;
			PERFORM offline_touch_resource_head(target_account,'program',target_program);
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_interaction_resources() RETURNS TRIGGER AS $$
		BEGIN
			IF TG_OP<>'INSERT' THEN
				IF OLD.contact_id IS NOT NULL THEN PERFORM offline_touch_resource_head(OLD.account_id,'contact',OLD.contact_id); END IF;
				IF OLD.program_id IS NOT NULL THEN PERFORM offline_touch_resource_head(OLD.account_id,'program',OLD.program_id); END IF;
			END IF;
			IF TG_OP='DELETE' THEN
				RETURN OLD;
			END IF;
			IF NEW.contact_id IS NOT NULL THEN PERFORM offline_touch_resource_head(NEW.account_id,'contact',NEW.contact_id); END IF;
			IF NEW.program_id IS NOT NULL THEN PERFORM offline_touch_resource_head(NEW.account_id,'program',NEW.program_id); END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_contact_dependencies() RETURNS TRIGGER AS $$
		DECLARE target_contact UUID; target_account UUID; dependency RECORD;
		BEGIN
			IF TG_OP='DELETE' THEN target_contact:=OLD.id; target_account:=OLD.account_id; ELSE target_contact:=NEW.id; target_account:=NEW.account_id; END IF;
			PERFORM offline_touch_resource_head(target_account,'contact',target_contact);
			FOR dependency IN SELECT pp.program_id FROM program_participants pp JOIN programs p ON p.id=pp.program_id WHERE pp.contact_id=target_contact AND p.account_id=target_account LOOP
				PERFORM offline_touch_resource_head(target_account,'program',dependency.program_id);
			END LOOP;
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_tag_dependencies() RETURNS TRIGGER AS $$
		DECLARE target_tag UUID; target_account UUID; dependency RECORD;
		BEGIN
			IF TG_OP='DELETE' THEN target_tag:=OLD.id; target_account:=OLD.account_id; ELSE target_tag:=NEW.id; target_account:=NEW.account_id; END IF;
			FOR dependency IN SELECT ct.contact_id FROM contact_tags ct WHERE ct.tag_id=target_tag LOOP
				PERFORM offline_touch_resource_head(target_account,'contact',dependency.contact_id);
			END LOOP;
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_contact_tag() RETURNS TRIGGER AS $$
		DECLARE target_contact UUID; target_account UUID;
		BEGIN
			IF TG_OP='DELETE' THEN target_contact:=OLD.contact_id; ELSE target_contact:=NEW.contact_id; END IF;
			SELECT account_id INTO target_account FROM contacts WHERE id=target_contact;
			PERFORM offline_touch_resource_head(target_account,'contact',target_contact);
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`CREATE OR REPLACE FUNCTION offline_touch_contact_child() RETURNS TRIGGER AS $$
		DECLARE target_contact UUID; target_account UUID; dependency RECORD;
		BEGIN
			IF TG_OP='DELETE' THEN target_contact:=OLD.contact_id; ELSE target_contact:=NEW.contact_id; END IF;
			SELECT account_id INTO target_account FROM contacts WHERE id=target_contact;
			PERFORM offline_touch_resource_head(target_account,'contact',target_contact);
			FOR dependency IN SELECT pp.program_id FROM program_participants pp JOIN programs p ON p.id=pp.program_id WHERE pp.contact_id=target_contact AND p.account_id=target_account LOOP
				PERFORM offline_touch_resource_head(target_account,'program',dependency.program_id);
			END LOOP;
			IF TG_OP='DELETE' THEN RETURN OLD; END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS trg_offline_whiteboard_head ON whiteboards`,
		`CREATE TRIGGER trg_offline_whiteboard_head AFTER INSERT OR UPDATE OR DELETE ON whiteboards FOR EACH ROW EXECUTE FUNCTION offline_touch_direct_resource('whiteboard')`,
		`DROP TRIGGER IF EXISTS trg_offline_contact_head ON contacts`,
		`CREATE TRIGGER trg_offline_contact_head AFTER INSERT OR UPDATE OR DELETE ON contacts FOR EACH ROW EXECUTE FUNCTION offline_touch_contact_dependencies()`,
		`DROP TRIGGER IF EXISTS trg_offline_task_list_head ON tasks`,
		`CREATE TRIGGER trg_offline_task_list_head AFTER INSERT OR UPDATE OR DELETE ON tasks FOR EACH ROW EXECUTE FUNCTION offline_touch_task_list()`,
		`DROP TRIGGER IF EXISTS trg_offline_task_list_metadata_head ON task_lists`,
		`CREATE TRIGGER trg_offline_task_list_metadata_head AFTER UPDATE OR DELETE ON task_lists FOR EACH ROW EXECUTE FUNCTION offline_touch_direct_resource('task_list')`,
		`DROP TRIGGER IF EXISTS trg_offline_program_head ON programs`,
		`CREATE TRIGGER trg_offline_program_head AFTER INSERT OR UPDATE OR DELETE ON programs FOR EACH ROW EXECUTE FUNCTION offline_touch_direct_resource('program')`,
		`DROP TRIGGER IF EXISTS trg_offline_program_session_head ON program_sessions`,
		`CREATE TRIGGER trg_offline_program_session_head AFTER INSERT OR UPDATE OR DELETE ON program_sessions FOR EACH ROW EXECUTE FUNCTION offline_touch_program_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_program_participant_head ON program_participants`,
		`CREATE TRIGGER trg_offline_program_participant_head AFTER INSERT OR UPDATE OR DELETE ON program_participants FOR EACH ROW EXECUTE FUNCTION offline_touch_program_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_program_attendance_head ON program_attendance`,
		`CREATE TRIGGER trg_offline_program_attendance_head AFTER INSERT OR UPDATE OR DELETE ON program_attendance FOR EACH ROW EXECUTE FUNCTION offline_touch_program_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_program_session_observation_head ON program_session_observations`,
		`CREATE TRIGGER trg_offline_program_session_observation_head AFTER INSERT OR UPDATE OR DELETE ON program_session_observations FOR EACH ROW EXECUTE FUNCTION offline_touch_program_session_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_program_session_topic_head ON program_session_topics`,
		`CREATE TRIGGER trg_offline_program_session_topic_head AFTER INSERT OR UPDATE OR DELETE ON program_session_topics FOR EACH ROW EXECUTE FUNCTION offline_touch_program_session_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_interaction_head ON interactions`,
		`CREATE TRIGGER trg_offline_interaction_head AFTER INSERT OR UPDATE OR DELETE ON interactions FOR EACH ROW EXECUTE FUNCTION offline_touch_interaction_resources()`,
		`DROP TRIGGER IF EXISTS trg_offline_contact_tag_head ON contact_tags`,
		`CREATE TRIGGER trg_offline_contact_tag_head AFTER INSERT OR DELETE ON contact_tags FOR EACH ROW EXECUTE FUNCTION offline_touch_contact_tag()`,
		`DROP TRIGGER IF EXISTS trg_offline_contact_phone_head ON contact_phones`,
		`CREATE TRIGGER trg_offline_contact_phone_head AFTER INSERT OR UPDATE OR DELETE ON contact_phones FOR EACH ROW EXECUTE FUNCTION offline_touch_contact_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_contact_custom_value_head ON custom_field_values`,
		`CREATE TRIGGER trg_offline_contact_custom_value_head AFTER INSERT OR UPDATE OR DELETE ON custom_field_values FOR EACH ROW EXECUTE FUNCTION offline_touch_contact_child()`,
		`DROP TRIGGER IF EXISTS trg_offline_tag_definition_head ON tags`,
		`CREATE TRIGGER trg_offline_tag_definition_head AFTER UPDATE OR DELETE ON tags FOR EACH ROW EXECUTE FUNCTION offline_touch_tag_dependencies()`,
		`CREATE INDEX IF NOT EXISTS idx_offline_receipts_retention ON offline_sync_receipts(created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_conflicts_user ON offline_sync_conflicts(user_id,status,created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline sync v2 migration: %w", err)
		}
	}
	return nil
}
