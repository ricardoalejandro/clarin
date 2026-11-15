package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

func utilityMigrations() []string {
	return []string{
		`CREATE EXTENSION IF NOT EXISTS pg_trgm`,
		`CREATE TABLE IF NOT EXISTS utility_folders (
		 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
		 version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 UNIQUE(account_id,owner_id,id), CHECK(length(name) BETWEEN 1 AND 160))`,
		`CREATE TABLE IF NOT EXISTS utility_documents (
		 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 type TEXT NOT NULL CHECK(type IN ('json','qr','imagen-base64','criptografia')),
		 title TEXT NOT NULL, folder_id UUID, favorite BOOLEAN NOT NULL DEFAULT FALSE,
		 config JSONB NOT NULL DEFAULT '{}', version BIGINT NOT NULL DEFAULT 1,
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 UNIQUE(account_id,owner_id,id), CHECK(length(title) BETWEEN 1 AND 200),
		 FOREIGN KEY(account_id,owner_id,folder_id) REFERENCES utility_folders(account_id,owner_id,id))`,
		`CREATE INDEX IF NOT EXISTS utility_documents_owner_recent ON utility_documents(account_id,owner_id,updated_at DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS utility_documents_title ON utility_documents USING GIN(title gin_trgm_ops)`,
		`CREATE TABLE IF NOT EXISTS utility_content (
		 id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
		 account_id UUID NOT NULL, owner_id UUID NOT NULL, document_id UUID NOT NULL, slot TEXT NOT NULL,
		 version BIGINT NOT NULL DEFAULT 0, snapshot_version BIGINT NOT NULL DEFAULT 0, object_key TEXT NOT NULL,
		 bytes BIGINT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text/plain', indexed_version BIGINT NOT NULL DEFAULT -1,
		 PRIMARY KEY(account_id,owner_id,document_id,slot),
		 FOREIGN KEY(account_id,owner_id,document_id) REFERENCES utility_documents(account_id,owner_id,id) ON DELETE CASCADE,
		 CHECK(bytes BETWEEN 0 AND 62914560))`,
		`CREATE TABLE IF NOT EXISTS utility_changes (
		 account_id UUID NOT NULL, owner_id UUID NOT NULL, document_id UUID NOT NULL, slot TEXT NOT NULL,
		 version BIGINT NOT NULL, edits JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(account_id,owner_id,document_id,slot,version),
		 FOREIGN KEY(account_id,owner_id,document_id,slot) REFERENCES utility_content(account_id,owner_id,document_id,slot) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS utility_search_chunks (
		 account_id UUID NOT NULL, owner_id UUID NOT NULL, document_id UUID NOT NULL, slot TEXT NOT NULL,
		 version BIGINT NOT NULL, position INT NOT NULL, body TEXT NOT NULL,
		 PRIMARY KEY(account_id,owner_id,document_id,slot,position),
		 FOREIGN KEY(account_id,owner_id,document_id,slot) REFERENCES utility_content(account_id,owner_id,document_id,slot) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS utility_search_chunks_text ON utility_search_chunks USING GIN(body gin_trgm_ops)`,
		`CREATE TABLE IF NOT EXISTS utility_operations (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 operation_id UUID NOT NULL, resource_id UUID NOT NULL, fingerprint TEXT NOT NULL, result JSONB NOT NULL,
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(account_id,owner_id,operation_id))`,
		`CREATE INDEX IF NOT EXISTS utility_operations_expiry ON utility_operations(created_at)`,
		`CREATE TABLE IF NOT EXISTS utility_workspace (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 open_ids UUID[] NOT NULL DEFAULT '{}', active_id UUID, version BIGINT NOT NULL DEFAULT 0,
		 PRIMARY KEY(account_id,owner_id))`,
		`CREATE TABLE IF NOT EXISTS utility_vault (
		 id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL CHECK(kind IN ('aes','rsa','ec','certificate')),
		 algorithm TEXT NOT NULL, bits INT, public_data TEXT NOT NULL DEFAULT '', metadata JSONB NOT NULL DEFAULT '{}',
		 object_key TEXT NOT NULL, master_key_id TEXT NOT NULL, wrapped_key BYTEA NOT NULL,
		 version BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 UNIQUE(account_id,owner_id,id))`,
		`CREATE INDEX IF NOT EXISTS utility_vault_owner ON utility_vault(account_id,owner_id,created_at DESC,id DESC)`,
		`CREATE TABLE IF NOT EXISTS utility_objects (
		 id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 object_key TEXT NOT NULL, resource_id UUID NOT NULL, bytes BIGINT NOT NULL,
		 state TEXT NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','active','gc')),
		 available_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '24 hours', attempts INT NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',
		 PRIMARY KEY(account_id,object_key), FOREIGN KEY(account_id,object_key) REFERENCES storage_objects(account_id,object_key) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS utility_objects_gc_due ON utility_objects(available_at) WHERE state IN ('uploading','gc')`,
		`CREATE TABLE IF NOT EXISTS utility_content_jobs (
		 account_id UUID NOT NULL, owner_id UUID NOT NULL, document_id UUID NOT NULL, slot TEXT NOT NULL,
		 available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), attempts INT NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',
		 PRIMARY KEY(account_id,owner_id,document_id,slot),
		 FOREIGN KEY(account_id,owner_id,document_id,slot) REFERENCES utility_content(account_id,owner_id,document_id,slot) ON DELETE CASCADE)`,
		`ALTER TABLE utility_objects ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE utility_content_jobs ADD COLUMN IF NOT EXISTS last_error TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE utility_vault ADD COLUMN IF NOT EXISTS rotation_attempts INT NOT NULL DEFAULT 0`,
		`ALTER TABLE utility_vault ADD COLUMN IF NOT EXISTS rotation_error TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE utility_vault ADD COLUMN IF NOT EXISTS rotation_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
		// Existing entries have no provable document origin. Keep them intact;
		// recovery and any explicitly requested purge are separate operations.
		`ALTER TABLE utility_vault ADD COLUMN IF NOT EXISTS document_id UUID`,
		`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='utility_vault'::regclass AND conname='utility_vault_document_fk') THEN
		 ALTER TABLE utility_vault ADD CONSTRAINT utility_vault_document_fk FOREIGN KEY(account_id,owner_id,document_id)
		 REFERENCES utility_documents(account_id,owner_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED; END IF; END $$`,
		`CREATE INDEX IF NOT EXISTS utility_vault_document_recent ON utility_vault(account_id,owner_id,document_id,created_at DESC,id DESC)`,
	}
}

func migrateUtilities(ctx context.Context, db *pgxpool.Pool) error {
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, sql := range utilityMigrations() {
		if _, err = tx.Exec(ctx, sql); err != nil {
			return fmt.Errorf("utilities migration: %w", err)
		}
	}
	return tx.Commit(ctx)
}
