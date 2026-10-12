package database

// Included in Migrate, never in a seed/bootstrap-only path.
const leadPolicyMigration = `
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS leads_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lead_automation_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS leads_policy_version BIGINT NOT NULL DEFAULT 1;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS lead_automation_enabled_since TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS account_lead_policy_audit (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 actor_id UUID NOT NULL, previous_policy JSONB NOT NULL, next_policy JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_lead_policy_audit ON account_lead_policy_audit(account_id,created_at DESC);
`
