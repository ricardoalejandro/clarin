package database

func whatsappContinuityMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS whatsapp_conversation_owners (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 own_pn TEXT,own_lid TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(account_id,id),CHECK(own_pn IS NOT NULL OR own_lid IS NOT NULL))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_owner_pn ON whatsapp_conversation_owners(account_id,own_pn) WHERE own_pn IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_owner_lid ON whatsapp_conversation_owners(account_id,own_lid) WHERE own_lid IS NOT NULL`,
		// device_id deliberately has no FK: deleting a companion must preserve origin.
		`CREATE TABLE IF NOT EXISTS whatsapp_device_owner_epochs (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 device_id UUID NOT NULL,owner_id UUID NOT NULL,session_fingerprint TEXT NOT NULL,
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),ended_at TIMESTAMPTZ,
 FOREIGN KEY(account_id,owner_id) REFERENCES whatsapp_conversation_owners(account_id,id),
 UNIQUE(account_id,device_id,session_fingerprint))`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_device_owner_active ON whatsapp_device_owner_epochs(account_id,device_id) WHERE ended_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_whatsapp_owner_epochs_owner ON whatsapp_device_owner_epochs(account_id,owner_id,device_id)`,
		`CREATE TABLE IF NOT EXISTS whatsapp_group_device_bindings(account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 owner_id UUID NOT NULL,jid TEXT NOT NULL,device_id UUID NOT NULL,observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id,owner_id,jid,device_id),FOREIGN KEY(account_id,owner_id) REFERENCES whatsapp_conversation_owners(account_id,id))`,
		`ALTER TABLE chats ADD COLUMN IF NOT EXISTS whatsapp_owner_id UUID`,
		`ALTER TABLE chats ADD COLUMN IF NOT EXISTS canonical_chat_id UUID`,
		`ALTER TABLE chats ADD COLUMN IF NOT EXISTS binding_revision BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE chats ADD COLUMN IF NOT EXISTS binding_state TEXT NOT NULL DEFAULT 'pending'`,
		`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_chat_whatsapp_owner') THEN ALTER TABLE chats ADD CONSTRAINT fk_chat_whatsapp_owner FOREIGN KEY(account_id,whatsapp_owner_id) REFERENCES whatsapp_conversation_owners(account_id,id);END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_chat_canonical_conversation') THEN ALTER TABLE chats ADD CONSTRAINT fk_chat_canonical_conversation FOREIGN KEY(account_id,canonical_chat_id) REFERENCES chats(account_id,id);END IF;END $$`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_group_owner ON chats(account_id,whatsapp_owner_id,jid) WHERE whatsapp_owner_id IS NOT NULL AND canonical_chat_id IS NULL AND jid LIKE '%@g.us'`,
		`CREATE INDEX IF NOT EXISTS idx_chat_canonical_conversation ON chats(account_id,canonical_chat_id) WHERE canonical_chat_id IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_messages_account_id ON messages(account_id,id)`,
		`CREATE TABLE IF NOT EXISTS whatsapp_message_aliases(account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 alias_message_id UUID NOT NULL,canonical_message_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id,alias_message_id),CHECK(alias_message_id<>canonical_message_id),
 FOREIGN KEY(account_id,alias_message_id) REFERENCES messages(account_id,id) ON DELETE CASCADE,
 FOREIGN KEY(account_id,canonical_message_id) REFERENCES messages(account_id,id) ON DELETE CASCADE)`,
		`CREATE INDEX IF NOT EXISTS idx_whatsapp_message_alias_canonical ON whatsapp_message_aliases(account_id,canonical_message_id)`,
	}
}
