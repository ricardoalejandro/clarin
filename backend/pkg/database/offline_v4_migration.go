package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Browser-only authority is additive. Native grants and their evidence are
// neither promoted nor weakened by this migration.
func migrateOfflineV4(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	statements := []string{
		`SELECT pg_advisory_xact_lock(hashtext('clarin_offline_v4_schema'))`,
		`CREATE TABLE IF NOT EXISTS offline_v4_browser_profiles (
		 id UUID PRIMARY KEY, signing_jwk JSONB NOT NULL, key_thumbprint VARCHAR(64) NOT NULL UNIQUE,
		 browser_name VARCHAR(80) NOT NULL, display_name VARCHAR(160) NOT NULL,
		 state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
		 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`CREATE TABLE IF NOT EXISTS offline_v4_enrollment_requests (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), browser_profile_id UUID NOT NULL REFERENCES offline_v4_browser_profiles(id),
		 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 state VARCHAR(16) NOT NULL DEFAULT 'requested' CHECK(state IN ('requested','approved','rejected')),
		 requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), decided_at TIMESTAMPTZ,
		 decided_by UUID REFERENCES users(id) ON DELETE SET NULL, decision_note VARCHAR(500) NOT NULL DEFAULT '')`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v4_pending ON offline_v4_enrollment_requests(browser_profile_id,user_id) WHERE state='requested'`,
		`CREATE TABLE IF NOT EXISTS offline_v4_grants (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), browser_profile_id UUID NOT NULL REFERENCES offline_v4_browser_profiles(id),
		 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 state VARCHAR(16) NOT NULL DEFAULT 'active' CHECK(state IN ('active','revoked')),
		 actions JSONB NOT NULL CHECK(jsonb_typeof(actions)='array'), max_resources INTEGER NOT NULL DEFAULT 20 CHECK(max_resources BETWEEN 1 AND 20),
		 quota_bytes BIGINT NOT NULL DEFAULT 536870912 CHECK(quota_bytes BETWEEN 1048576 AND 5368709120),
		 max_offline_seconds INTEGER NOT NULL DEFAULT 86400 CHECK(max_offline_seconds BETWEEN 60 AND 86400),
		 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), selection_revision BIGINT NOT NULL DEFAULT 1 CHECK(selection_revision>0),
		 selection_digest CHAR(64) NOT NULL DEFAULT '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
		 credential_epoch BIGINT NOT NULL CHECK(credential_epoch>0), authority_epoch BIGINT NOT NULL CHECK(authority_epoch>0),
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), revoked_at TIMESTAMPTZ,
		 approved_by UUID REFERENCES users(id) ON DELETE SET NULL, UNIQUE(id,account_id), UNIQUE(id,browser_profile_id,user_id,account_id))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v4_live_grant ON offline_v4_grants(browser_profile_id,user_id,account_id) WHERE state='active'`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v4_grant_user ON offline_v4_grants(user_id,browser_profile_id,state)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v4_grant_account ON offline_v4_grants(account_id,state)`,
		`CREATE TABLE IF NOT EXISTS offline_v4_grant_keys (
		 grant_id UUID PRIMARY KEY, account_id UUID NOT NULL, signing_jwk JSONB NOT NULL, key_thumbprint VARCHAR(64) NOT NULL,
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS offline_v4_selections (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 module VARCHAR(24) NOT NULL, resource_type VARCHAR(32) NOT NULL, resource_id UUID NOT NULL,
		 head_version BIGINT NOT NULL DEFAULT 0 CHECK(head_version>=0), content_hash CHAR(64), byte_size BIGINT NOT NULL DEFAULT 0 CHECK(byte_size>=0),
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE,
		 UNIQUE(grant_id,module,resource_type,resource_id), UNIQUE(id,grant_id,account_id))`,
		`ALTER TABLE offline_v4_selections ADD COLUMN IF NOT EXISTS byte_size BIGINT NOT NULL DEFAULT 0 CHECK(byte_size>=0)`,
		`CREATE TABLE IF NOT EXISTS offline_v4_challenges (
		 id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE, grant_id UUID REFERENCES offline_v4_grants(id) ON DELETE CASCADE,
		 purpose VARCHAR(24) NOT NULL CHECK(purpose IN ('enrollment','keys','sync')), nonce_hash BYTEA NOT NULL CHECK(octet_length(nonce_hash)=32),
		 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v4_challenge_expiry ON offline_v4_challenges(expires_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v4_receipts (
		 grant_id UUID NOT NULL, account_id UUID NOT NULL, operation_id UUID NOT NULL, request_hash CHAR(64) NOT NULL,
		 action_code VARCHAR(40) NOT NULL, resource_id UUID NOT NULL, status VARCHAR(24) NOT NULL,
		 error_code VARCHAR(80), server_version BIGINT NOT NULL DEFAULT 0, result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(grant_id,operation_id), FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS offline_v4_event_outbox (
		 id UUID PRIMARY KEY, grant_id UUID NOT NULL, account_id UUID NOT NULL, operation_id UUID NOT NULL,
		 event_type VARCHAR(40) NOT NULL, payload JSONB NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
		 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), processed_at TIMESTAMPTZ, last_error_code VARCHAR(80),
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE,
		 UNIQUE(grant_id,operation_id,event_type))`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v4_pending_effect ON offline_v4_event_outbox(next_attempt_at,id) WHERE processed_at IS NULL`,
		`CREATE TABLE IF NOT EXISTS offline_v4_audit (
		 id BIGSERIAL PRIMARY KEY, browser_profile_id UUID, grant_id UUID, account_id UUID, actor_id UUID,
		 event_type VARCHAR(60) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), metadata JSONB NOT NULL DEFAULT '{}'::jsonb)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline v4 migration: %w", err)
		}
	}
	return tx.Commit(ctx)
}
