package database

// Program transfer metadata is private to the receiving Program. The file's
// portable identifiers confer no permissions and never point to another account.
func programTransferMigrations() []string {
	return []string{
		`ALTER TABLE program_session_observations ADD COLUMN IF NOT EXISTS transfer_author_name TEXT`,
		`ALTER TABLE program_participant_notes ADD COLUMN IF NOT EXISTS transfer_author_name TEXT`,
		`ALTER TABLE interactions ADD COLUMN IF NOT EXISTS transfer_author_name TEXT`,
		`CREATE TABLE IF NOT EXISTS program_transfer_links (
			account_id UUID NOT NULL,
			program_id UUID NOT NULL,
			kind TEXT NOT NULL,
			portable_id UUID NOT NULL,
			local_id UUID NOT NULL,
			baseline JSONB,
			PRIMARY KEY (account_id, program_id, kind, portable_id),
			FOREIGN KEY (account_id, program_id) REFERENCES programs(account_id, id) ON DELETE CASCADE,
			CHECK (baseline IS NULL OR jsonb_typeof(baseline) = 'object')
		)`,
		`CREATE INDEX IF NOT EXISTS idx_program_transfer_links_local ON program_transfer_links(account_id, program_id, kind, local_id)`,
		`CREATE INDEX IF NOT EXISTS idx_program_transfer_contact_identity ON program_transfer_links(account_id,portable_id,local_id) WHERE kind='contact'`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_program_transfer_logical_program ON program_transfer_links(account_id, portable_id) WHERE kind='program'`,
		`CREATE TABLE IF NOT EXISTS program_transfer_imports (
			id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
			account_id UUID NOT NULL,
			program_id UUID NOT NULL,
			actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
			summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			FOREIGN KEY (account_id, program_id) REFERENCES programs(account_id, id) ON DELETE CASCADE
		)`,
		`CREATE INDEX IF NOT EXISTS idx_program_transfer_imports_program ON program_transfer_imports(account_id, program_id, created_at DESC, id)`,
	}
}
