package database

// Automation tables are runtime dependencies of the policy and workers. They
// must exist after Migrate even when administrator seeding is skipped.
const automationRuntimeMigration = `
CREATE TABLE IF NOT EXISTS automations (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 trigger_type TEXT NOT NULL,
 trigger_config JSONB NOT NULL DEFAULT '{}',
 config JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
 is_active BOOLEAN NOT NULL DEFAULT TRUE,
 execution_count INTEGER NOT NULL DEFAULT 0,
 last_triggered_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_automations_account ON automations(account_id);
CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(account_id,trigger_type) WHERE is_active=TRUE;
CREATE TABLE IF NOT EXISTS automation_executions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
 account_id UUID NOT NULL,
 lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 current_node_id TEXT NOT NULL DEFAULT '',
 next_node_id TEXT NOT NULL DEFAULT '',
 resume_at TIMESTAMPTZ,
 config_snapshot JSONB,
 context_data JSONB NOT NULL DEFAULT '{}',
 error_message TEXT NOT NULL DEFAULT '',
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 completed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_exec_paused ON automation_executions(resume_at) WHERE status='paused';
CREATE INDEX IF NOT EXISTS idx_auto_exec_dedup ON automation_executions(automation_id,lead_id,created_at) WHERE status IN ('pending','running','paused');
CREATE INDEX IF NOT EXISTS idx_auto_exec_account ON automation_executions(account_id,created_at DESC);
CREATE TABLE IF NOT EXISTS automation_execution_logs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 execution_id UUID NOT NULL REFERENCES automation_executions(id) ON DELETE CASCADE,
 node_id TEXT NOT NULL,
 node_type TEXT NOT NULL,
 status TEXT NOT NULL,
 duration_ms INTEGER NOT NULL DEFAULT 0,
 error TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auto_exec_logs ON automation_execution_logs(execution_id,created_at);
`
