package database

// whatsappPeerIdentityMigration belongs to Migrate(), not seeding or a diagnostics job.
const whatsappPeerIdentityMigration = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_identity_account_id ON devices(account_id,id);
CREATE TABLE IF NOT EXISTS whatsapp_peer_identity_fields (
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 device_id UUID NOT NULL,
 jid TEXT NOT NULL CHECK (jid ~ '^[0-9]+@(s[.]whatsapp[.]net|lid)$'),
 field TEXT NOT NULL CHECK (field IN ('full_name','first_name','business_name','push_name','username','redacted_phone')),
 value TEXT NOT NULL,
 source TEXT NOT NULL,
 source_priority INT NOT NULL,
 observed_at TIMESTAMPTZ,
 received_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(account_id,device_id,jid,field),
 FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS whatsapp_peer_identity_aliases (
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 device_id UUID NOT NULL,
 pn_jid TEXT NOT NULL CHECK (pn_jid ~ '^[0-9]+@s[.]whatsapp[.]net$'),
 lid_jid TEXT NOT NULL CHECK (lid_jid ~ '^[0-9]+@lid$'),
 source TEXT NOT NULL,
 source_priority INT NOT NULL,
 observed_at TIMESTAMPTZ,
 received_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(account_id,device_id,pn_jid),
 UNIQUE(account_id,device_id,lid_jid),
 FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_peer_identity_name ON messages(account_id,device_id,from_jid,timestamp DESC,id DESC)
 WHERE is_from_me=FALSE AND NULLIF(BTRIM(from_name),'') IS NOT NULL;
`
