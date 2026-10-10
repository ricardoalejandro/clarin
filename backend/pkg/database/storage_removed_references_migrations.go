package database

import (
	"fmt"
	"strings"
)

// Recovery is owned by a removed use, independently from object liveness.
// Actor/source deletion must retain the recovery/audit row until account purge.
func storageRemovedReferencesMigrations() []string {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS storage_removed_references (
		 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 actor_id UUID NOT NULL, operation_id UUID NOT NULL,
		 object_key TEXT NOT NULL, use_id TEXT NOT NULL, adapter TEXT NOT NULL,
		 origin_type TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
		 filename TEXT NOT NULL, media_type TEXT NOT NULL, size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
		 snapshot JSONB NOT NULL,
		 state TEXT NOT NULL DEFAULT 'removed' CHECK(state IN ('removed','restored','purging','purged')),
		 removed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), retain_until TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '7 days',
		 restored_at TIMESTAMPTZ, purged_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 CHECK(object_key LIKE account_id::text || '/%'),
		 UNIQUE(account_id,operation_id,use_id)
		)`,
		`ALTER TABLE storage_removed_references ADD COLUMN IF NOT EXISTS removal_order BIGSERIAL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_storage_removed_reference_active ON storage_removed_references(account_id,use_id) WHERE state IN ('removed','purging')`,
		`CREATE INDEX IF NOT EXISTS idx_storage_removed_references_object ON storage_removed_references(account_id,object_key,state,retain_until)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_removed_references_actor ON storage_removed_references(account_id,actor_id,state,removed_at,id)`,
		`ALTER TABLE storage_cleanup_previews ADD COLUMN IF NOT EXISTS use_selection JSONB`,
	}
	branches := []string{}
	for _, spec := range storageReferenceGuardSpecs {
		if spec.table == "media_assets" {
			continue
		}
		predicate := "clarin_storage_reference_account('" + spec.accountMode + "',to_jsonb(r))=wanted_account"
		if spec.accountMode == "direct" {
			predicate = "r.account_id=wanted_account"
		}
		payload := fmt.Sprintf("clarin_storage_reference_payload('%s',to_jsonb(r),'%s')", spec.table, spec.fields)
		branches = append(branches, fmt.Sprintf("IF EXISTS(SELECT 1 FROM %s r WHERE %s AND (wanted_key=ANY(clarin_storage_reference_keys(%s)) OR (wanted_asset IS NOT NULL AND strpos((%s)::text,wanted_asset::text)>0))) THEN RETURN TRUE; END IF;", spec.table, predicate, payload, payload))
	}
	migrations = append(migrations, `CREATE OR REPLACE FUNCTION clarin_storage_has_live_references(wanted_account UUID,wanted_key TEXT,wanted_asset UUID) RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$ BEGIN `+strings.Join(branches, "\n")+` RETURN FALSE; END $$`)
	return migrations

}

// Install after every module and reference guard: the legacy Contact migration
// recreates this trigger function on startup, before recovery tables exist.
func storageContactAvatarRecoveryGCMigrations() []string {
	return []string{`CREATE OR REPLACE FUNCTION schedule_deleted_contact_avatar_gc() RETURNS TRIGGER AS $$
	DECLARE avatar_key TEXT;
	BEGIN
	 IF OLD.avatar_media_asset_id IS NULL THEN RETURN OLD; END IF;
	 PERFORM pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:' || OLD.account_id::text,0));
	 SELECT object_key INTO avatar_key FROM media_assets
	 WHERE account_id=OLD.account_id AND id=OLD.avatar_media_asset_id
	   AND content_hash LIKE 'contact_avatar:%' AND status IN ('active','avatar_gc_pending')
	 FOR UPDATE;
	 IF NOT FOUND THEN RETURN OLD; END IF;
	 -- The last visible Contact is not necessarily the last recoverable use.
	 -- Keep canonical state attachable while a recovery, upload claim or another
	 -- domain still owns these bytes; ordinary GC must never strand recovery.
	 IF EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=OLD.account_id AND object_key=avatar_key AND state IN ('removed','purging'))
	 OR EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=OLD.account_id AND object_key=avatar_key AND state IN ('trash','purging'))
	 OR EXISTS(SELECT 1 FROM storage_upload_ownership WHERE account_id=OLD.account_id AND object_key=avatar_key AND state='active')
	 OR EXISTS(SELECT 1 FROM storage_admin_delete_intents WHERE account_id=OLD.account_id AND object_key=avatar_key AND state='purging')
	 OR clarin_storage_has_live_references(OLD.account_id,avatar_key,OLD.avatar_media_asset_id)
	 THEN RETURN OLD; END IF;
	 UPDATE media_assets SET status='avatar_gc_pending',updated_at=NOW()
	 WHERE account_id=OLD.account_id AND id=OLD.avatar_media_asset_id AND object_key=avatar_key;
	 UPDATE storage_objects SET status='avatar_gc_pending',next_delete_at=NOW(),delete_error='',updated_at=NOW()
	 WHERE account_id=OLD.account_id AND object_key=avatar_key;
	 RETURN OLD;
	END;
	$$ LANGUAGE plpgsql`}
}
