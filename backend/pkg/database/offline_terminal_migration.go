package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineTerminals installs the durable control plane for explicitly
// approved Windows terminals. Payload tables are account-scoped; the terminal
// itself is global because one approved user/PC pair may receive grants for
// several accounts.
func migrateOfflineTerminals(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS offline_terminals (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			display_name VARCHAR(160) NOT NULL,
			platform VARCHAR(32) NOT NULL DEFAULT 'windows' CHECK (platform = 'windows'),
			windows_sid_hash VARCHAR(64),
			public_key_pem TEXT,
			state VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked')),
			client_version VARCHAR(64),
			max_storage_bytes BIGINT NOT NULL DEFAULT 5368709120 CHECK (max_storage_bytes > 0 AND max_storage_bytes <= 5368709120),
			policy_revision BIGINT NOT NULL DEFAULT 1,
			created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			activated_at TIMESTAMPTZ,
			revoked_at TIMESTAMPTZ,
			last_seen_at TIMESTAMPTZ,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE (id, user_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_terminals_user ON offline_terminals(user_id, state)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_terminal_user_sid_active ON offline_terminals(user_id,windows_sid_hash) WHERE windows_sid_hash IS NOT NULL AND state<>'revoked'`,
		`CREATE TABLE IF NOT EXISTS offline_terminal_grants (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			terminal_id UUID NOT NULL,
			user_id UUID NOT NULL,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			modules TEXT[] NOT NULL DEFAULT '{}',
			actions JSONB NOT NULL DEFAULT '{}'::jsonb,
			max_offline_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (max_offline_seconds > 0 AND max_offline_seconds <= 86400),
			quota_bytes BIGINT NOT NULL DEFAULT 5368709120 CHECK (quota_bytes > 0 AND quota_bytes <= 5368709120),
			state VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
			policy_revision BIGINT NOT NULL DEFAULT 1,
			granted_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			revoked_at TIMESTAMPTZ,
			UNIQUE (terminal_id, account_id),
			UNIQUE (id, account_id),
			FOREIGN KEY (terminal_id, user_id) REFERENCES offline_terminals(id, user_id) ON DELETE CASCADE,
			FOREIGN KEY (user_id, account_id) REFERENCES user_accounts(user_id, account_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_grants_account ON offline_terminal_grants(account_id, state)`,
		`CREATE TABLE IF NOT EXISTS offline_resource_selections (
			grant_id UUID NOT NULL REFERENCES offline_terminal_grants(id) ON DELETE CASCADE,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			module VARCHAR(32) NOT NULL CHECK (module IN ('whiteboards','tasks','contacts','programs')),
			resource_type VARCHAR(48) NOT NULL,
			resource_id UUID NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (grant_id, module, resource_type, resource_id),
			FOREIGN KEY (grant_id, account_id) REFERENCES offline_terminal_grants(id, account_id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_resources_account ON offline_resource_selections(account_id, module, resource_id)`,
		`CREATE TABLE IF NOT EXISTS offline_sync_nonces (
			terminal_id UUID NOT NULL REFERENCES offline_terminals(id) ON DELETE CASCADE,
			nonce_hash BYTEA NOT NULL,
			expires_at TIMESTAMPTZ NOT NULL,
			consumed_at TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (terminal_id, nonce_hash)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_sync_receipts (
			id BIGSERIAL PRIMARY KEY,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			terminal_id UUID NOT NULL REFERENCES offline_terminals(id) ON DELETE CASCADE,
			operation_id UUID NOT NULL,
			request_hash BYTEA NOT NULL,
			status VARCHAR(24) NOT NULL CHECK (status IN ('applied','conflict','rejected')),
			result JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE (account_id, terminal_id, operation_id)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_change_log (
			seq BIGSERIAL PRIMARY KEY,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			module VARCHAR(32) NOT NULL CHECK (module IN ('whiteboards','tasks','contacts','programs')),
			resource_type VARCHAR(48) NOT NULL,
			resource_id UUID NOT NULL,
			change_kind VARCHAR(24) NOT NULL CHECK (change_kind IN ('snapshot','upsert','tombstone')),
			resource_version BIGINT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}'::jsonb,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_change_feed ON offline_change_log(account_id, seq)`,
		`CREATE TABLE IF NOT EXISTS offline_terminal_cursors (
			terminal_id UUID NOT NULL REFERENCES offline_terminals(id) ON DELETE CASCADE,
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			last_seq BIGINT NOT NULL DEFAULT 0,
			last_counter BIGINT NOT NULL DEFAULT 0,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (terminal_id, account_id)
		)`,
		`CREATE TABLE IF NOT EXISTS offline_sync_conflicts (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			terminal_id UUID NOT NULL REFERENCES offline_terminals(id) ON DELETE CASCADE,
			operation_id UUID NOT NULL,
			module VARCHAR(32) NOT NULL,
			resource_type VARCHAR(48) NOT NULL,
			resource_id UUID NOT NULL,
			server_version BIGINT NOT NULL,
			client_version BIGINT NOT NULL,
			server_value JSONB NOT NULL,
			client_value JSONB NOT NULL,
			status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved_server','resolved_client','resolved_merged')),
			resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			resolved_at TIMESTAMPTZ,
			UNIQUE (account_id, terminal_id, operation_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_conflicts_account ON offline_sync_conflicts(account_id, status, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS offline_terminal_audit (
			id BIGSERIAL PRIMARY KEY,
			terminal_id UUID REFERENCES offline_terminals(id) ON DELETE SET NULL,
			account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			event_type VARCHAR(64) NOT NULL,
			metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_audit_retention ON offline_terminal_audit(created_at)`,
		`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS offline_version BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS offline_version BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE program_participants ADD COLUMN IF NOT EXISTS offline_version BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE program_attendance ADD COLUMN IF NOT EXISTS offline_version BIGINT NOT NULL DEFAULT 1`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline terminal migration: %w", err)
		}
	}
	return nil
}
