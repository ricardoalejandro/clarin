package database

func messageLinkPreviewMigrations() []string {
	return []string{
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview JSONB, ADD COLUMN IF NOT EXISTS link_preview_media_asset_id UUID`,
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS link_preview_version BIGINT NOT NULL DEFAULT 0 CHECK(link_preview_version>=0)`,
		`CREATE OR REPLACE FUNCTION clarin_bump_link_preview_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.link_preview IS DISTINCT FROM OLD.link_preview OR NEW.link_preview_media_asset_id IS DISTINCT FROM OLD.link_preview_media_asset_id THEN NEW.link_preview_version=OLD.link_preview_version+1;
 ELSE NEW.link_preview_version=OLD.link_preview_version;END IF;RETURN NEW;END $$`,
		`CREATE OR REPLACE TRIGGER trg_messages_link_preview_version BEFORE UPDATE OF link_preview,link_preview_media_asset_id ON messages FOR EACH ROW EXECUTE FUNCTION clarin_bump_link_preview_version()`,
		`CREATE INDEX IF NOT EXISTS idx_messages_link_preview_asset ON messages(account_id,link_preview_media_asset_id) WHERE link_preview_media_asset_id IS NOT NULL`,
		`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_messages_link_preview_asset_account') THEN ALTER TABLE messages ADD CONSTRAINT fk_messages_link_preview_asset_account FOREIGN KEY(account_id,link_preview_media_asset_id) REFERENCES media_assets(account_id,id); END IF; END $$`,
		`ALTER TABLE chat_group_message_state ADD COLUMN IF NOT EXISTS edited_link_preview JSONB, ADD COLUMN IF NOT EXISTS edited_link_preview_media_asset_id UUID`,
		`ALTER TABLE chat_group_message_state ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid()`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_group_message_state_id ON chat_group_message_state(id)`,
		`CREATE INDEX IF NOT EXISTS idx_group_state_link_preview_asset ON chat_group_message_state(account_id,edited_link_preview_media_asset_id) WHERE edited_link_preview_media_asset_id IS NOT NULL`,
		`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_group_state_link_preview_asset_account') THEN ALTER TABLE chat_group_message_state ADD CONSTRAINT fk_group_state_link_preview_asset_account FOREIGN KEY(account_id,edited_link_preview_media_asset_id) REFERENCES media_assets(account_id,id); END IF; END $$`,
		`CREATE OR REPLACE FUNCTION clarin_apply_group_message_state() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE state RECORD; BEGIN
 SELECT revoked,edited_body,edited_mentions,edited_link_preview,edited_link_preview_media_asset_id INTO state FROM chat_group_message_state WHERE account_id=NEW.account_id AND chat_id=NEW.chat_id AND message_id=NEW.message_id;
 IF FOUND THEN IF state.revoked THEN NEW.is_revoked=TRUE;NEW.body=NULL;NEW.link_preview=NULL;NEW.link_preview_media_asset_id=NULL;
 ELSIF state.edited_body IS NOT NULL THEN NEW.is_edited=TRUE;NEW.body=state.edited_body;NEW.group_mentions=COALESCE(state.edited_mentions,NEW.group_mentions);NEW.link_preview=state.edited_link_preview;NEW.link_preview_media_asset_id=state.edited_link_preview_media_asset_id;END IF;END IF;RETURN NEW;END $$`,
	}
}
