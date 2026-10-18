package database

func programExperienceMigrations() []string {
	return []string{
		`ALTER TABLE programs ADD COLUMN IF NOT EXISTS avatar_media_asset_id UUID`,
		`ALTER TABLE programs ADD COLUMN IF NOT EXISTS avatar_revision BIGINT NOT NULL DEFAULT 0 CHECK(avatar_revision>=0)`,
		`ALTER TABLE programs ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ`,
		`ALTER TABLE programs ADD COLUMN IF NOT EXISTS archived_from_status VARCHAR(20) CHECK(archived_from_status IN ('active','completed'))`,
		`CREATE INDEX IF NOT EXISTS idx_programs_account_avatar ON programs(account_id,avatar_media_asset_id) WHERE avatar_media_asset_id IS NOT NULL`,
		`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='fk_program_avatar_account' AND conrelid='programs'::regclass) THEN
		 ALTER TABLE programs ADD CONSTRAINT fk_program_avatar_account FOREIGN KEY(account_id,avatar_media_asset_id) REFERENCES media_assets(account_id,id);
		 END IF; END $$`,
		// Schedule removal in the same transaction as replacement/deletion. The
		// existing avatar worker rechecks all live/recoverable uses before S3 GC.
		`CREATE OR REPLACE FUNCTION schedule_removed_program_avatar_gc() RETURNS TRIGGER LANGUAGE plpgsql AS $$
		 DECLARE old_key TEXT;
		 BEGIN
		 IF OLD.avatar_media_asset_id IS NULL THEN RETURN OLD; END IF;
		 IF TG_OP='UPDATE' AND OLD.avatar_media_asset_id IS NOT DISTINCT FROM NEW.avatar_media_asset_id THEN RETURN NEW; END IF;
		 PERFORM pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:' || OLD.account_id::text,0));
		 SELECT object_key INTO old_key FROM media_assets WHERE account_id=OLD.account_id AND id=OLD.avatar_media_asset_id
		 AND content_hash LIKE 'program_avatar:%' AND status IN ('active','avatar_gc_pending') FOR UPDATE;
		 IF FOUND AND NOT clarin_storage_has_live_references(OLD.account_id,old_key,OLD.avatar_media_asset_id)
		 AND NOT EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=OLD.account_id AND object_key=old_key AND state IN ('removed','purging'))
		 AND NOT EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=OLD.account_id AND object_key=old_key AND state IN ('trash','purging')) THEN
		 UPDATE media_assets SET status='avatar_gc_pending',updated_at=NOW() WHERE account_id=OLD.account_id AND id=OLD.avatar_media_asset_id;
		 UPDATE storage_objects SET status='avatar_gc_pending',next_delete_at=NOW(),delete_error='',updated_at=NOW() WHERE account_id=OLD.account_id AND object_key=old_key;
		 END IF;
		 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
		 END $$`,
		`DROP TRIGGER IF EXISTS program_avatar_removed_gc ON programs`,
		`CREATE TRIGGER program_avatar_removed_gc AFTER DELETE OR UPDATE OF avatar_media_asset_id ON programs FOR EACH ROW EXECUTE FUNCTION schedule_removed_program_avatar_gc()`,
	}
}
