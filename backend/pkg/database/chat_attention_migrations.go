package database

func chatAttentionMigrations() []string {
	return []string{
		`ALTER TABLE chats ADD COLUMN IF NOT EXISTS waiting_since TIMESTAMPTZ,
		 ADD COLUMN IF NOT EXISTS attention_through_at TIMESTAMPTZ,
		 ADD COLUMN IF NOT EXISTS attention_through_id UUID,
		 ADD COLUMN IF NOT EXISTS state_version BIGINT NOT NULL DEFAULT 0`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender JSONB,
		 ADD COLUMN IF NOT EXISTS attention_through_at TIMESTAMPTZ,
		 ADD COLUMN IF NOT EXISTS attention_through_id UUID,
		 ADD COLUMN IF NOT EXISTS defer_attention BOOLEAN NOT NULL DEFAULT FALSE,
		 ADD COLUMN IF NOT EXISTS send_operation_id UUID`,
		`CREATE INDEX IF NOT EXISTS idx_messages_unread_account_chat ON messages(account_id,chat_id)
		 WHERE NOT is_from_me AND NOT is_read AND NOT COALESCE(is_revoked,FALSE)`,
		`CREATE INDEX IF NOT EXISTS idx_messages_attention_boundary ON messages(account_id,chat_id,timestamp,id) WHERE NOT is_from_me AND NOT COALESCE(is_revoked,FALSE) AND COALESCE(sender->>'origin','')<>'history'`,
		`CREATE INDEX IF NOT EXISTS idx_chats_attention_queue ON chats(account_id,waiting_since,id)
		 WHERE waiting_since IS NOT NULL AND NOT is_archived`,
		`CREATE INDEX IF NOT EXISTS idx_messages_send_operation ON messages(account_id,send_operation_id)
		 WHERE send_operation_id IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS chat_send_operations (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 id UUID NOT NULL, user_id UUID NOT NULL, request_hash TEXT NOT NULL,
		 state TEXT NOT NULL DEFAULT 'sending', response JSONB,
		 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 PRIMARY KEY(account_id,id)
		)`,
		`ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS items JSONB NOT NULL DEFAULT '[]'::jsonb`,
		// Versioned once: neither a restart nor historical re-import resets a user's attention decisions.
		`DO $$ BEGIN
		 IF NOT EXISTS (SELECT 1 FROM migration_flags WHERE key='chat_attention_20260921') THEN
		  UPDATE chats c SET attention_through_at=m.timestamp, attention_through_id=m.id
		  FROM (SELECT DISTINCT ON (account_id,chat_id) account_id,chat_id,timestamp,id FROM messages
		        WHERE is_from_me AND status IN ('sent','delivered','read') ORDER BY account_id,chat_id,timestamp DESC,id DESC) m
		  WHERE c.id=m.chat_id AND c.account_id=m.account_id;
		  UPDATE chats c SET unread_count=(SELECT COUNT(*) FROM messages m WHERE m.account_id=c.account_id AND m.chat_id=c.id
		   AND NOT m.is_from_me AND NOT m.is_read AND NOT COALESCE(m.is_revoked,FALSE)),
		   waiting_since=(SELECT MIN(m.timestamp) FROM messages m WHERE m.account_id=c.account_id
		   AND m.chat_id=c.id AND NOT m.is_from_me AND NOT COALESCE(m.is_revoked,FALSE)
		   AND COALESCE(m.sender->>'origin','')<>'history'
		   AND (c.attention_through_at IS NULL OR (m.timestamp,m.id)>(c.attention_through_at,c.attention_through_id))), state_version=1;
		  INSERT INTO migration_flags(key) VALUES ('chat_attention_20260921');
		 END IF;
		END $$`,
		`CREATE OR REPLACE FUNCTION clarin_chat_message_insert() RETURNS trigger LANGUAGE plpgsql AS $$
		DECLARE boundary_at TIMESTAMPTZ; boundary_id UUID;
		BEGIN
		 SELECT attention_through_at,attention_through_id INTO boundary_at,boundary_id
		 FROM chats WHERE account_id=NEW.account_id AND id=NEW.chat_id FOR UPDATE;
		 IF NOT FOUND THEN RETURN NEW; END IF;
		 IF NEW.is_from_me AND NOT NEW.defer_attention AND NEW.attention_through_at IS NOT NULL
		    AND COALESCE(NEW.sender->>'origin','') IN ('manual','quick_reply','whatsapp_external') THEN
		   IF boundary_at IS NULL OR (NEW.attention_through_at,NEW.attention_through_id)>(boundary_at,boundary_id) THEN
		    boundary_at=NEW.attention_through_at; boundary_id=NEW.attention_through_id;
		    UPDATE messages SET is_read=TRUE,read_at=COALESCE(read_at,NOW()) WHERE account_id=NEW.account_id AND chat_id=NEW.chat_id AND NOT is_from_me AND NOT is_read AND (timestamp,id)<=(boundary_at,boundary_id);
		   END IF;
		 END IF;
		 UPDATE chats SET
		  unread_count=CASE WHEN NEW.is_from_me AND NOT NEW.defer_attention AND NEW.attention_through_at IS NOT NULL AND COALESCE(NEW.sender->>'origin','') IN ('manual','quick_reply','whatsapp_external')
		   THEN (SELECT COUNT(*) FROM messages WHERE account_id=NEW.account_id AND chat_id=NEW.chat_id AND NOT is_from_me AND NOT is_read AND NOT COALESCE(is_revoked,FALSE))
		   ELSE unread_count+CASE WHEN NOT NEW.is_from_me AND NOT NEW.is_read AND NOT COALESCE(NEW.is_revoked,FALSE) THEN 1 ELSE 0 END END,
		  attention_through_at=boundary_at,attention_through_id=boundary_id,
		  waiting_since=(SELECT MIN(m.timestamp) FROM messages m WHERE m.account_id=NEW.account_id AND m.chat_id=NEW.chat_id
		    AND NOT m.is_from_me AND NOT COALESCE(m.is_revoked,FALSE) AND COALESCE(m.sender->>'origin','')<>'history'
		    AND (boundary_at IS NULL OR (m.timestamp,m.id)>(boundary_at,boundary_id))),
		  last_message=CASE WHEN last_message_at IS NULL OR NEW.timestamp>=last_message_at THEN COALESCE(NEW.body,'') ELSE last_message END,
		  last_message_at=GREATEST(last_message_at,NEW.timestamp),
		  last_inbound_at=CASE WHEN NOT NEW.is_from_me THEN GREATEST(last_inbound_at,NEW.timestamp) ELSE last_inbound_at END,
		  last_outbound_at=CASE WHEN NEW.is_from_me THEN GREATEST(last_outbound_at,NEW.timestamp) ELSE last_outbound_at END,
		  state_version=state_version+1,updated_at=NOW()
		 WHERE account_id=NEW.account_id AND id=NEW.chat_id;
		 RETURN NEW;
		END $$`,
		`DROP TRIGGER IF EXISTS chat_message_insert ON messages;
		 CREATE TRIGGER chat_message_insert AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION clarin_chat_message_insert()`,
	}
}
