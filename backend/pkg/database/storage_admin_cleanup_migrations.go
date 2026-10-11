package database

// Server administration has its own durable tombstones. These are not user
// recovery entries and must never make unknown or technical files readable.
func storageAdminCleanupMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS storage_admin_delete_intents (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 object_key TEXT NOT NULL, actor_id UUID NOT NULL,
		 size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
		 state TEXT NOT NULL DEFAULT 'purging' CHECK(state IN ('purging','purged')),
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(account_id,object_key), CHECK(object_key LIKE account_id::text || '/%')
		)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_admin_delete_intents_pending ON storage_admin_delete_intents(account_id,created_at) WHERE state='purging'`,
	}
}
