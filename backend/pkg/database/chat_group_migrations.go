package database

func chatGroupMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS chat_group_message_state(account_id UUID NOT NULL,chat_id UUID NOT NULL,message_id TEXT NOT NULL,revoked BOOLEAN NOT NULL DEFAULT FALSE,edited_body TEXT,edited_mentions JSONB,edited_at TIMESTAMPTZ,PRIMARY KEY(account_id,chat_id,message_id),FOREIGN KEY(account_id,chat_id) REFERENCES chats(account_id,id) ON DELETE CASCADE)`,
		`ALTER TABLE chat_group_message_state ADD COLUMN IF NOT EXISTS edited_mentions JSONB`,
		`CREATE OR REPLACE FUNCTION clarin_apply_group_message_state() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE state RECORD; BEGIN
 SELECT revoked,edited_body,edited_mentions INTO state FROM chat_group_message_state WHERE account_id=NEW.account_id AND chat_id=NEW.chat_id AND message_id=NEW.message_id;
 IF FOUND THEN IF state.revoked THEN NEW.is_revoked=TRUE;NEW.body=NULL;ELSIF state.edited_body IS NOT NULL THEN NEW.is_edited=TRUE;NEW.body=state.edited_body;NEW.group_mentions=COALESCE(state.edited_mentions,NEW.group_mentions);END IF;END IF;RETURN NEW;END $$`,
		`DROP TRIGGER IF EXISTS group_message_state ON messages;CREATE TRIGGER group_message_state BEFORE INSERT ON messages FOR EACH ROW EXECUTE FUNCTION clarin_apply_group_message_state()`,

		`CREATE TABLE IF NOT EXISTS chat_group_media_recovery(account_id UUID NOT NULL,chat_id UUID NOT NULL,message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,payload BYTEA NOT NULL,locked_until TIMESTAMPTZ,attempted_at TIMESTAMPTZ,PRIMARY KEY(account_id,message_id),FOREIGN KEY(account_id,chat_id) REFERENCES chats(account_id,id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS chat_groups (
 account_id UUID NOT NULL,chat_id UUID NOT NULL,subject TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',
 membership_status TEXT NOT NULL DEFAULT 'unknown',announce BOOLEAN NOT NULL DEFAULT FALSE,is_admin BOOLEAN NOT NULL DEFAULT FALSE,
 suspended BOOLEAN NOT NULL DEFAULT FALSE,kind TEXT NOT NULL DEFAULT 'group',participants JSONB NOT NULL DEFAULT '[]'::jsonb,synced_at TIMESTAMPTZ,
 PRIMARY KEY(account_id,chat_id),FOREIGN KEY(account_id,chat_id) REFERENCES chats(account_id,id) ON DELETE CASCADE,
 CHECK(membership_status IN ('unknown','member','left')),CHECK(kind IN ('group','announcement','community')))`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS group_mentions JSONB NOT NULL DEFAULT '[]'::jsonb`,
		`CREATE TABLE IF NOT EXISTS chat_group_receipts (
 account_id UUID NOT NULL,chat_id UUID NOT NULL,message_id TEXT NOT NULL,sender_jid TEXT NOT NULL,
 delivered_at TIMESTAMPTZ,read_at TIMESTAMPTZ,PRIMARY KEY(account_id,chat_id,message_id,sender_jid),
 FOREIGN KEY(account_id,chat_id) REFERENCES chats(account_id,id) ON DELETE CASCADE)`,
		`CREATE TABLE IF NOT EXISTS chat_group_hidden (account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 channel_key TEXT NOT NULL,jid TEXT NOT NULL,hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(account_id,channel_key,jid))`,
		`CREATE INDEX IF NOT EXISTS idx_chats_group_channel_activity ON chats(account_id,channel_key,last_message_at DESC,id) WHERE jid LIKE '%@g.us'`,
		// Keep old groups readable in their original device perspective. Never merge group histories.
		`UPDATE chats SET channel_key='whatsapp_web_group:'||device_id::text WHERE jid LIKE '%@g.us' AND channel_key='whatsapp_web' AND device_id IS NOT NULL`,
		`UPDATE contacts SET phone=NULL WHERE is_group=TRUE AND jid LIKE '%@g.us'`,
		`CREATE OR REPLACE FUNCTION clarin_group_no_attention() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.jid LIKE '%@g.us' THEN NEW.waiting_since=NULL;NEW.attention_through_at=NULL;NEW.attention_through_id=NULL;END IF;RETURN NEW;END $$`,
		`DROP TRIGGER IF EXISTS group_no_attention ON chats; CREATE TRIGGER group_no_attention BEFORE INSERT OR UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION clarin_group_no_attention()`,
		`UPDATE chats SET waiting_since=NULL,attention_through_at=NULL,attention_through_id=NULL WHERE jid LIKE '%@g.us' AND (waiting_since IS NOT NULL OR attention_through_at IS NOT NULL)`,
		`CREATE OR REPLACE FUNCTION clarin_group_local_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.jid LIKE '%@g.us' AND EXISTS(SELECT 1 FROM accounts WHERE id=OLD.account_id) THEN INSERT INTO chat_group_hidden(account_id,channel_key,jid) VALUES(OLD.account_id,OLD.channel_key,OLD.jid)
 ON CONFLICT(account_id,channel_key,jid) DO UPDATE SET hidden_at=NOW(); END IF;RETURN OLD;END $$`,
		`DROP TRIGGER IF EXISTS group_local_delete ON chats; CREATE TRIGGER group_local_delete BEFORE DELETE ON chats FOR EACH ROW EXECUTE FUNCTION clarin_group_local_delete()`,
	}
}
