package database

import "fmt"

// Reference writers share the account's cleanup barrier. Only fields capable
// of adding an object reference participate: editing an unrelated caption or
// timestamp must not wait for cleanup or reinterpret historic content.
type storageReferenceGuardSpec struct {
	table, accountMode, fields string
}

var storageReferenceGuardSpecs = []storageReferenceGuardSpec{
	{"messages", "direct", "media_url,media_asset_id,media_deleted"},
	{"campaigns", "direct", "media_url,settings"},
	{"campaign_attachments", "campaign", "media_url"},
	{"quick_replies", "direct", "media_url,items"},
	{"quick_reply_attachments", "quick_reply", "media_url,media_asset_id"},
	{"saved_stickers", "direct", "media_url"},
	{"dynamics", "direct", "config"},
	{"dynamic_items", "dynamic", "image_url"},
	{"dynamic_links", "dynamic", "extra_message_media_url"},
	{"dynamic_link_extra_media", "dynamic_link", "url"},
	{"dynamic_whatsapp_queue", "direct", "image_url,extra_media_url"},
	{"document_templates", "direct", "thumbnail_url,canvas_json"},
	{"survey_answers", "survey_response", "file_url,survey_upload_id"},
	{"survey_file_uploads", "direct", "object_key,media_asset_id,status"},
	{"survey_branding_asset_refs", "direct", "media_asset_id"},
	{"surveys", "direct", "branding"},
	{"survey_templates", "direct", "branding"},
	{"contacts", "direct", "avatar_url,avatar_media_asset_id"},
	{"whatsapp_statuses", "direct", "media_url,media_asset_id"},
	{"task_attachments", "direct", "media_asset_id"},
	{"task_attachment_previews", "direct", "derivative_asset_id"},
	{"whiteboard_assets", "direct", "media_asset_id"},
	{"whiteboard_revision_assets", "direct", "media_asset_id"},
	{"whiteboard_revisions", "direct", "snapshot_object_key"},
	{"media_assets", "direct", "object_key,status"},
}

func storageSelfServiceReferenceGuardMigrations() []string {
	migrations := []string{
		`CREATE TABLE IF NOT EXISTS storage_reference_epochs (
		 account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
		 version BIGINT NOT NULL DEFAULT 0
		)`,
		`INSERT INTO storage_reference_epochs(account_id) SELECT id FROM accounts ON CONFLICT DO NOTHING`,
		`CREATE OR REPLACE FUNCTION clarin_storage_reference_new_account() RETURNS trigger
		 LANGUAGE plpgsql AS $$ BEGIN
		 INSERT INTO storage_reference_epochs(account_id) VALUES(NEW.id) ON CONFLICT DO NOTHING;
		 RETURN NEW;
		 END $$`,
		`DROP TRIGGER IF EXISTS clarin_storage_reference_account_epoch ON accounts`,
		`CREATE TRIGGER clarin_storage_reference_account_epoch AFTER INSERT ON accounts
		 FOR EACH ROW EXECUTE FUNCTION clarin_storage_reference_new_account()`,
		// Decode one URL path-escape layer, matching the application's canonical
		// object parser. Plus signs are literal path characters, never spaces.
		`CREATE OR REPLACE FUNCTION clarin_storage_path_unescape(value TEXT) RETURNS TEXT
		 LANGUAGE plpgsql IMMUTABLE STRICT AS $$
		 DECLARE result BYTEA := ''::bytea; i INTEGER := 1; ch TEXT;
		 BEGIN
		 WHILE i <= length(value) LOOP
		   ch := substr(value,i,1);
		   IF ch='%' AND substr(value,i+1,2) ~ '^[0-9a-fA-F]{2}$' THEN
		     result := result || decode(substr(value,i+1,2),'hex'); i := i+3;
		   ELSE
		     result := result || convert_to(ch,'UTF8'); i := i+1;
		   END IF;
		 END LOOP;
		 RETURN convert_from(result,'UTF8');
		 EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character THEN RETURN value;
		 END $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_reference_keys(payload JSONB) RETURNS TEXT[]
		 LANGUAGE plpgsql IMMUTABLE AS $$
		 DECLARE value TEXT; decoded_value TEXT; hit TEXT[]; object_key TEXT; result TEXT[] := ARRAY[]::TEXT[];
		 BEGIN
		 FOR value IN SELECT DISTINCT leaf #>> '{}' FROM jsonb_path_query(COALESCE(payload,'{}'::jsonb), '$.** ? (@.type() == "string")') leaf LOOP
		   -- This is a deletion safety barrier, not an authorization parser.
		   -- Conservatively recognize account paths in any bucket URL, including
		   -- historical custom bucket names and fully escaped path separators.
		   decoded_value:=clarin_storage_path_unescape(value);
		   IF value ~ '^(https?://|/)' THEN
		     decoded_value:=clarin_storage_path_unescape(split_part(split_part(value,'?',1),'#',1));
		     hit:=regexp_match(decoded_value,'(^|/)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.+)$');
		     IF hit IS NOT NULL THEN
		       object_key:=hit[2];
		       IF object_key !~ '(^|/)\.{1,2}(/|$)' AND strpos(object_key,'//')=0 AND strpos(object_key,chr(92))=0
		         AND strpos(object_key,chr(10))=0 AND strpos(object_key,chr(13))=0 AND right(object_key,1)<>'/' THEN
		         result:=array_append(result,object_key);
		       END IF;
		     END IF;
		     CONTINUE;
		   END IF;
		   -- A normalized raw key may contain spaces; URL delimiters apply only
		   -- to keys extracted from a proxy/S3 URL embedded in another string.
		   IF decoded_value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/' THEN
		     object_key:=rtrim(decoded_value,chr(39)||']}'||chr(34));
		     IF object_key !~ '(^|/)\.{1,2}(/|$)' AND strpos(object_key,'//')=0
		       AND strpos(object_key,chr(92))=0 AND right(object_key,1)<>'/' THEN
		       result:=array_append(result,object_key);
		     END IF;
		   END IF;
		   FOR hit IN SELECT regexp_matches(value, '(/api/media/file/|/clarin-media/)([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/[^"\\?[:space:]<>(){},]+)', 'g') LOOP
		     object_key := rtrim(clarin_storage_path_unescape(hit[2]), chr(39)||']}'||chr(34));
		     IF object_key !~ '(^|/)\.{1,2}(/|$)' AND strpos(object_key,'//')=0
		       AND strpos(object_key,chr(92))=0 AND right(object_key,1)<>'/' THEN
		       result := array_append(result,object_key);
		     END IF;
		   END LOOP;
		 END LOOP;
		 RETURN ARRAY(SELECT DISTINCT k FROM unnest(result) k ORDER BY k);
		 END $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_reference_account(mode TEXT, item JSONB) RETURNS UUID
		 LANGUAGE plpgsql STABLE AS $$
		 DECLARE result UUID;
		 BEGIN
		 CASE mode
		 WHEN 'direct' THEN result := NULLIF(item->>'account_id','')::uuid;
		 WHEN 'campaign' THEN SELECT account_id INTO result FROM campaigns WHERE id=NULLIF(item->>'campaign_id','')::uuid;
		 WHEN 'quick_reply' THEN SELECT account_id INTO result FROM quick_replies WHERE id=NULLIF(item->>'quick_reply_id','')::uuid;
		 WHEN 'dynamic' THEN SELECT account_id INTO result FROM dynamics WHERE id=NULLIF(item->>'dynamic_id','')::uuid;
		 WHEN 'dynamic_link' THEN SELECT d.account_id INTO result FROM dynamic_links l JOIN dynamics d ON d.id=l.dynamic_id WHERE l.id=NULLIF(item->>'link_id','')::uuid;
		 WHEN 'survey_response' THEN SELECT s.account_id INTO result FROM survey_responses r JOIN surveys s ON s.id=r.survey_id WHERE r.id=NULLIF(item->>'response_id','')::uuid;
		 ELSE RAISE EXCEPTION 'unknown media reference ownership mode';
		 END CASE;
		 RETURN result;
		 END $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_reference_payload(table_name TEXT, item JSONB, fields TEXT) RETURNS JSONB
		 LANGUAGE plpgsql IMMUTABLE AS $$
		 DECLARE result JSONB := '{}'::jsonb; field TEXT;
		 BEGIN
		 IF item IS NULL THEN RETURN result; END IF;
		 IF table_name='messages' AND COALESCE((item->>'media_deleted')::boolean,FALSE) THEN RETURN result; END IF;
		 IF table_name='media_assets' AND COALESCE(item->>'status','active')<>'active' THEN RETURN result; END IF;
		 IF table_name='survey_file_uploads' AND COALESCE(item->>'status','staged') IN ('deleted','deleting') THEN RETURN result; END IF;
		 FOREACH field IN ARRAY string_to_array(fields,',') LOOP
		   IF item->field IS NOT NULL AND item->field<>'null'::jsonb THEN result := result || jsonb_build_object(field,item->field); END IF;
		 END LOOP;
		 RETURN result;
		 END $$`,
		`CREATE OR REPLACE FUNCTION clarin_storage_reference_guard() RETURNS trigger
		 LANGUAGE plpgsql AS $$
		 DECLARE old_item JSONB; new_item JSONB; old_payload JSONB; new_payload JSONB;
		 old_account UUID; new_account UUID; lock_account UUID; epoch BIGINT;
		 old_keys TEXT[]; new_keys TEXT[]; candidate_key TEXT; field TEXT; asset_id UUID; asset_key TEXT;
		 BEGIN
		 IF TG_OP<>'INSERT' THEN old_item:=to_jsonb(OLD); old_account:=clarin_storage_reference_account(TG_ARGV[0],old_item); END IF;
		 IF TG_OP<>'DELETE' THEN new_item:=to_jsonb(NEW); new_account:=clarin_storage_reference_account(TG_ARGV[0],new_item); END IF;
		 old_payload:=clarin_storage_reference_payload(TG_TABLE_NAME,old_item,TG_ARGV[1]);
		 new_payload:=clarin_storage_reference_payload(TG_TABLE_NAME,new_item,TG_ARGV[1]);
		 IF TG_OP='UPDATE' AND old_account IS NOT DISTINCT FROM new_account AND old_payload=new_payload THEN RETURN NEW; END IF;
		 IF old_payload='{}'::jsonb AND new_payload='{}'::jsonb THEN
		   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
		 END IF;
		 FOR lock_account IN SELECT DISTINCT a FROM unnest(ARRAY[old_account,new_account]) a WHERE a IS NOT NULL ORDER BY a LOOP
		   PERFORM pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:'||lock_account::text,0));
		   -- Cleanup increments this row before committing its durable intent.
		   -- FOR SHARE also makes an older REPEATABLE READ snapshot fail safely.
		   SELECT version INTO epoch FROM storage_reference_epochs WHERE account_id=lock_account FOR SHARE;
		   IF NOT FOUND AND EXISTS(SELECT 1 FROM accounts WHERE id=lock_account) THEN
		     RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='Media account barrier is unavailable; retry the operation';
		   END IF;
		 END LOOP;
		 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
		 IF new_account IS NULL AND new_payload<>'{}'::jsonb THEN
		   RAISE EXCEPTION USING ERRCODE='23503', MESSAGE='Media reference owner is unavailable';
		 END IF;
		 old_keys:=clarin_storage_reference_keys(old_payload);
		 new_keys:=clarin_storage_reference_keys(new_payload);
		 FOREACH field IN ARRAY ARRAY['media_asset_id','avatar_media_asset_id','derivative_asset_id'] LOOP
		   IF NULLIF(new_payload->>field,'') IS NULL THEN CONTINUE; END IF;
		   asset_id:=(new_payload->>field)::uuid;
		   -- Domain upload transactions legitimately attach staged assets before
		   -- promoting them. Their lifecycle remains owned by that module; this
		   -- barrier rejects only a missing/foreign asset or our exact tombstone.
		   SELECT ma.object_key INTO asset_key FROM media_assets ma WHERE ma.account_id=new_account AND ma.id=asset_id;
		   IF NOT FOUND THEN
		     RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The referenced media is no longer available';
		   END IF;
		   new_keys:=array_append(new_keys,asset_key);
		 END LOOP;
		 IF NULLIF(new_payload->>'survey_upload_id','') IS NOT NULL THEN
		   SELECT u.object_key INTO asset_key FROM survey_file_uploads u WHERE u.account_id=new_account AND u.id=(new_payload->>'survey_upload_id')::uuid AND u.status IN ('staged','attached');
		   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The survey upload is no longer available'; END IF;
		   new_keys:=array_append(new_keys,asset_key);
		 END IF;
		 FOREACH candidate_key IN ARRAY new_keys LOOP
		   -- Retaining an unchanged historic URL is not a newly granted reference.
		   -- Tombstones are still checked so malformed old data cannot reactivate.
		   IF split_part(candidate_key,'/',1)<>new_account::text AND NOT(candidate_key=ANY(old_keys) AND old_account=new_account) THEN
		     RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Media must belong to the same account';
		   END IF;
		   IF EXISTS(SELECT 1 FROM storage_media_trash t WHERE t.account_id=new_account AND t.object_key=candidate_key AND t.state IN ('purging','purged')) THEN
		     RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The referenced media is being permanently removed';
		   END IF;
		 END LOOP;
		 RETURN NEW;
		 END $$`,
	}
	for _, spec := range storageReferenceGuardSpecs {
		migrations = append(migrations,
			fmt.Sprintf(`DROP TRIGGER IF EXISTS clarin_storage_reference_barrier ON %s`, spec.table),
			fmt.Sprintf(`CREATE TRIGGER clarin_storage_reference_barrier BEFORE INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION clarin_storage_reference_guard('%s','%s')`, spec.table, spec.accountMode, spec.fields),
		)
	}
	return migrations
}
