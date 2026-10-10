package database

// The self-service ledger owns only intentional media removals. It is not a
// replacement for the independent Work/whiteboard retention lifecycles.
func storageSelfServiceMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS storage_cleanup_previews (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 actor_id UUID NOT NULL,
		 action TEXT NOT NULL CHECK (action IN ('trash','restore','purge')),
		 items JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
		 completed_at TIMESTAMPTZ, result JSONB, last_retried_by UUID
		)`,
		`ALTER TABLE storage_cleanup_previews DROP CONSTRAINT IF EXISTS storage_cleanup_previews_actor_id_fkey`,
		`ALTER TABLE storage_cleanup_previews ADD COLUMN IF NOT EXISTS last_retried_by UUID`,
		`CREATE INDEX IF NOT EXISTS idx_storage_cleanup_previews_actor ON storage_cleanup_previews(account_id,actor_id,created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS storage_media_trash (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 object_key TEXT NOT NULL, actor_id UUID NOT NULL,
		 filename TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
		 message_backups JSONB NOT NULL, removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), purge_after TIMESTAMPTZ NOT NULL,
		 state TEXT NOT NULL DEFAULT 'trash' CHECK (state IN ('trash','restored','purging','purged')),
		 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(account_id,object_key),
		 CHECK(object_key LIKE account_id::text || '/%')
		)`,
		`ALTER TABLE storage_media_trash DROP CONSTRAINT IF EXISTS storage_media_trash_actor_id_fkey`,
		`CREATE INDEX IF NOT EXISTS idx_storage_media_trash_actor ON storage_media_trash(account_id,actor_id,state,purge_after)`,
	}
}
