package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// whiteboardMigrations is kept as explicit idempotent SQL because startup is
// the production migration path for Clarin. Composite foreign keys make it
// impossible to attach a folder, user grant, guest session, revision, or media
// asset from a different account even if an ID is supplied directly.
func whiteboardMigrations() []string {
	return []string{
		`UPDATE roles SET permissions=array_append(COALESCE(permissions,'{}'::text[]),'whiteboards'),updated_at=NOW()
			WHERE name='Administrador' AND NOT ('whiteboards'=ANY(COALESCE(permissions,'{}'::text[])))`,
		`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS whiteboard_trash_retention_days INT NOT NULL DEFAULT 30`,
		`DO $$ BEGIN ALTER TABLE accounts ADD CONSTRAINT accounts_whiteboard_trash_retention_check
			CHECK (whiteboard_trash_retention_days BETWEEN 7 AND 365);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_account_user_whiteboards
			ON user_accounts(account_id,user_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_media_assets_account_id_whiteboards
			ON media_assets(account_id,id)`,
		`CREATE TABLE IF NOT EXISTS whiteboard_folders (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			parent_id UUID,
			name VARCHAR(120) NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			sort_order BIGINT NOT NULL DEFAULT 0,
			version BIGINT NOT NULL DEFAULT 1,
			created_by UUID,
			archived_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_folders_parent_self_check CHECK (parent_id IS NULL OR parent_id<>id)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_folders_account_id
			ON whiteboard_folders(account_id,id)`,
		`DO $$ BEGIN ALTER TABLE whiteboard_folders ADD CONSTRAINT whiteboard_folders_parent_account_fk
			FOREIGN KEY(account_id,parent_id) REFERENCES whiteboard_folders(account_id,id) ON DELETE RESTRICT;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_folders_active_sibling_name
			ON whiteboard_folders(account_id,COALESCE(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),LOWER(name))
			WHERE archived_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_folders_parent_order
			ON whiteboard_folders(account_id,parent_id,archived_at,sort_order,id)`,

		`CREATE TABLE IF NOT EXISTS whiteboard_libraries (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			name VARCHAR(160) NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			library_json JSONB NOT NULL DEFAULT '{"libraryItems":[]}'::jsonb,
			visibility VARCHAR(16) NOT NULL DEFAULT 'account',
			version BIGINT NOT NULL DEFAULT 1,
			created_by UUID,
			updated_by UUID,
			archived_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_libraries_visibility_check CHECK (visibility IN ('private','account'))
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_libraries_account_id
			ON whiteboard_libraries(account_id,id)`,
		`DO $$ BEGIN ALTER TABLE whiteboard_libraries ADD CONSTRAINT whiteboard_libraries_description_length_check
			CHECK (char_length(description)<=1000) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_libraries VALIDATE CONSTRAINT whiteboard_libraries_description_length_check`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_libraries_active_name
			ON whiteboard_libraries(account_id,LOWER(name)) WHERE archived_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_libraries_account_updated
			ON whiteboard_libraries(account_id,archived_at,updated_at DESC,id DESC)`,

		`CREATE TABLE IF NOT EXISTS whiteboards (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			folder_id UUID,
			name VARCHAR(200) NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			scene_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			scene_schema_version VARCHAR(80) NOT NULL DEFAULT 'excalidraw',
			editor_version VARCHAR(80) NOT NULL DEFAULT '',
			scene_sequence BIGINT NOT NULL DEFAULT 0,
			version BIGINT NOT NULL DEFAULT 1,
			access_mode VARCHAR(16) NOT NULL DEFAULT 'private',
			access_revision BIGINT NOT NULL DEFAULT 1,
			thumbnail_media_asset_id UUID,
			created_by UUID,
			updated_by UUID,
			archived_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboards_access_mode_check CHECK (access_mode IN ('private','account')),
			CONSTRAINT whiteboards_scene_sequence_check CHECK (scene_sequence>=0)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboards_account_id ON whiteboards(account_id,id)`,
		`DO $$ BEGIN ALTER TABLE whiteboards ADD CONSTRAINT whiteboards_folder_account_fk
			FOREIGN KEY(account_id,folder_id) REFERENCES whiteboard_folders(account_id,id) ON DELETE RESTRICT;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboards ADD CONSTRAINT whiteboards_thumbnail_account_fk
			FOREIGN KEY(account_id,thumbnail_media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboards_account_updated
			ON whiteboards(account_id,archived_at,updated_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboards_folder_updated
			ON whiteboards(account_id,folder_id,archived_at,updated_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboards_creator
			ON whiteboards(account_id,created_by,archived_at,updated_at DESC,id DESC)`,

		`CREATE TABLE IF NOT EXISTS whiteboard_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			user_id UUID NOT NULL,
			access_level VARCHAR(16) NOT NULL,
			can_manage_access BOOLEAN NOT NULL DEFAULT FALSE,
			created_by UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_grants_level_check CHECK (access_level IN ('view','comment','edit','manage')),
			CONSTRAINT whiteboard_grants_manage_check CHECK (can_manage_access=(access_level='manage')),
			FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,board_id,user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_grants_user_board
			ON whiteboard_grants(account_id,user_id,board_id)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_grants_board
			ON whiteboard_grants(account_id,board_id,user_id)`,
		// Upgrade the cumulative board ACL without granting comments to account
		// visibility or guest links. Replacing the check only when needed keeps
		// startup migrations idempotent and avoids an unnecessary table lock.
		`DO $$ BEGIN
			IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='whiteboard_grants_level_check'
				AND conrelid='whiteboard_grants'::regclass
				AND pg_get_constraintdef(oid) NOT LIKE '%comment%') THEN
				ALTER TABLE whiteboard_grants DROP CONSTRAINT whiteboard_grants_level_check;
			END IF;
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='whiteboard_grants_level_check'
				AND conrelid='whiteboard_grants'::regclass) THEN
				ALTER TABLE whiteboard_grants ADD CONSTRAINT whiteboard_grants_level_check
					CHECK (access_level IN ('view','comment','edit','manage'));
			END IF;
		 END $$`,
		`CREATE TABLE IF NOT EXISTS whiteboard_access_audit (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			actor_id UUID,
			action VARCHAR(50) NOT NULL,
			before_state JSONB NOT NULL DEFAULT '{}'::jsonb,
			after_state JSONB NOT NULL DEFAULT '{}'::jsonb,
			operation_id UUID,
			request_payload_hash CHAR(64),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE
		)`,
		`ALTER TABLE whiteboard_access_audit ADD COLUMN IF NOT EXISTS request_payload_hash CHAR(64)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_access_audit_board
			ON whiteboard_access_audit(account_id,board_id,created_at DESC,id DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_access_audit_operation
			ON whiteboard_access_audit(account_id,board_id,operation_id)
			WHERE operation_id IS NOT NULL AND action='access_replaced'`,
		`CREATE TABLE IF NOT EXISTS whiteboard_activity (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			actor_id UUID,
			guest_session_id UUID,
			action VARCHAR(64) NOT NULL,
			details JSONB NOT NULL DEFAULT '{}'::jsonb,
			operation_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_activity_action_check CHECK (action<>''),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_activity_board
			ON whiteboard_activity(account_id,board_id,created_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_activity_technical_retention
			ON whiteboard_activity(created_at,id)
			WHERE action IN ('scene.patched','scene.snapshotted','thumbnail.updated')`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_activity_operation
			ON whiteboard_activity(account_id,board_id,action,operation_id)
			WHERE operation_id IS NOT NULL`,

		`CREATE TABLE IF NOT EXISTS whiteboard_comment_threads (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			element_id VARCHAR(255),
			anchor_x DOUBLE PRECISION NOT NULL,
			anchor_y DOUBLE PRECISION NOT NULL,
			anchor_ratio_x DOUBLE PRECISION,
			anchor_ratio_y DOUBLE PRECISION,
			status VARCHAR(16) NOT NULL DEFAULT 'open',
			version BIGINT NOT NULL DEFAULT 1,
			created_by UUID,
			resolved_by UUID,
			resolved_at TIMESTAMPTZ,
			operation_id UUID NOT NULL,
			request_payload_hash CHAR(64) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_comment_threads_status_check CHECK (status IN ('open','resolved')),
			CONSTRAINT whiteboard_comment_threads_anchor_check CHECK (
				(anchor_ratio_x IS NULL AND anchor_ratio_y IS NULL) OR
				(element_id IS NOT NULL AND anchor_ratio_x BETWEEN 0 AND 1 AND anchor_ratio_y BETWEEN 0 AND 1)
			),
			CONSTRAINT whiteboard_comment_threads_resolution_check CHECK (
				(status='open' AND resolved_by IS NULL AND resolved_at IS NULL) OR
				(status='resolved' AND resolved_at IS NOT NULL)
			),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id) ON DELETE SET NULL (created_by),
			FOREIGN KEY(account_id,resolved_by) REFERENCES user_accounts(account_id,user_id) ON DELETE SET NULL (resolved_by),
			UNIQUE(account_id,board_id,id),
			UNIQUE(account_id,board_id,operation_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_comment_threads_board_status
			ON whiteboard_comment_threads(account_id,board_id,status,updated_at DESC,id DESC)`,
		`CREATE TABLE IF NOT EXISTS whiteboard_comments (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			thread_id UUID NOT NULL,
			author_id UUID,
			body TEXT NOT NULL,
			version BIGINT NOT NULL DEFAULT 1,
			deleted_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_comments_body_check CHECK (
				(deleted_at IS NOT NULL AND body='') OR
				(deleted_at IS NULL AND char_length(body)>0 AND char_length(body)<=4000)
			),
			FOREIGN KEY(account_id,board_id,thread_id)
				REFERENCES whiteboard_comment_threads(account_id,board_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,author_id) REFERENCES user_accounts(account_id,user_id) ON DELETE SET NULL (author_id),
			UNIQUE(account_id,board_id,id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_comments_thread_order
			ON whiteboard_comments(account_id,board_id,thread_id,created_at,id)`,
		`DO $$ BEGIN ALTER TABLE whiteboard_comments ADD CONSTRAINT whiteboard_comments_body_length_check
			CHECK (char_length(body)<=4000) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_comments VALIDATE CONSTRAINT whiteboard_comments_body_length_check`,
		`CREATE TABLE IF NOT EXISTS whiteboard_comment_operations (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			operation_id UUID NOT NULL,
			actor_id UUID,
			action VARCHAR(40) NOT NULL,
			entity_id UUID NOT NULL,
			request_payload_hash CHAR(64) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id) ON DELETE SET NULL (actor_id),
			UNIQUE(account_id,board_id,operation_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_comment_operations_retention
			ON whiteboard_comment_operations(account_id,board_id,created_at DESC,id DESC)`,

		`CREATE TABLE IF NOT EXISTS whiteboard_library_import_sessions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			library_id UUID NOT NULL,
			actor_id UUID NOT NULL,
			token_hash CHAR(64) NOT NULL,
			status VARCHAR(16) NOT NULL DEFAULT 'pending',
			source_url TEXT,
			library_json JSONB,
			failure_code VARCHAR(80),
			completion_operation_id UUID,
			completed_library_version BIGINT,
			expires_at TIMESTAMPTZ NOT NULL,
			consumed_at TIMESTAMPTZ,
			completed_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_library_import_status_check
				CHECK (status IN ('pending','fetching','ready','completed','failed')),
			CONSTRAINT whiteboard_library_import_payload_check CHECK (
				(status='ready' AND library_json IS NOT NULL AND source_url IS NOT NULL) OR
				(status<>'ready')
			),
			CONSTRAINT whiteboard_library_import_completion_check CHECK (
				(status='completed' AND completed_at IS NOT NULL AND completion_operation_id IS NOT NULL
					AND completed_library_version IS NOT NULL AND completed_library_version>0) OR
				(status<>'completed' AND completed_at IS NULL)
			),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,library_id) REFERENCES whiteboard_libraries(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE,
			UNIQUE(token_hash),
			UNIQUE(account_id,board_id,id)
		)`,
		// Earlier releases could acknowledge an import without recording the
		// canonical personal-library version. Such a row cannot be proven or
		// replayed safely, so retain it as a consumed-token failure tombstone
		// before validating the stricter lifecycle constraint.
		`UPDATE whiteboard_library_import_sessions SET
			status='failed',source_url=NULL,library_json=NULL,
			failure_code=COALESCE(failure_code,'unconfirmed_library_version'),
			completion_operation_id=NULL,completed_library_version=NULL,completed_at=NULL,updated_at=NOW()
			WHERE status='completed' AND (completed_library_version IS NULL OR completed_library_version<=0)`,
		`DO $$ BEGIN ALTER TABLE whiteboard_library_import_sessions
			ADD CONSTRAINT whiteboard_library_import_completed_version_check CHECK (
				(status='completed' AND completed_library_version IS NOT NULL AND completed_library_version>0
					AND library_json IS NULL) OR
				(status<>'completed' AND completed_library_version IS NULL)) NOT VALID;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_library_import_sessions
			VALIDATE CONSTRAINT whiteboard_library_import_completed_version_check`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_library_import_actor
			ON whiteboard_library_import_sessions(account_id,actor_id,board_id,expires_at DESC,id DESC)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_library_import_completion
			ON whiteboard_library_import_sessions(account_id,board_id,completion_operation_id)
			WHERE completion_operation_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_library_import_expiry
			ON whiteboard_library_import_sessions(expires_at,id)
			WHERE status IN ('pending','fetching','ready')`,

		`CREATE TABLE IF NOT EXISTS whiteboard_share_links (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			token_hash CHAR(64) NOT NULL,
			label VARCHAR(160) NOT NULL DEFAULT '',
			access_level VARCHAR(16) NOT NULL DEFAULT 'view',
			password_hash TEXT,
			allow_export BOOLEAN NOT NULL DEFAULT FALSE,
			expires_at TIMESTAMPTZ,
			max_sessions INT,
			session_count INT NOT NULL DEFAULT 0,
			created_by UUID,
			revoked_at TIMESTAMPTZ,
			last_used_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_share_links_level_check CHECK (access_level IN ('view','edit')),
			CONSTRAINT whiteboard_share_links_max_sessions_check CHECK (max_sessions IS NULL OR max_sessions>0),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			UNIQUE(token_hash)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_share_links_board
			ON whiteboard_share_links(account_id,board_id,created_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_share_links_active
			ON whiteboard_share_links(token_hash) WHERE revoked_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_share_links_account_id
			ON whiteboard_share_links(account_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_share_links_account_board_id
			ON whiteboard_share_links(account_id,board_id,id)`,
		`CREATE TABLE IF NOT EXISTS whiteboard_guest_sessions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			share_link_id UUID NOT NULL,
			token_hash CHAR(64) NOT NULL,
			display_name VARCHAR(120) NOT NULL DEFAULT 'Invitado',
			access_level VARCHAR(16) NOT NULL,
			client_fingerprint_hash CHAR(64),
			expires_at TIMESTAMPTZ NOT NULL,
			revoked_at TIMESTAMPTZ,
			last_seen_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_guest_sessions_level_check CHECK (access_level IN ('view','edit')),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			UNIQUE(token_hash)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_guest_sessions_link
			ON whiteboard_guest_sessions(account_id,share_link_id,created_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_guest_sessions_active
			ON whiteboard_guest_sessions(token_hash,expires_at) WHERE revoked_at IS NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_guest_sessions_account_id
			ON whiteboard_guest_sessions(account_id,id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_guest_sessions_account_board_id
			ON whiteboard_guest_sessions(account_id,board_id,id)`,

		`CREATE TABLE IF NOT EXISTS whiteboard_operations (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			base_sequence BIGINT NOT NULL,
			sequence BIGINT NOT NULL,
			operation_id UUID NOT NULL,
			operation_kind VARCHAR(20) NOT NULL,
			patch_json JSONB,
			request_payload_hash CHAR(64),
			result_scene_hash CHAR(64) NOT NULL,
			actor_id UUID,
			guest_session_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_operations_kind_check CHECK (operation_kind IN ('create','snapshot','patch','restore')),
			CONSTRAINT whiteboard_operations_sequence_check CHECK (base_sequence>=0 AND sequence>base_sequence OR operation_kind='create' AND base_sequence=0 AND sequence=0),
			CONSTRAINT whiteboard_operations_patch_check CHECK (operation_kind<>'patch' OR patch_json IS NOT NULL),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,board_id,sequence),
			UNIQUE(account_id,board_id,operation_id)
		)`,
		`ALTER TABLE whiteboard_operations ADD COLUMN IF NOT EXISTS request_payload_hash CHAR(64)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_operations_board_sequence
			ON whiteboard_operations(account_id,board_id,sequence DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_operations_technical_retention
			ON whiteboard_operations(created_at,id)
			WHERE operation_kind IN ('patch','snapshot')`,

		`CREATE TABLE IF NOT EXISTS whiteboard_revisions (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			revision_number BIGINT NOT NULL,
			sequence BIGINT NOT NULL,
			operation_id UUID NOT NULL,
			write_kind VARCHAR(20) NOT NULL DEFAULT 'snapshot',
			revision_kind VARCHAR(20) NOT NULL DEFAULT 'automatic',
			expires_at TIMESTAMPTZ,
			scene_json JSONB,
			snapshot_object_key TEXT NOT NULL,
			snapshot_content_hash CHAR(64) NOT NULL,
			snapshot_size_bytes BIGINT NOT NULL,
			snapshot_compression VARCHAR(20) NOT NULL DEFAULT 'gzip',
			scene_schema_version VARCHAR(80) NOT NULL,
			editor_version VARCHAR(80) NOT NULL DEFAULT '',
			actor_id UUID,
			guest_session_id UUID,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_revisions_kind_check CHECK (write_kind IN ('create','snapshot','restore')),
			CONSTRAINT whiteboard_revisions_retention_kind_check CHECK (revision_kind IN ('automatic','manual','system')),
			CONSTRAINT whiteboard_revisions_expiry_check CHECK (
				(revision_kind='automatic' AND expires_at IS NOT NULL) OR
				(revision_kind IN ('manual','system') AND expires_at IS NULL)
			),
			CONSTRAINT whiteboard_revisions_sequence_check CHECK (sequence>=0),
			CONSTRAINT whiteboard_revisions_snapshot_size_check CHECK (snapshot_size_bytes>0),
			CONSTRAINT whiteboard_revisions_compression_check CHECK (snapshot_compression IN ('gzip')),
			FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,snapshot_object_key) REFERENCES storage_objects(account_id,object_key) ON DELETE RESTRICT,
			UNIQUE(account_id,board_id,revision_number),
			UNIQUE(account_id,board_id,operation_id),
			UNIQUE(account_id,snapshot_object_key)
		)`,
		`ALTER TABLE whiteboard_revisions ADD COLUMN IF NOT EXISTS revision_kind VARCHAR(20) NOT NULL DEFAULT 'automatic'`,
		`ALTER TABLE whiteboard_revisions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
		`UPDATE whiteboard_revisions SET
			revision_kind=CASE WHEN write_kind='create' THEN 'system' WHEN write_kind='restore' THEN 'manual' ELSE revision_kind END,
			expires_at=CASE
				WHEN write_kind='snapshot' AND revision_kind='automatic' THEN COALESCE(expires_at,created_at+INTERVAL '30 days')
				WHEN write_kind IN ('create','restore') THEN NULL ELSE expires_at END
			WHERE (write_kind='create' AND revision_kind<>'system')
			OR (write_kind='restore' AND revision_kind<>'manual')
			OR (write_kind='snapshot' AND revision_kind='automatic' AND expires_at IS NULL)
			OR (write_kind IN ('create','restore') AND expires_at IS NOT NULL)`,
		`DO $$ BEGIN ALTER TABLE whiteboard_revisions ADD CONSTRAINT whiteboard_revisions_retention_kind_check
			CHECK (revision_kind IN ('automatic','manual','system'));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_revisions ADD CONSTRAINT whiteboard_revisions_expiry_check CHECK (
			(revision_kind='automatic' AND expires_at IS NOT NULL) OR
			(revision_kind IN ('manual','system') AND expires_at IS NULL));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_revisions_board_sequence
			ON whiteboard_revisions(account_id,board_id,sequence DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_revisions_expiry
			ON whiteboard_revisions(expires_at,id) WHERE revision_kind='automatic'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_revisions_account_board_id
			ON whiteboard_revisions(account_id,board_id,id)`,

		`CREATE TABLE IF NOT EXISTS whiteboard_assets (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID,
			library_id UUID,
			media_asset_id UUID NOT NULL,
			file_id VARCHAR(255) NOT NULL,
			kind VARCHAR(20) NOT NULL DEFAULT 'asset',
			uploaded_by UUID,
			guest_session_id UUID,
			committed_at TIMESTAMPTZ,
			draft_expires_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_assets_owner_check CHECK ((board_id IS NOT NULL)::int+(library_id IS NOT NULL)::int=1),
			CONSTRAINT whiteboard_assets_kind_check CHECK (kind IN ('asset','thumbnail')),
			CONSTRAINT whiteboard_assets_thumbnail_owner_check CHECK (kind<>'thumbnail' OR board_id IS NOT NULL),
			CONSTRAINT whiteboard_assets_guest_board_check CHECK (guest_session_id IS NULL OR board_id IS NOT NULL),
			CONSTRAINT whiteboard_assets_board_account_fk
				FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE,
			CONSTRAINT whiteboard_assets_library_account_fk
				FOREIGN KEY(account_id,library_id) REFERENCES whiteboard_libraries(account_id,id) ON DELETE CASCADE,
			CONSTRAINT whiteboard_assets_media_account_fk
				FOREIGN KEY(account_id,media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT
		)`,
		// Upgrade the earlier board-only asset relation without requiring a
		// one-off migration. Exactly one owner remains mandatory and every new
		// library relation is validated inside the same account.
		`ALTER TABLE whiteboard_assets ADD COLUMN IF NOT EXISTS library_id UUID`,
		`ALTER TABLE whiteboard_assets ALTER COLUMN board_id DROP NOT NULL`,
		`ALTER TABLE whiteboard_assets ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ`,
		`ALTER TABLE whiteboard_assets ADD COLUMN IF NOT EXISTS draft_expires_at TIMESTAMPTZ`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_owner_check
			CHECK ((board_id IS NOT NULL)::int+(library_id IS NOT NULL)::int=1);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_library_account_fk
			FOREIGN KEY(account_id,library_id) REFERENCES whiteboard_libraries(account_id,id) ON DELETE CASCADE;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_thumbnail_owner_check
			CHECK (kind<>'thumbnail' OR board_id IS NOT NULL);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`UPDATE whiteboard_assets SET committed_at=created_at,draft_expires_at=NULL
			WHERE committed_at IS NULL AND draft_expires_at IS NULL`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_draft_lifecycle_check CHECK (
			(kind='thumbnail' AND committed_at IS NOT NULL AND draft_expires_at IS NULL) OR
			(kind='asset' AND ((committed_at IS NOT NULL AND draft_expires_at IS NULL) OR
				(committed_at IS NULL AND draft_expires_at IS NOT NULL))));
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_assets_board_file
			ON whiteboard_assets(account_id,board_id,file_id) WHERE board_id IS NOT NULL AND kind='asset'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_assets_board_thumbnail
			ON whiteboard_assets(account_id,board_id) WHERE board_id IS NOT NULL AND kind='thumbnail'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whiteboard_assets_library_file
			ON whiteboard_assets(account_id,library_id,file_id) WHERE library_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_assets_library_created
			ON whiteboard_assets(account_id,library_id,created_at,id) WHERE library_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_assets_media
			ON whiteboard_assets(account_id,media_asset_id)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_assets_expired_drafts
			ON whiteboard_assets(draft_expires_at,id) WHERE committed_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS whiteboard_revision_assets (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			board_id UUID NOT NULL,
			revision_id UUID NOT NULL,
			media_asset_id UUID NOT NULL,
			file_id VARCHAR(255) NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(account_id,board_id,revision_id)
				REFERENCES whiteboard_revisions(account_id,board_id,id) ON DELETE CASCADE,
			FOREIGN KEY(account_id,media_asset_id)
				REFERENCES media_assets(account_id,id) ON DELETE RESTRICT,
			UNIQUE(account_id,revision_id,file_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_revision_assets_media
			ON whiteboard_revision_assets(account_id,media_asset_id)`,

		// Replace legacy global-user foreign keys with account-scoped authorship.
		// PostgreSQL 16's column-list SET NULL keeps account_id intact when a
		// membership is removed while preserving the historical resource.
		`ALTER TABLE whiteboard_folders DROP CONSTRAINT IF EXISTS whiteboard_folders_created_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_folders ADD CONSTRAINT whiteboard_folders_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_libraries DROP CONSTRAINT IF EXISTS whiteboard_libraries_created_by_fkey`,
		`ALTER TABLE whiteboard_libraries DROP CONSTRAINT IF EXISTS whiteboard_libraries_updated_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_libraries ADD CONSTRAINT whiteboard_libraries_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_libraries ADD CONSTRAINT whiteboard_libraries_updated_by_account_fk
			FOREIGN KEY(account_id,updated_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (updated_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboards DROP CONSTRAINT IF EXISTS whiteboards_created_by_fkey`,
		`ALTER TABLE whiteboards DROP CONSTRAINT IF EXISTS whiteboards_updated_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboards ADD CONSTRAINT whiteboards_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboards ADD CONSTRAINT whiteboards_updated_by_account_fk
			FOREIGN KEY(account_id,updated_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (updated_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_grants DROP CONSTRAINT IF EXISTS whiteboard_grants_user_id_fkey`,
		`ALTER TABLE whiteboard_grants DROP CONSTRAINT IF EXISTS whiteboard_grants_created_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_grants ADD CONSTRAINT whiteboard_grants_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_access_audit DROP CONSTRAINT IF EXISTS whiteboard_access_audit_actor_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_access_audit ADD CONSTRAINT whiteboard_access_audit_actor_account_fk
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (actor_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_activity ADD CONSTRAINT whiteboard_activity_actor_account_fk
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (actor_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_share_links DROP CONSTRAINT IF EXISTS whiteboard_share_links_created_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_share_links ADD CONSTRAINT whiteboard_share_links_created_by_account_fk
			FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (created_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_operations DROP CONSTRAINT IF EXISTS whiteboard_operations_actor_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_operations ADD CONSTRAINT whiteboard_operations_actor_account_fk
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (actor_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_revisions DROP CONSTRAINT IF EXISTS whiteboard_revisions_actor_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_revisions ADD CONSTRAINT whiteboard_revisions_actor_account_fk
			FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (actor_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_assets DROP CONSTRAINT IF EXISTS whiteboard_assets_uploaded_by_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_uploaded_by_account_fk
			FOREIGN KEY(account_id,uploaded_by) REFERENCES user_accounts(account_id,user_id)
			ON DELETE SET NULL (uploaded_by);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

		// Guest provenance is tied to the exact account and board, not merely to
		// a globally unique UUID. This prevents attaching a valid session from a
		// sibling board in the same account.
		`ALTER TABLE whiteboard_guest_sessions DROP CONSTRAINT IF EXISTS whiteboard_guest_sessions_account_id_share_link_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_guest_sessions ADD CONSTRAINT whiteboard_guest_sessions_link_board_account_fk
			FOREIGN KEY(account_id,board_id,share_link_id)
			REFERENCES whiteboard_share_links(account_id,board_id,id) ON DELETE CASCADE;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_operations DROP CONSTRAINT IF EXISTS whiteboard_operations_account_id_guest_session_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_operations ADD CONSTRAINT whiteboard_operations_guest_board_account_fk
			FOREIGN KEY(account_id,board_id,guest_session_id)
			REFERENCES whiteboard_guest_sessions(account_id,board_id,id)
			ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_revisions DROP CONSTRAINT IF EXISTS whiteboard_revisions_account_id_guest_session_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_revisions ADD CONSTRAINT whiteboard_revisions_guest_board_account_fk
			FOREIGN KEY(account_id,board_id,guest_session_id)
			REFERENCES whiteboard_guest_sessions(account_id,board_id,id)
			ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`ALTER TABLE whiteboard_assets DROP CONSTRAINT IF EXISTS whiteboard_assets_guest_session_id_fkey`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_guest_board_check
			CHECK (guest_session_id IS NULL OR board_id IS NOT NULL);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_assets ADD CONSTRAINT whiteboard_assets_guest_board_account_fk
			FOREIGN KEY(account_id,board_id,guest_session_id)
			REFERENCES whiteboard_guest_sessions(account_id,board_id,id)
			ON DELETE SET NULL (guest_session_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN ALTER TABLE whiteboard_activity ADD CONSTRAINT whiteboard_activity_guest_board_account_fk
			FOREIGN KEY(account_id,board_id,guest_session_id)
			REFERENCES whiteboard_guest_sessions(account_id,board_id,id)
			ON DELETE SET NULL (guest_session_id);
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

		`CREATE TABLE IF NOT EXISTS whiteboard_media_gc_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			media_asset_id UUID NOT NULL,
			object_key TEXT NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			claim_token UUID,
			attempts INT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL DEFAULT '',
			available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_media_gc_jobs_status_check CHECK (status IN ('pending','processing')),
			FOREIGN KEY(account_id,media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE CASCADE,
			UNIQUE(account_id,media_asset_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_media_gc_jobs_due
			ON whiteboard_media_gc_jobs(available_at,id) WHERE status='pending'`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_media_gc_jobs_processing_lease
			ON whiteboard_media_gc_jobs(updated_at,id) WHERE status='processing'`,
		`DO $$ BEGIN ALTER TABLE whiteboard_media_gc_jobs ADD CONSTRAINT whiteboard_media_gc_jobs_object_account_fk
			FOREIGN KEY(account_id,object_key) REFERENCES storage_objects(account_id,object_key) ON DELETE CASCADE;
		 EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE TABLE IF NOT EXISTS whiteboard_snapshot_gc_jobs (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			object_key TEXT NOT NULL,
			status VARCHAR(20) NOT NULL DEFAULT 'pending',
			claim_token UUID,
			attempts INT NOT NULL DEFAULT 0,
			last_error TEXT NOT NULL DEFAULT '',
			available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			CONSTRAINT whiteboard_snapshot_gc_jobs_status_check CHECK (status IN ('pending','processing')),
			FOREIGN KEY(account_id,object_key) REFERENCES storage_objects(account_id,object_key) ON DELETE CASCADE,
			UNIQUE(account_id,object_key)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_snapshot_gc_jobs_due
			ON whiteboard_snapshot_gc_jobs(available_at,id) WHERE status='pending'`,
		`CREATE INDEX IF NOT EXISTS idx_whiteboard_snapshot_gc_jobs_processing_lease
			ON whiteboard_snapshot_gc_jobs(updated_at,id) WHERE status='processing'`,
	}
}

func migrateWhiteboards(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin whiteboard migration: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, statement := range whiteboardMigrations() {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("whiteboard migration failed: %w\nSQL: %s", err, statement)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit whiteboard migration: %w", err)
	}
	return nil
}
