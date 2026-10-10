package database

// Ownership is recorded only after a successful authenticated upload. Existing
// object paths, hashes and temporary preview tokens never backfill ownership.
func storageUploadOwnershipMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS storage_upload_ownership (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 object_key TEXT NOT NULL, actor_id UUID NOT NULL,
		 provenance_verified BOOLEAN NOT NULL DEFAULT FALSE,
		 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','attached','removed')),
		 first_uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 version BIGINT NOT NULL DEFAULT 1,
		 UNIQUE(account_id,object_key,actor_id), CHECK(object_key LIKE account_id::text || '/%')
		)`,
		`ALTER TABLE storage_upload_ownership ADD COLUMN IF NOT EXISTS filename TEXT NOT NULL DEFAULT ''`,
		`CREATE INDEX IF NOT EXISTS idx_storage_upload_ownership_actor ON storage_upload_ownership(account_id,actor_id,last_uploaded_at,id) WHERE state='active' AND provenance_verified`,
		`CREATE INDEX IF NOT EXISTS idx_storage_upload_ownership_object ON storage_upload_ownership(account_id,object_key,state)`,
	}
}
