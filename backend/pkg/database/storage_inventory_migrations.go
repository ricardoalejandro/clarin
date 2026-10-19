package database

import (
	"fmt"
	"strings"
)

// The inventory is a projection, not an authorization grant or a deletion
// ledger. A reference may be read only when its generation still matches its
// source; the worker publishes references and indexed_generation atomically.
type storageInventorySourceSpec struct {
	table, accountMode, mediaFields, changeFields string
}

func storageInventorySourceSpecs() []storageInventorySourceSpec {
	metadata := map[string]string{
		"messages":                   "chat_id,media_filename",
		"chat_group_message_state":   "chat_id",
		"campaigns":                  "name",
		"campaign_attachments":       "campaign_id,file_name",
		"quick_replies":              "title,media_filename",
		"quick_reply_attachments":    "quick_reply_id,media_filename",
		"dynamics":                   "name",
		"dynamic_items":              "dynamic_id",
		"dynamic_links":              "dynamic_id",
		"dynamic_link_extra_media":   "link_id",
		"dynamic_whatsapp_queue":     "dynamic_id,link_id,item_id",
		"document_templates":         "name",
		"survey_answers":             "response_id,question_id",
		"survey_file_uploads":        "survey_id,response_id,question_id,original_filename",
		"survey_branding_asset_refs": "survey_id,template_id,slot",
		"surveys":                    "name",
		"survey_templates":           "name",
		"contacts":                   "name",
		"programs":                   "name",
		"whatsapp_statuses":          "device_id,status,expires_at",
		"task_attachments":           "task_id,attachment_scope,draft_owner_id,draft_expires_at,storage_removed_at,storage_removed_id",
		"task_attachment_previews":   "task_id,attachment_id,status",
		"whiteboard_assets":          "board_id,library_id,kind,committed_at,draft_expires_at,uploaded_by,guest_session_id",
		"whiteboard_revision_assets": "board_id,revision_id",
		"whiteboard_revisions":       "board_id,revision_kind,expires_at",
		"media_assets":               "filename,content_type,media_type,size_bytes",
		"storage_upload_ownership":   "actor_id,provenance_verified,version,last_uploaded_at,first_uploaded_at,filename",
	}
	result := make([]storageInventorySourceSpec, 0, len(storageReferenceGuardSpecs)+1)
	for _, guard := range storageReferenceGuardSpecs {
		var mediaFields []string
		for _, field := range strings.Split(guard.fields, ",") {
			if field != "status" && field != "state" && field != "revoked" && field != "media_deleted" && field != "storage_removed_at" && field != "storage_removal_id" {
				mediaFields = append(mediaFields, field)
			}
		}
		fields := guard.fields + ",id,account_id"
		if extra := metadata[guard.table]; extra != "" {
			fields += "," + extra
		}
		result = append(result, storageInventorySourceSpec{guard.table, guard.accountMode, strings.Join(mediaFields, ","), fields})
	}
	result = append(result, storageInventorySourceSpec{
		"storage_objects", "direct", "object_key", "id,account_id,object_key,status,filename,content_type,media_type,size_bytes",
	})
	return result
}

// StorageInventoryMigrations must run after the reference guards and all module
// migrations. Backfill and S3 reconciliation are bounded, resumable worker jobs;
// startup does not scan media payloads or contact the object store.
func StorageInventoryMigrations() []string {
	migrations := []string{
		`CREATE SEQUENCE IF NOT EXISTS storage_inventory_generation_seq AS BIGINT`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_objects (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 bucket_kind TEXT NOT NULL CHECK(bucket_kind IN ('ordinary','private')),
		 object_key TEXT NOT NULL,
		 size_bytes BIGINT NOT NULL CHECK(size_bytes>=0),
		 etag TEXT NOT NULL DEFAULT '',
		 last_modified TIMESTAMPTZ NOT NULL,
		 observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 scan_generation BIGINT NOT NULL DEFAULT 0 CHECK(scan_generation>=0),
		 presence TEXT NOT NULL DEFAULT 'present' CHECK(presence IN ('present','missing')),
		 media_type TEXT NOT NULL DEFAULT 'other',
		 content_type TEXT NOT NULL DEFAULT '',
		 filename TEXT NOT NULL DEFAULT '',
		 PRIMARY KEY(account_id,bucket_kind,object_key),
		 CHECK(left(object_key,length(account_id::text)+1)=account_id::text||'/' AND length(object_key)>length(account_id::text)+1)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_objects_size ON storage_inventory_objects(account_id,presence,size_bytes DESC,object_key,bucket_kind)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_objects_date ON storage_inventory_objects(account_id,presence,last_modified DESC,object_key,bucket_kind)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_objects_name ON storage_inventory_objects(account_id,presence,lower(filename),object_key,bucket_kind)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_objects_type ON storage_inventory_objects(account_id,media_type,presence,object_key,bucket_kind)`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_scans (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 bucket_kind TEXT NOT NULL CHECK(bucket_kind IN ('ordinary','private')),
		 scan_generation BIGINT NOT NULL DEFAULT 0 CHECK(scan_generation>=0),
		 after_key TEXT NOT NULL DEFAULT '',
		 started_at TIMESTAMPTZ,
		 completed_at TIMESTAMPTZ,
		 last_error TEXT NOT NULL DEFAULT '',
		 next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 lease_until TIMESTAMPTZ,
		 PRIMARY KEY(account_id,bucket_kind)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_scans_due ON storage_inventory_scans(next_run_at,account_id,bucket_kind)`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_sources (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 source_kind TEXT NOT NULL,
		 source_id TEXT NOT NULL,
		 generation BIGINT NOT NULL DEFAULT nextval('storage_inventory_generation_seq') CHECK(generation>0),
		 indexed_generation BIGINT NOT NULL DEFAULT 0 CHECK(indexed_generation>=0),
   changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
		 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
		 last_error TEXT NOT NULL DEFAULT '',
		 PRIMARY KEY(account_id,source_kind,source_id)
		)`,
		`ALTER TABLE storage_inventory_sources ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_sources_due ON storage_inventory_sources(next_attempt_at,account_id,source_kind,source_id) WHERE generation<>indexed_generation`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_sources_account_due ON storage_inventory_sources(account_id,next_attempt_at,source_kind,source_id) WHERE generation<>indexed_generation`,
		// Legacy child deletes can run after their parent disappeared. Their
		// already-known source identity supplies invalidation, never ownership.
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_sources_identity ON storage_inventory_sources(source_kind,source_id,account_id)`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_references (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 source_kind TEXT NOT NULL,
		 source_id TEXT NOT NULL,
		 object_key TEXT NOT NULL,
		 source_generation BIGINT NOT NULL CHECK(source_generation>0),
		 origin TEXT NOT NULL,
		 ref_id TEXT NOT NULL,
		 label TEXT NOT NULL DEFAULT '',
		 href TEXT NOT NULL DEFAULT '',
		 filename TEXT NOT NULL DEFAULT '',
		 readable BOOLEAN NOT NULL DEFAULT FALSE,
		 PRIMARY KEY(account_id,source_kind,source_id,object_key,origin,ref_id),
		 FOREIGN KEY(account_id,source_kind,source_id) REFERENCES storage_inventory_sources(account_id,source_kind,source_id) ON DELETE CASCADE,
		 CHECK(left(object_key,length(account_id::text)+1)=account_id::text||'/' AND length(object_key)>length(account_id::text)+1)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_references_key ON storage_inventory_references(account_id,object_key,source_kind,source_id)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_references_origin ON storage_inventory_references(account_id,origin,object_key)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_removed_references_private_active ON storage_removed_references(account_id)
 WHERE state IN ('removed','purging') AND adapter IN ('private_work','private_whiteboards')`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_backfill (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 source_kind TEXT NOT NULL,
		 after_id UUID,
		 complete BOOLEAN NOT NULL DEFAULT FALSE,
		 PRIMARY KEY(account_id,source_kind)
		)`,
		`CREATE TABLE IF NOT EXISTS storage_inventory_totals (
		 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
		 object_count BIGINT NOT NULL DEFAULT 0 CHECK(object_count>=0),
		 size_bytes BIGINT NOT NULL DEFAULT 0 CHECK(size_bytes>=0)
		)`,
		`INSERT INTO storage_inventory_totals(account_id,object_count,size_bytes)
		 SELECT account_id,count(*),COALESCE(sum(size_bytes),0) FROM storage_inventory_objects WHERE presence='present' GROUP BY account_id
		 ON CONFLICT(account_id) DO NOTHING`,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_totals_update() RETURNS trigger
		 LANGUAGE plpgsql AS $$
		 DECLARE old_account UUID; new_account UUID; old_count BIGINT:=0; new_count BIGINT:=0;
		 old_size BIGINT:=0; new_size BIGINT:=0; delta RECORD;
		 BEGIN
		 IF TG_OP<>'INSERT' THEN
		   old_account:=OLD.account_id;
		   IF OLD.presence='present' THEN old_count:=1; old_size:=OLD.size_bytes; END IF;
		 END IF;
		 IF TG_OP<>'DELETE' THEN
		   new_account:=NEW.account_id;
		   IF NEW.presence='present' THEN new_count:=1; new_size:=NEW.size_bytes; END IF;
		 END IF;
		 FOR delta IN SELECT a AS account_id,sum(c)::bigint AS object_count,sum(s)::bigint AS size_bytes
		   FROM (VALUES(old_account,-old_count,-old_size),(new_account,new_count,new_size)) changes(a,c,s)
		   WHERE a IS NOT NULL GROUP BY a HAVING sum(c)<>0 OR sum(s)<>0 ORDER BY a LOOP
		   -- Account deletion may cascade here after the owning account vanished.
		   IF NOT EXISTS(SELECT 1 FROM accounts WHERE id=delta.account_id) THEN CONTINUE; END IF;
		   INSERT INTO storage_inventory_totals(account_id) VALUES(delta.account_id) ON CONFLICT DO NOTHING;
		   UPDATE storage_inventory_totals SET object_count=object_count+delta.object_count,size_bytes=size_bytes+delta.size_bytes
		     WHERE account_id=delta.account_id;
		 END LOOP;
		 RETURN NULL;
		 END $$`,
		`DROP TRIGGER IF EXISTS clarin_storage_inventory_totals_change ON storage_inventory_objects`,
		`CREATE TRIGGER clarin_storage_inventory_totals_change AFTER INSERT OR UPDATE OR DELETE ON storage_inventory_objects
		 FOR EACH ROW EXECUTE FUNCTION clarin_storage_inventory_totals_update()`,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_fields(item JSONB,fields TEXT) RETURNS JSONB
		 LANGUAGE SQL IMMUTABLE AS $$
		 SELECT COALESCE(jsonb_object_agg(field,item->field),'{}'::jsonb)
		 FROM unnest(string_to_array(fields,',')) field WHERE item IS NOT NULL AND item ? field
		 $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_has_media(item JSONB,fields TEXT) RETURNS BOOLEAN
		 LANGUAGE SQL IMMUTABLE AS $$
		 SELECT EXISTS(SELECT 1 FROM unnest(string_to_array(fields,',')) field
		   WHERE CASE WHEN field IN ('link_preview','edited_link_preview') THEN NULLIF(item->field->>'thumbnail_url','') IS NOT NULL
		   ELSE item->field IS NOT NULL AND item->field NOT IN ('null'::jsonb,'""'::jsonb,'{}'::jsonb,'[]'::jsonb) END)
		 $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_enqueue(owner UUID,kind TEXT,identity TEXT) RETURNS void
		 LANGUAGE plpgsql AS $$ BEGIN
		 IF owner IS NULL OR identity IS NULL OR identity='' THEN RETURN; END IF;
		 INSERT INTO storage_inventory_sources(account_id,source_kind,source_id)
		 SELECT owner,kind,identity WHERE EXISTS(SELECT 1 FROM accounts WHERE id=owner)
		 ON CONFLICT(account_id,source_kind,source_id) DO UPDATE
		 SET generation=nextval('storage_inventory_generation_seq'),changed_at=clock_timestamp(),next_attempt_at=NOW(),attempts=0,last_error='';
		 END $$`,
	}
	migrations = append(migrations, storageInventoryDependencyMigrations()...)
	migrations = append(migrations,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_source_change() RETURNS trigger
		 LANGUAGE plpgsql AS $$
		 DECLARE old_item JSONB; new_item JSONB; old_account UUID; new_account UUID; candidate RECORD;
		 BEGIN
		 IF TG_OP<>'INSERT' THEN old_item:=to_jsonb(OLD); END IF;
		 IF TG_OP<>'DELETE' THEN new_item:=to_jsonb(NEW); END IF;
		 IF TG_OP='UPDATE' AND clarin_storage_inventory_fields(old_item,TG_ARGV[2])=clarin_storage_inventory_fields(new_item,TG_ARGV[2]) THEN RETURN NULL; END IF;
		 IF NOT clarin_storage_inventory_has_media(old_item,TG_ARGV[1]) AND NOT clarin_storage_inventory_has_media(new_item,TG_ARGV[1])
		   AND TG_TABLE_NAME NOT IN ('campaigns','quick_replies','dynamics','dynamic_links','surveys','survey_templates','chats','whiteboard_revisions','tasks','whiteboards') THEN RETURN NULL; END IF;
		 -- A direct tenant identifier is retained during cascading parent deletes.
		 old_account:=COALESCE(NULLIF(old_item->>'account_id','')::uuid,clarin_storage_reference_account(TG_ARGV[0],old_item));
		 new_account:=COALESCE(NULLIF(new_item->>'account_id','')::uuid,clarin_storage_reference_account(TG_ARGV[0],new_item));
		 IF TG_OP<>'INSERT' THEN
		   FOR candidate IN SELECT DISTINCT a,identity FROM (VALUES(old_account,old_item->>'id'),(new_account,new_item->>'id')) owners(a,identity)
		     WHERE a IS NOT NULL AND identity IS NOT NULL ORDER BY a,identity LOOP
		     PERFORM clarin_storage_inventory_invalidate_dependents(TG_TABLE_NAME,candidate.a,candidate.identity::uuid);
		   END LOOP;
		 END IF;
		 IF NOT clarin_storage_inventory_has_media(old_item,TG_ARGV[1]) AND NOT clarin_storage_inventory_has_media(new_item,TG_ARGV[1]) THEN RETURN NULL; END IF;
		 FOR candidate IN
		   SELECT DISTINCT a,identity FROM (
		     SELECT old_account AS a,old_item->>'id' AS identity UNION ALL
		     SELECT new_account,new_item->>'id' UNION ALL
		     SELECT account_id,source_id FROM storage_inventory_sources
		       WHERE source_kind=TG_TABLE_NAME AND ((old_account IS NULL AND source_id=old_item->>'id') OR (new_account IS NULL AND source_id=new_item->>'id'))
		   ) owners WHERE a IS NOT NULL AND identity IS NOT NULL ORDER BY a,identity LOOP
		   PERFORM clarin_storage_inventory_enqueue(candidate.a,TG_TABLE_NAME,candidate.identity);
		 END LOOP;
		 RETURN NULL;
		 END $$`,
	)
	for _, spec := range storageInventorySourceSpecs() {
		migrations = append(migrations,
			fmt.Sprintf(`DROP TRIGGER IF EXISTS clarin_storage_inventory_change ON %s`, spec.table),
			fmt.Sprintf(`CREATE TRIGGER clarin_storage_inventory_change AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clarin_storage_inventory_source_change('%s','%s','%s')`, spec.table, spec.accountMode, spec.mediaFields, spec.changeFields),
		)
	}
	// Chat titles are inherited by message references. They are not an inventory
	// source themselves, and plain-text message writes never enqueue media work.
	migrations = append(migrations,
		`DROP TRIGGER IF EXISTS clarin_storage_inventory_change ON chats`,
		`CREATE TRIGGER clarin_storage_inventory_change AFTER UPDATE OF name,account_id OR DELETE ON chats
		 FOR EACH ROW EXECUTE FUNCTION clarin_storage_inventory_source_change('direct','','id,account_id,name')`,
		`DROP TRIGGER IF EXISTS clarin_storage_inventory_change ON tasks`,
		`CREATE TRIGGER clarin_storage_inventory_change AFTER UPDATE OF title,account_id OR DELETE ON tasks
   FOR EACH ROW EXECUTE FUNCTION clarin_storage_inventory_source_change('direct','','id,account_id,title')`,
		`DROP TRIGGER IF EXISTS clarin_storage_inventory_change ON whiteboards`,
		`CREATE TRIGGER clarin_storage_inventory_change AFTER UPDATE OF name,account_id OR DELETE ON whiteboards
   FOR EACH ROW EXECUTE FUNCTION clarin_storage_inventory_source_change('direct','','id,account_id,name')`,
	)
	migrations = append(migrations, storageInventoryParserMigrations()...)
	return migrations
}

func storageInventoryDependencyMigrations() []string {
	return []string{
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_survey_upload_asset ON survey_file_uploads(account_id,media_asset_id) WHERE media_asset_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_task_attachment_asset ON task_attachments(account_id,media_asset_id)`,
		`CREATE INDEX IF NOT EXISTS idx_storage_inventory_task_preview_asset ON task_attachment_previews(account_id,derivative_asset_id) WHERE derivative_asset_id IS NOT NULL`,
		`CREATE OR REPLACE FUNCTION clarin_storage_inventory_invalidate_dependents(kind TEXT,owner UUID,identity UUID) RETURNS void
		 LANGUAGE plpgsql AS $$ BEGIN
		 IF clarin_storage_inventory_invalidate_dependents.kind='media_assets' THEN
		   -- Invalidate synchronously: a changed asset may never leave an old key
		   -- authorized while its asynchronous projection is waiting for repair.
		   UPDATE storage_inventory_sources src SET generation=nextval('storage_inventory_generation_seq'),changed_at=clock_timestamp(),next_attempt_at=NOW(),attempts=0,last_error=''
		   FROM (
		     SELECT 'messages'::text AS source_kind,id::text AS source_id FROM messages WHERE account_id=owner AND (media_asset_id=identity OR link_preview_media_asset_id=identity)
		     UNION SELECT 'chat_group_message_state',id::text FROM chat_group_message_state WHERE account_id=owner AND edited_link_preview_media_asset_id=identity
		     UNION ALL SELECT 'quick_reply_attachments',id::text FROM quick_reply_attachments WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'survey_file_uploads',id::text FROM survey_file_uploads WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'survey_branding_asset_refs',id::text FROM survey_branding_asset_refs WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'contacts',id::text FROM contacts WHERE account_id=owner AND avatar_media_asset_id=identity
		     UNION ALL SELECT 'programs',id::text FROM programs WHERE account_id=owner AND avatar_media_asset_id=identity
		     UNION ALL SELECT 'whatsapp_statuses',id::text FROM whatsapp_statuses WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'task_attachments',id::text FROM task_attachments WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'task_attachment_previews',id::text FROM task_attachment_previews WHERE account_id=owner AND derivative_asset_id=identity
		     UNION ALL SELECT 'whiteboard_assets',id::text FROM whiteboard_assets WHERE account_id=owner AND media_asset_id=identity
		     UNION ALL SELECT 'whiteboard_revision_assets',id::text FROM whiteboard_revision_assets WHERE account_id=owner AND media_asset_id=identity
		   ) child WHERE src.account_id=owner AND src.source_kind=child.source_kind AND src.source_id=child.source_id;
		 ELSIF clarin_storage_inventory_invalidate_dependents.kind IN ('campaigns','quick_replies','dynamics','dynamic_links','surveys','survey_templates','chats','whiteboard_revisions','tasks','whiteboards') THEN
		   UPDATE storage_inventory_sources src SET generation=nextval('storage_inventory_generation_seq'),changed_at=clock_timestamp(),next_attempt_at=NOW(),attempts=0,last_error=''
		   FROM (
		     SELECT 'campaign_attachments'::text AS source_kind,a.id::text AS source_id FROM campaign_attachments a JOIN campaigns p ON p.id=a.campaign_id
		       WHERE clarin_storage_inventory_invalidate_dependents.kind='campaigns' AND p.account_id=owner AND p.id=identity
		     UNION ALL SELECT 'quick_reply_attachments',id::text FROM quick_reply_attachments WHERE clarin_storage_inventory_invalidate_dependents.kind='quick_replies' AND account_id=owner AND quick_reply_id=identity
		     UNION ALL SELECT 'dynamic_items',c.id::text FROM dynamic_items c JOIN dynamics p ON p.id=c.dynamic_id WHERE clarin_storage_inventory_invalidate_dependents.kind='dynamics' AND p.account_id=owner AND p.id=identity
		     UNION ALL SELECT 'dynamic_links',c.id::text FROM dynamic_links c JOIN dynamics p ON p.id=c.dynamic_id WHERE clarin_storage_inventory_invalidate_dependents.kind='dynamics' AND p.account_id=owner AND p.id=identity
		     UNION ALL SELECT 'dynamic_link_extra_media',c.id::text FROM dynamic_link_extra_media c JOIN dynamic_links l ON l.id=c.link_id JOIN dynamics p ON p.id=l.dynamic_id
		       WHERE p.account_id=owner AND ((clarin_storage_inventory_invalidate_dependents.kind='dynamics' AND p.id=identity) OR (clarin_storage_inventory_invalidate_dependents.kind='dynamic_links' AND l.id=identity))
		     UNION ALL SELECT 'dynamic_whatsapp_queue',id::text FROM dynamic_whatsapp_queue WHERE clarin_storage_inventory_invalidate_dependents.kind='dynamics' AND account_id=owner AND dynamic_id=identity
		     UNION ALL SELECT 'survey_file_uploads',id::text FROM survey_file_uploads WHERE clarin_storage_inventory_invalidate_dependents.kind='surveys' AND account_id=owner AND survey_id=identity
		     UNION ALL SELECT 'survey_answers',a.id::text FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id JOIN surveys s ON s.id=r.survey_id AND s.account_id=r.account_id
		       WHERE clarin_storage_inventory_invalidate_dependents.kind='surveys' AND s.account_id=owner AND s.id=identity
		     UNION ALL SELECT 'survey_branding_asset_refs',id::text FROM survey_branding_asset_refs
		       WHERE account_id=owner AND ((clarin_storage_inventory_invalidate_dependents.kind='surveys' AND survey_id=identity) OR (clarin_storage_inventory_invalidate_dependents.kind='survey_templates' AND template_id=identity))
		     UNION ALL SELECT 'messages',id::text FROM messages WHERE clarin_storage_inventory_invalidate_dependents.kind='chats' AND account_id=owner AND chat_id=identity AND (NULLIF(media_url,'') IS NOT NULL OR media_asset_id IS NOT NULL OR link_preview_media_asset_id IS NOT NULL OR NULLIF(link_preview->>'thumbnail_url','') IS NOT NULL)
		     UNION ALL SELECT 'chat_group_message_state',id::text FROM chat_group_message_state WHERE clarin_storage_inventory_invalidate_dependents.kind='chats' AND account_id=owner AND chat_id=identity AND NOT revoked AND (edited_link_preview_media_asset_id IS NOT NULL OR NULLIF(edited_link_preview->>'thumbnail_url','') IS NOT NULL)
		     UNION ALL SELECT 'whiteboard_revision_assets',id::text FROM whiteboard_revision_assets WHERE clarin_storage_inventory_invalidate_dependents.kind='whiteboard_revisions' AND account_id=owner AND revision_id=identity
       UNION ALL SELECT 'task_attachments',id::text FROM task_attachments WHERE clarin_storage_inventory_invalidate_dependents.kind='tasks' AND account_id=owner AND task_id=identity
       UNION ALL SELECT 'whiteboard_assets',id::text FROM whiteboard_assets WHERE clarin_storage_inventory_invalidate_dependents.kind='whiteboards' AND account_id=owner AND board_id=identity
       UNION ALL SELECT 'whiteboard_revision_assets',id::text FROM whiteboard_revision_assets WHERE clarin_storage_inventory_invalidate_dependents.kind='whiteboards' AND account_id=owner AND board_id=identity
		   ) child WHERE src.account_id=owner AND src.source_kind=child.source_kind AND src.source_id=child.source_id;
		 END IF;
		 END $$`,
	}
}
