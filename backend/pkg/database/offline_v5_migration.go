package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Offline v5 reuses the v4 browser/grant key hierarchy, but keeps policy,
// manifests, capabilities and receipts in an additive schema. Nothing in this
// migration promotes an existing v4 grant to editable v5 authority.
func migrateOfflineV5(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	statements := []string{
		`SELECT pg_advisory_xact_lock(hashtext('clarin_offline_v5_schema'))`,
		`CREATE TABLE IF NOT EXISTS offline_v5_grant_policies (
		 grant_id UUID PRIMARY KEY, account_id UUID NOT NULL,
		 modules JSONB NOT NULL CHECK(jsonb_typeof(modules)='array'),
		 revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
		 prepare_enabled BOOLEAN NOT NULL DEFAULT TRUE,
		 writes_enabled BOOLEAN NOT NULL DEFAULT FALSE,
		 blob_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v5_policy_account ON offline_v5_grant_policies(account_id,grant_id)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_manifests (
		 id UUID PRIMARY KEY, grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 revision BIGINT NOT NULL CHECK(revision>0), selection_revision BIGINT NOT NULL CHECK(selection_revision>0),
		 selection_digest CHAR(64) NOT NULL, digest CHAR(64) NOT NULL,
		 canonical_json BYTEA NOT NULL, manifest_json JSONB NOT NULL,
		 issued_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
		 superseded_at TIMESTAMPTZ,
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE,
		 UNIQUE(grant_id,revision), UNIQUE(id,grant_id,account_id),
		 CHECK(expires_at>issued_at AND expires_at<=issued_at+INTERVAL '24 hours'))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_v5_current_manifest ON offline_v5_manifests(grant_id) WHERE superseded_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v5_manifest_expiry ON offline_v5_manifests(expires_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_manifest_roots (
		 manifest_id UUID NOT NULL, grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 selection_id UUID NOT NULL, module VARCHAR(24) NOT NULL, resource_type VARCHAR(32) NOT NULL,
		 resource_id UUID NOT NULL, head_version BIGINT NOT NULL CHECK(head_version>=0), content_hash CHAR(64) NOT NULL,
		 PRIMARY KEY(manifest_id,selection_id),
		 FOREIGN KEY(manifest_id,grant_id,account_id) REFERENCES offline_v5_manifests(id,grant_id,account_id) ON DELETE CASCADE,
		 FOREIGN KEY(selection_id,grant_id,account_id) REFERENCES offline_v4_selections(id,grant_id,account_id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_manifest_dependencies (
		 manifest_id UUID NOT NULL, grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 root_selection_id UUID NOT NULL, module VARCHAR(24) NOT NULL, resource_type VARCHAR(40) NOT NULL,
		 resource_id VARCHAR(160) NOT NULL, access_mode VARCHAR(12) NOT NULL CHECK(access_mode IN ('read','edit')),
		 PRIMARY KEY(manifest_id,root_selection_id,module,resource_type,resource_id),
		 FOREIGN KEY(manifest_id,grant_id,account_id) REFERENCES offline_v5_manifests(id,grant_id,account_id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_manifest_capabilities (
		 manifest_id UUID NOT NULL, grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 action_code VARCHAR(64) NOT NULL, selection_id UUID NOT NULL,
		 root_resource_id UUID NOT NULL, resource_type VARCHAR(40) NOT NULL, resource_id UUID NOT NULL,
		 PRIMARY KEY(manifest_id,action_code,selection_id,resource_id),
		 FOREIGN KEY(manifest_id,grant_id,account_id) REFERENCES offline_v5_manifests(id,grant_id,account_id) ON DELETE CASCADE,
		 CONSTRAINT fk_offline_v5_capability_root FOREIGN KEY(manifest_id,selection_id)
		  REFERENCES offline_v5_manifest_roots(manifest_id,selection_id) ON DELETE CASCADE)`,
		`DO $$ BEGIN
		 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fk_offline_v5_capability_root'
		  AND conrelid='offline_v5_manifest_capabilities'::regclass) THEN
		  ALTER TABLE offline_v5_manifest_capabilities ADD CONSTRAINT fk_offline_v5_capability_root
		   FOREIGN KEY(manifest_id,selection_id) REFERENCES offline_v5_manifest_roots(manifest_id,selection_id) ON DELETE CASCADE;
		 END IF;
		END $$`,
		`CREATE TABLE IF NOT EXISTS offline_v5_challenges (
		 id UUID PRIMARY KEY, user_id UUID REFERENCES users(id) ON DELETE CASCADE,
		 grant_id UUID REFERENCES offline_v4_grants(id) ON DELETE CASCADE,
		 purpose VARCHAR(24) NOT NULL CHECK(purpose IN ('enrollment','keys','prepare','sync','blob')),
		 nonce_hash BYTEA NOT NULL CHECK(octet_length(nonce_hash)=32),
		 expires_at TIMESTAMPTZ NOT NULL, consumed_at TIMESTAMPTZ)`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v5_challenge_expiry ON offline_v5_challenges(expires_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_receipts (
		 grant_id UUID NOT NULL, account_id UUID NOT NULL, manifest_id UUID NOT NULL,
		 operation_id UUID NOT NULL, request_hash CHAR(64) NOT NULL, intent_hash CHAR(64) NOT NULL, action_code VARCHAR(64) NOT NULL,
		 selection_id UUID NOT NULL, resource_id UUID NOT NULL,
		 status VARCHAR(24) NOT NULL CHECK(status IN ('applied','merged','noop','conflict','pending','rejected')),
		 error_code VARCHAR(80), server_version BIGINT NOT NULL DEFAULT 0,
		 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(grant_id,operation_id),
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE,
			 FOREIGN KEY(manifest_id,grant_id,account_id) REFERENCES offline_v5_manifests(id,grant_id,account_id) ON DELETE CASCADE)`,
		`ALTER TABLE offline_v5_receipts ADD COLUMN IF NOT EXISTS intent_hash CHAR(64)`,
		// Releases before pending receipts used request_hash as their only
		// identity. They never persisted pending rows, so this conservative
		// backfill keeps terminal receipts valid while refusing unsafe rebinding.
		`UPDATE offline_v5_receipts SET intent_hash=request_hash WHERE intent_hash IS NULL`,
		`ALTER TABLE offline_v5_receipts ALTER COLUMN intent_hash SET NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_offline_v5_receipt_manifest ON offline_v5_receipts(manifest_id,created_at)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_blobs (
		 id UUID PRIMARY KEY, grant_id UUID NOT NULL, account_id UUID NOT NULL, manifest_id UUID NOT NULL,
		 operation_id UUID NOT NULL, selection_id UUID NOT NULL, module VARCHAR(24) NOT NULL,
		 resource_id UUID NOT NULL, content_type VARCHAR(120) NOT NULL, filename VARCHAR(255) NOT NULL,
		 size_bytes BIGINT NOT NULL CHECK(size_bytes BETWEEN 1 AND 52428800), content_hash CHAR(64) NOT NULL,
		 chunk_size INTEGER NOT NULL CHECK(chunk_size BETWEEN 65536 AND 2097152),
		 state VARCHAR(16) NOT NULL DEFAULT 'staging' CHECK(state IN ('staging','complete','abandoned')),
		 object_key TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
		 FOREIGN KEY(grant_id,account_id) REFERENCES offline_v4_grants(id,account_id) ON DELETE CASCADE,
			 FOREIGN KEY(manifest_id,grant_id,account_id) REFERENCES offline_v5_manifests(id,grant_id,account_id) ON DELETE CASCADE,
		 UNIQUE(grant_id,operation_id), UNIQUE(id,grant_id,account_id))`,
		`CREATE TABLE IF NOT EXISTS offline_v5_blob_chunks (
		 blob_id UUID NOT NULL, grant_id UUID NOT NULL, account_id UUID NOT NULL,
		 chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), content_hash CHAR(64) NOT NULL,
		 size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152), received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(blob_id,chunk_index),
		 FOREIGN KEY(blob_id,grant_id,account_id) REFERENCES offline_v5_blobs(id,grant_id,account_id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS offline_v5_audit (
		 id BIGSERIAL PRIMARY KEY, browser_profile_id UUID, grant_id UUID, account_id UUID, actor_id UUID,
		 event_type VARCHAR(60) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 metadata JSONB NOT NULL DEFAULT '{}'::jsonb)`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline v5 migration: %w", err)
		}
	}
	return tx.Commit(ctx)
}
