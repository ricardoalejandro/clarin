package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineV3 installs the browser-oriented offline model.  Nothing in
// this migration reads or promotes a v1/v2 terminal approval: v3 identities,
// grants, keys, counters and controls start empty and can therefore be rolled
// back by disabling the v3 feature flag without destroying historical data.
func migrateOfflineV3(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("offline v3 migration begin: %w", err)
	}
	defer tx.Rollback(ctx)

	statements := []string{
		`SELECT pg_advisory_xact_lock(hashtext('clarin_offline_v3_schema'))`,
		`ALTER TABLE users
			ADD COLUMN IF NOT EXISTS offline_credential_epoch BIGINT NOT NULL DEFAULT 1,
			ADD COLUMN IF NOT EXISTS offline_authority_epoch BIGINT NOT NULL DEFAULT 1`,
		`DO $$ BEGIN
			ALTER TABLE users ADD CONSTRAINT users_offline_credential_epoch_check CHECK (offline_credential_epoch > 0);
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`DO $$ BEGIN
			ALTER TABLE users ADD CONSTRAINT users_offline_authority_epoch_check CHECK (offline_authority_epoch > 0);
		EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_accounts_offline_v3_id ON accounts(id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_users_offline_v3_id ON users(id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_user_accounts_offline_v3_user_account ON user_accounts(user_id,account_id)`,

		`CREATE TABLE IF NOT EXISTS offline_v3_membership_epochs (
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			authority_epoch BIGINT NOT NULL DEFAULT 1 CHECK (authority_epoch > 0),
			active BOOLEAN NOT NULL DEFAULT TRUE,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(user_id,account_id)
		)`,
		`INSERT INTO offline_v3_membership_epochs(user_id,account_id,authority_epoch,active)
		 SELECT user_id,account_id,1,TRUE FROM user_accounts
		 ON CONFLICT(user_id,account_id) DO NOTHING`,

		`CREATE OR REPLACE FUNCTION offline_v3_bump_user_epochs() RETURNS TRIGGER AS $$
		BEGIN
			IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.username IS DISTINCT FROM OLD.username THEN
				NEW.offline_credential_epoch := OLD.offline_credential_epoch + 1;
			END IF;
			IF NEW.is_active IS DISTINCT FROM OLD.is_active
			   OR NEW.is_admin IS DISTINCT FROM OLD.is_admin
			   OR NEW.is_super_admin IS DISTINCT FROM OLD.is_super_admin
			   OR NEW.role IS DISTINCT FROM OLD.role THEN
				NEW.offline_authority_epoch := OLD.offline_authority_epoch + 1;
			END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_user_epochs ON users`,
		`CREATE TRIGGER trg_offline_v3_user_epochs BEFORE UPDATE OF password_hash,username,is_active,is_admin,is_super_admin,role
		 ON users FOR EACH ROW EXECUTE FUNCTION offline_v3_bump_user_epochs()`,

		`CREATE OR REPLACE FUNCTION offline_v3_membership_epoch_change() RETURNS TRIGGER AS $$
		DECLARE target_user UUID; target_account UUID; target_active BOOLEAN;
		BEGIN
			target_user := COALESCE(NEW.user_id,OLD.user_id);
			target_account := COALESCE(NEW.account_id,OLD.account_id);
			target_active := TG_OP <> 'DELETE';
			-- A direct membership removal keeps a durable inactive epoch so
			-- already-issued offline authority is revoked. During a parent
			-- users/accounts cascade, however, that parent is already absent;
			-- re-inserting the epoch would violate its cascading foreign key and
			-- block the ordinary online deletion even while v3 is disabled.
			IF TG_OP='DELETE' AND (
				NOT EXISTS(SELECT 1 FROM users WHERE id=target_user)
				OR NOT EXISTS(SELECT 1 FROM accounts WHERE id=target_account)
			) THEN
				RETURN OLD;
			END IF;
			INSERT INTO offline_v3_membership_epochs(user_id,account_id,authority_epoch,active,updated_at)
			VALUES(target_user,target_account,1,target_active,NOW())
			ON CONFLICT(user_id,account_id) DO UPDATE SET
				authority_epoch=offline_v3_membership_epochs.authority_epoch+1,
				active=EXCLUDED.active,updated_at=NOW();
			IF TG_OP='UPDATE' AND (OLD.user_id,OLD.account_id) IS DISTINCT FROM (NEW.user_id,NEW.account_id) THEN
				INSERT INTO offline_v3_membership_epochs(user_id,account_id,authority_epoch,active,updated_at)
				VALUES(OLD.user_id,OLD.account_id,1,FALSE,NOW())
				ON CONFLICT(user_id,account_id) DO UPDATE SET
					authority_epoch=offline_v3_membership_epochs.authority_epoch+1,
					active=FALSE,updated_at=NOW();
			END IF;
			IF TG_OP='DELETE' THEN
				RETURN OLD;
			END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_membership_epoch ON user_accounts`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_membership_epoch_insert_delete ON user_accounts`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_membership_epoch_update ON user_accounts`,
		`CREATE TRIGGER trg_offline_v3_membership_epoch_insert_delete AFTER INSERT OR DELETE
		 ON user_accounts FOR EACH ROW EXECUTE FUNCTION offline_v3_membership_epoch_change()`,
		`CREATE TRIGGER trg_offline_v3_membership_epoch_update AFTER UPDATE OF user_id,account_id,role,role_id
		 ON user_accounts FOR EACH ROW EXECUTE FUNCTION offline_v3_membership_epoch_change()`,

		`CREATE OR REPLACE FUNCTION offline_v3_role_epoch_change() RETURNS TRIGGER AS $$
		BEGIN
			IF NEW.permissions IS DISTINCT FROM OLD.permissions OR NEW.name IS DISTINCT FROM OLD.name THEN
				UPDATE offline_v3_membership_epochs epoch SET
					authority_epoch=epoch.authority_epoch+1,updated_at=NOW()
				FROM user_accounts membership
				WHERE membership.role_id=NEW.id AND epoch.user_id=membership.user_id
				  AND epoch.account_id=membership.account_id;
			END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_role_epoch ON roles`,
		`CREATE TRIGGER trg_offline_v3_role_epoch AFTER UPDATE OF permissions,name ON roles
		 FOR EACH ROW EXECUTE FUNCTION offline_v3_role_epoch_change()`,

		`CREATE OR REPLACE FUNCTION offline_v3_account_epoch_change() RETURNS TRIGGER AS $$
		BEGIN
			IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
				UPDATE offline_v3_membership_epochs SET authority_epoch=authority_epoch+1,updated_at=NOW()
				WHERE account_id=NEW.id;
			END IF;
			RETURN NEW;
		END $$ LANGUAGE plpgsql`,
		`DROP TRIGGER IF EXISTS trg_offline_v3_account_epoch ON accounts`,
		`CREATE TRIGGER trg_offline_v3_account_epoch AFTER UPDATE OF is_active ON accounts
		 FOR EACH ROW EXECUTE FUNCTION offline_v3_account_epoch_change()`,

		`CREATE TABLE IF NOT EXISTS offline_v3_installations (
			id UUID PRIMARY KEY,
			display_name VARCHAR(160) NOT NULL,
			platform VARCHAR(32) NOT NULL DEFAULT 'windows',
			client_version VARCHAR(40) NOT NULL,
			installation_signing_jwk JSONB NOT NULL,
			installation_key_thumbprint VARCHAR(64) NOT NULL UNIQUE,
			service_encryption_jwk JSONB NOT NULL,
			service_key_thumbprint VARCHAR(64) NOT NULL UNIQUE,
			state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','active','locked','revoked')),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			max_total_storage_bytes BIGINT NOT NULL DEFAULT 5368709120 CHECK (max_total_storage_bytes BETWEEN 1048576 AND 5368709120),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_seen_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ,
			UNIQUE(id,revision)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_windows_principals (
			id UUID PRIMARY KEY,
			installation_id UUID NOT NULL REFERENCES offline_v3_installations(id) ON DELETE CASCADE,
			sid_hash CHAR(64) NOT NULL,
			display_name VARCHAR(160) NOT NULL DEFAULT '',
			state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','active','locked','revoked')),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			revoked_at TIMESTAMPTZ,
			UNIQUE(id,installation_id),
			UNIQUE(installation_id,sid_hash)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_browser_profiles (
			id UUID PRIMARY KEY,
			installation_id UUID NOT NULL,
			windows_principal_id UUID NOT NULL,
			browser_dpop_jwk JSONB NOT NULL,
			browser_key_thumbprint VARCHAR(64) NOT NULL,
			browser_name VARCHAR(80) NOT NULL DEFAULT '',
			state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','active','locked','revoked')),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			revoked_at TIMESTAMPTZ,
			FOREIGN KEY(windows_principal_id,installation_id) REFERENCES offline_v3_windows_principals(id,installation_id) ON DELETE CASCADE,
			UNIQUE(id,installation_id,windows_principal_id),
			UNIQUE(windows_principal_id,browser_key_thumbprint)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_authorizations (
			id UUID PRIMARY KEY,
			installation_id UUID NOT NULL,
			windows_principal_id UUID NOT NULL,
			browser_profile_id UUID NOT NULL,
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','active','locked','revoked')),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			revoked_at TIMESTAMPTZ,
			FOREIGN KEY(browser_profile_id,installation_id,windows_principal_id)
			 REFERENCES offline_v3_browser_profiles(id,installation_id,windows_principal_id) ON DELETE CASCADE,
			UNIQUE(id,installation_id,windows_principal_id,browser_profile_id,user_id)
		)`,
		// Authorizations are immutable enrollment attempts. Keep their history so a
		// user can request access again after rejection/revocation, while allowing
		// only one undecided request for a browser/user at a time.
		`ALTER TABLE offline_v3_authorizations
			DROP CONSTRAINT IF EXISTS offline_v3_authorizations_browser_profile_id_user_id_key`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v3_authorization_pending_identity
			ON offline_v3_authorizations(browser_profile_id,user_id) WHERE state='requested'`,
		`CREATE TABLE IF NOT EXISTS offline_v3_enrollment_requests (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			installation_id UUID NOT NULL,
			windows_principal_id UUID NOT NULL,
			browser_profile_id UUID NOT NULL,
			authorization_id UUID NOT NULL,
			user_id UUID NOT NULL,
			state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK (state IN ('requested','approved','rejected','cancelled')),
			request_digest CHAR(64) NOT NULL,
			requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			decided_at TIMESTAMPTZ,
			decided_by UUID REFERENCES users(id) ON DELETE SET NULL,
			decision_note VARCHAR(500) NOT NULL DEFAULT '',
			FOREIGN KEY(authorization_id,installation_id,windows_principal_id,browser_profile_id,user_id)
			 REFERENCES offline_v3_authorizations(id,installation_id,windows_principal_id,browser_profile_id,user_id) ON DELETE CASCADE,
			UNIQUE(authorization_id),
			UNIQUE(id,user_id)
		)`,

		`CREATE TABLE IF NOT EXISTS offline_v3_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			authorization_id UUID NOT NULL,
			installation_id UUID NOT NULL,
			windows_principal_id UUID NOT NULL,
			browser_profile_id UUID NOT NULL,
			user_id UUID NOT NULL,
			account_id UUID NOT NULL,
			state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active','locked','revoked')),
			max_resources SMALLINT NOT NULL DEFAULT 20 CHECK (max_resources BETWEEN 1 AND 20),
			quota_bytes BIGINT NOT NULL CHECK (quota_bytes BETWEEN 1048576 AND 5368709120),
			max_offline_seconds INTEGER NOT NULL DEFAULT 259200 CHECK (max_offline_seconds BETWEEN 300 AND 259200),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			selection_revision BIGINT NOT NULL DEFAULT 1 CHECK (selection_revision > 0),
			selection_digest CHAR(64) NOT NULL DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
			last_authenticated_credential_epoch BIGINT NOT NULL CHECK (last_authenticated_credential_epoch > 0),
			last_authenticated_authority_epoch BIGINT NOT NULL CHECK (last_authenticated_authority_epoch > 0),
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			last_lease_issued_at TIMESTAMPTZ,
			last_lease_expires_at TIMESTAMPTZ,
			last_sync_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ,
			FOREIGN KEY(authorization_id,installation_id,windows_principal_id,browser_profile_id,user_id)
			 REFERENCES offline_v3_authorizations(id,installation_id,windows_principal_id,browser_profile_id,user_id) ON DELETE CASCADE,
			FOREIGN KEY(user_id,account_id) REFERENCES offline_v3_membership_epochs(user_id,account_id) ON DELETE CASCADE,
			UNIQUE(id,account_id),
			UNIQUE(authorization_id,account_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_grants_user ON offline_v3_grants(user_id,state,updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_grants_tuple ON offline_v3_grants(installation_id,windows_principal_id,browser_profile_id,user_id,account_id)`,
		// A replacement grant is allowed only after the prior tuple/account grant
		// is irreversibly revoked. Locked grants remain live and block duplicates.
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v3_live_grant_tuple_account
			ON offline_v3_grants(installation_id,windows_principal_id,browser_profile_id,user_id,account_id)
			WHERE state IN ('active','locked')`,
		`ALTER TABLE offline_v3_grants
			ADD COLUMN IF NOT EXISTS last_lease_issued_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS last_lease_expires_at TIMESTAMPTZ`,

		`CREATE TABLE IF NOT EXISTS offline_v3_grant_actions (
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			action_code VARCHAR(40) NOT NULL CHECK (action_code IN ('tasks.read','tasks.create','tasks.complete','contacts.read','programs.read','whiteboards.read')),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(grant_id,action_code),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_grant_keys (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
			signing_jwk JSONB NOT NULL,
			signing_key_thumbprint VARCHAR(64) NOT NULL,
			encryption_jwk JSONB NOT NULL,
			encryption_key_thumbprint VARCHAR(64) NOT NULL,
			state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active','retired','revoked')),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			retired_at TIMESTAMPTZ,
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			UNIQUE(grant_id,key_version),
			UNIQUE(grant_id,signing_key_thumbprint),
			UNIQUE(grant_id,encryption_key_thumbprint)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v3_grant_active_keys ON offline_v3_grant_keys(grant_id) WHERE state='active'`,

		`CREATE TABLE IF NOT EXISTS offline_v3_service_descriptors (
			browser_profile_id UUID PRIMARY KEY,
			installation_id UUID NOT NULL,
			windows_principal_id UUID NOT NULL,
			token TEXT NOT NULL,
			key_id VARCHAR(160) NOT NULL,
			key_version INTEGER NOT NULL CHECK (key_version >= 3),
			expires_at TIMESTAMPTZ NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(browser_profile_id,installation_id,windows_principal_id)
			 REFERENCES offline_v3_browser_profiles(id,installation_id,windows_principal_id) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_transport_credentials (
			grant_id UUID PRIMARY KEY,
			account_id UUID NOT NULL,
			secret_hash BYTEA NOT NULL CHECK (octet_length(secret_hash)=32),
			state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
			revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			rotated_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ,
			last_used_at TIMESTAMPTZ,
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE
		)`,

		`CREATE TABLE IF NOT EXISTS offline_v3_selections (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			module VARCHAR(32) NOT NULL CHECK (module IN ('tasks','contacts','programs','whiteboards')),
			resource_type VARCHAR(32) NOT NULL CHECK (resource_type IN ('task_list','contact','program','whiteboard')),
			resource_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			CONSTRAINT offline_v3_selection_module_type_check CHECK (
				(module='tasks' AND resource_type='task_list') OR
				(module='contacts' AND resource_type='contact') OR
				(module='programs' AND resource_type='program') OR
				(module='whiteboards' AND resource_type='whiteboard')),
			UNIQUE(grant_id,module,resource_type,resource_id),
			UNIQUE(id,grant_id,account_id)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_resource_heads (
			selection_id UUID PRIMARY KEY,
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			head_version BIGINT NOT NULL DEFAULT 1 CHECK (head_version > 0),
			content_hash CHAR(64),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(selection_id,grant_id,account_id) REFERENCES offline_v3_selections(id,grant_id,account_id) ON DELETE CASCADE,
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE
		)`,

		`CREATE TABLE IF NOT EXISTS offline_v3_challenges (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			purpose VARCHAR(24) NOT NULL CHECK (purpose IN ('enrollment','grant_keys','lease','sync','control_ack')),
			user_id UUID REFERENCES users(id) ON DELETE CASCADE,
			authorization_id UUID,
			grant_id UUID,
			account_id UUID,
			nonce_hash BYTEA NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			consumed_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			CONSTRAINT offline_v3_challenge_scope_check CHECK (
				(purpose='enrollment' AND user_id IS NOT NULL AND authorization_id IS NOT NULL AND grant_id IS NULL AND account_id IS NULL) OR
				(purpose<>'enrollment' AND user_id IS NULL AND authorization_id IS NULL AND grant_id IS NOT NULL AND account_id IS NOT NULL))
		)`,
		`ALTER TABLE offline_v3_challenges ADD COLUMN IF NOT EXISTS authorization_id UUID`,
		`DO $$
		DECLARE current_definition TEXT;
		BEGIN
			SELECT pg_get_constraintdef(oid) INTO current_definition FROM pg_constraint
			 WHERE conrelid='offline_v3_challenges'::regclass AND conname='offline_v3_challenge_scope_check';
			IF current_definition IS NOT NULL AND current_definition NOT LIKE '%authorization_id%' THEN
				ALTER TABLE offline_v3_challenges DROP CONSTRAINT offline_v3_challenge_scope_check;
				ALTER TABLE offline_v3_challenges ADD CONSTRAINT offline_v3_challenge_scope_check CHECK (
					(purpose='enrollment' AND user_id IS NOT NULL AND authorization_id IS NOT NULL AND grant_id IS NULL AND account_id IS NULL) OR
					(purpose<>'enrollment' AND user_id IS NULL AND authorization_id IS NULL AND grant_id IS NOT NULL AND account_id IS NOT NULL));
			END IF;
		END $$`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_challenges_expiry ON offline_v3_challenges(expires_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_counters (
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			last_counter BIGINT NOT NULL CHECK (last_counter > 0),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(grant_id),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE
		)`,

		`CREATE TABLE IF NOT EXISTS offline_v3_controls (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			installation_id UUID NOT NULL REFERENCES offline_v3_installations(id) ON DELETE CASCADE,
			grant_id UUID,
			account_id UUID,
			scope VARCHAR(24) NOT NULL CHECK (scope IN ('installation','windows_principal','browser_profile','authorization','grant','selection')),
			scope_id UUID NOT NULL,
			revision BIGINT NOT NULL CHECK (revision > 0),
			action VARCHAR(16) NOT NULL CHECK (action IN ('lock','wipe')),
			reason VARCHAR(32) NOT NULL CHECK (reason IN ('admin_revoked','credential_changed','authority_changed','account_disabled','user_disabled','selection_removed','security_lock')),
			token TEXT NOT NULL,
			key_id VARCHAR(160) NOT NULL,
			key_version INTEGER NOT NULL CHECK (key_version >= 3),
			created_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			delivered_at TIMESTAMPTZ,
			acknowledged_at TIMESTAMPTZ,
			acknowledgement JSONB,
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			CONSTRAINT offline_v3_control_grant_scope_check CHECK ((grant_id IS NULL)=(account_id IS NULL)),
			UNIQUE(installation_id,scope,scope_id,revision,action)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_controls_pending ON offline_v3_controls(installation_id,created_at,id) WHERE acknowledged_at IS NULL`,
		`DO $$
		DECLARE current_definition TEXT;
		BEGIN
			SELECT pg_get_constraintdef(oid) INTO current_definition FROM pg_constraint
			 WHERE conrelid='offline_v3_controls'::regclass AND conname='offline_v3_controls_scope_check';
			IF current_definition IS NOT NULL AND current_definition LIKE '%''principal''%' THEN
				ALTER TABLE offline_v3_controls DROP CONSTRAINT offline_v3_controls_scope_check;
				ALTER TABLE offline_v3_controls ADD CONSTRAINT offline_v3_controls_scope_check
				 CHECK (scope IN ('installation','windows_principal','browser_profile','authorization','grant','selection'));
			END IF;
		END $$`,

		`CREATE TABLE IF NOT EXISTS offline_v3_receipts (
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			operation_id UUID NOT NULL,
			request_hash CHAR(64) NOT NULL,
			action_code VARCHAR(40) NOT NULL,
			resource_id UUID NOT NULL,
			status VARCHAR(24) NOT NULL CHECK (status IN ('applied','noop','conflict','rejected')),
			error_code VARCHAR(64),
			server_version BIGINT,
			result JSONB NOT NULL DEFAULT '{}'::jsonb,
			sealed_result TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY(grant_id,operation_id),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_receipts_retention ON offline_v3_receipts(completed_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_conflicts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			operation_id UUID NOT NULL,
			resource_id UUID NOT NULL,
			base_version BIGINT NOT NULL,
			server_version BIGINT NOT NULL,
			client_change JSONB NOT NULL,
			server_value JSONB NOT NULL,
			status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_server','dismissed')),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			resolved_at TIMESTAMPTZ,
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			FOREIGN KEY(grant_id,operation_id) REFERENCES offline_v3_receipts(grant_id,operation_id) ON DELETE CASCADE,
			UNIQUE(grant_id,operation_id)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_v3_event_outbox (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			grant_id UUID NOT NULL,
			account_id UUID NOT NULL,
			operation_id UUID NOT NULL,
			event_type VARCHAR(64) NOT NULL,
			payload JSONB NOT NULL,
			attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
			next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			processed_at TIMESTAMPTZ,
			last_error_code VARCHAR(64),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE CASCADE,
			FOREIGN KEY(grant_id,operation_id) REFERENCES offline_v3_receipts(grant_id,operation_id) ON DELETE CASCADE,
			UNIQUE(grant_id,operation_id,event_type)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_outbox_pending ON offline_v3_event_outbox(next_attempt_at,id) WHERE processed_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS offline_v3_audit (
			id BIGSERIAL PRIMARY KEY,
			installation_id UUID,
			authorization_id UUID,
			grant_id UUID,
			account_id UUID,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			event_type VARCHAR(80) NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY(grant_id,account_id) REFERENCES offline_v3_grants(id,account_id) ON DELETE SET NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v3_audit_created ON offline_v3_audit(created_at DESC,id DESC)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline v3 migration: %w\nSQL: %s", err, statement)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("offline v3 migration commit: %w", err)
	}
	return nil
}
