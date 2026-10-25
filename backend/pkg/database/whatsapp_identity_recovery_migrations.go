package database

// IdentityRecoveryMigrations is additive and runs from the normal startup list.
func IdentityRecoveryMigrations() []string {
	return []string{`
CREATE TABLE IF NOT EXISTS whatsapp_identity_scopes(
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,device_id UUID NOT NULL,
 session_fingerprint TEXT NOT NULL DEFAULT '',session_generation BIGINT NOT NULL DEFAULT 0,
 session_started_at TIMESTAMPTZ,next_lookup_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',identity_revision BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(account_id,device_id),FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id) ON DELETE CASCADE);
ALTER TABLE whatsapp_peer_identity_fields ADD COLUMN IF NOT EXISTS session_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_peer_identity_aliases ADD COLUMN IF NOT EXISTS session_generation BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS whatsapp_identity_group_versions(
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,device_id UUID NOT NULL,group_jid TEXT NOT NULL,
 revision BIGINT NOT NULL DEFAULT 0,material JSONB,
 PRIMARY KEY(account_id,device_id,group_jid),FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS whatsapp_identity_crm_versions(account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,revision BIGINT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS whatsapp_identity_recovery_runs(
 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,id UUID NOT NULL DEFAULT gen_random_uuid(),device_id UUID NOT NULL,
 version INT NOT NULL,session_generation BIGINT NOT NULL,session_fingerprint TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','recovering','completed','partial','waiting_connection','error','cancelled')),
 phase TEXT NOT NULL DEFAULT 'inventory',unresolved_members INT NOT NULL DEFAULT 0,appstate_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
 attempts INT NOT NULL DEFAULT 0,last_error_code TEXT NOT NULL DEFAULT '',
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),lease_id UUID,lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(account_id,id),UNIQUE(account_id,device_id,version,session_generation),
 FOREIGN KEY(account_id,device_id) REFERENCES devices(account_id,id) ON DELETE CASCADE);
ALTER TABLE whatsapp_identity_recovery_runs ALTER COLUMN phase SET DEFAULT 'inventory';
ALTER TABLE whatsapp_identity_recovery_runs ADD COLUMN IF NOT EXISTS unresolved_members INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_whatsapp_identity_recovery_due ON whatsapp_identity_recovery_runs(next_attempt_at,updated_at) WHERE state IN('pending','recovering','waiting_connection');
CREATE TABLE IF NOT EXISTS whatsapp_identity_recovery_items(
 account_id UUID NOT NULL,run_id UUID NOT NULL,pn_jid TEXT NOT NULL CHECK(pn_jid ~ '^[0-9]{7,15}@s[.]whatsapp[.]net$'),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','resolved','unavailable','error','conflict')),
 attempts INT NOT NULL DEFAULT 0,next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),last_error_code TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(account_id,run_id,pn_jid),FOREIGN KEY(account_id,run_id) REFERENCES whatsapp_identity_recovery_runs(account_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS idx_whatsapp_identity_recovery_items_due ON whatsapp_identity_recovery_items(account_id,run_id,next_attempt_at,pn_jid) WHERE state='pending';
CREATE OR REPLACE FUNCTION clarin_identity_material_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a UUID;d UUID;material_changed BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN a=OLD.account_id;d=OLD.device_id;material_changed=TRUE;
 ELSE a=NEW.account_id;d=NEW.device_id;
  IF TG_OP='INSERT' THEN material_changed=TRUE;
  ELSIF TG_TABLE_NAME='whatsapp_peer_identity_fields' THEN material_changed=OLD.value IS DISTINCT FROM NEW.value;
  ELSE material_changed=(OLD.pn_jid,OLD.lid_jid) IS DISTINCT FROM (NEW.pn_jid,NEW.lid_jid);END IF;
 END IF;
 IF material_changed AND EXISTS(SELECT 1 FROM devices WHERE account_id=a AND id=d AND delete_operation_id IS NULL) THEN
  INSERT INTO whatsapp_identity_scopes(account_id,device_id,identity_revision) VALUES(a,d,1)
  ON CONFLICT(account_id,device_id) DO UPDATE SET identity_revision=whatsapp_identity_scopes.identity_revision+1;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS whatsapp_identity_fields_revision ON whatsapp_peer_identity_fields;
CREATE TRIGGER whatsapp_identity_fields_revision AFTER INSERT OR UPDATE OR DELETE ON whatsapp_peer_identity_fields FOR EACH ROW EXECUTE FUNCTION clarin_identity_material_revision();
DROP TRIGGER IF EXISTS whatsapp_identity_aliases_revision ON whatsapp_peer_identity_aliases;
CREATE TRIGGER whatsapp_identity_aliases_revision AFTER INSERT OR UPDATE OR DELETE ON whatsapp_peer_identity_aliases FOR EACH ROW EXECUTE FUNCTION clarin_identity_material_revision();
CREATE OR REPLACE FUNCTION clarin_whatsapp_group_material(p JSONB,a BOOLEAN,s BOOLEAN,k TEXT,m TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('members',COALESCE((SELECT jsonb_agg(jsonb_build_object(
  'jid',COALESCE(NULLIF(member->>'lid',''),CASE WHEN member->>'jid' LIKE '%@lid' THEN member->>'jid' ELSE member->>'jid' END),
  'lid',COALESCE(NULLIF(member->>'lid',''),CASE WHEN member->>'jid' LIKE '%@lid' THEN member->>'jid' ELSE '' END),
  'phone',COALESCE(NULLIF(member->>'phone',''),CASE WHEN member->>'jid' LIKE '%@s.whatsapp.net' THEN split_part(member->>'jid','@',1) ELSE '' END),
  'role',COALESCE(NULLIF(member->>'role',''),'member')) ORDER BY COALESCE(NULLIF(member->>'lid',''),member->>'jid')) FROM jsonb_array_elements(COALESCE(p,'[]'::jsonb)) member),'[]'::jsonb),
  'announce',COALESCE(a,FALSE),'suspended',COALESCE(s,FALSE),'kind',COALESCE(NULLIF(k,''),'group'),'membership',COALESCE(NULLIF(m,''),'unknown'))
$$;
CREATE OR REPLACE FUNCTION clarin_whatsapp_group_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a UUID;d UUID;j TEXT;v JSONB;
BEGIN
 IF TG_OP='DELETE' THEN a=OLD.account_id;SELECT device_id,jid INTO d,j FROM chats WHERE account_id=a AND id=OLD.chat_id;v=NULL;
 ELSE a=NEW.account_id;SELECT device_id,jid INTO d,j FROM chats WHERE account_id=a AND id=NEW.chat_id;
  v=clarin_whatsapp_group_material(NEW.participants,NEW.announce,NEW.suspended,NEW.kind,NEW.membership_status);
 END IF;
 IF d IS NOT NULL AND EXISTS(SELECT 1 FROM devices WHERE account_id=a AND id=d AND delete_operation_id IS NULL) THEN
  INSERT INTO whatsapp_identity_group_versions(account_id,device_id,group_jid,revision,material) VALUES(a,d,j,1,v)
  ON CONFLICT(account_id,device_id,group_jid) DO UPDATE SET revision=whatsapp_identity_group_versions.revision+1,material=EXCLUDED.material
  WHERE whatsapp_identity_group_versions.material IS DISTINCT FROM EXCLUDED.material;
 END IF;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION clarin_whatsapp_group_chat_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.device_id IS NOT NULL AND OLD.jid LIKE '%@g.us' AND EXISTS(SELECT 1 FROM devices WHERE account_id=OLD.account_id AND id=OLD.device_id AND delete_operation_id IS NULL) THEN
  INSERT INTO whatsapp_identity_group_versions(account_id,device_id,group_jid,revision,material) VALUES(OLD.account_id,OLD.device_id,OLD.jid,1,NULL)
  ON CONFLICT(account_id,device_id,group_jid) DO UPDATE SET revision=whatsapp_identity_group_versions.revision+1,material=NULL;
 END IF;RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS whatsapp_identity_group_chat_deleted ON chats;
CREATE TRIGGER whatsapp_identity_group_chat_deleted BEFORE DELETE ON chats FOR EACH ROW EXECUTE FUNCTION clarin_whatsapp_group_chat_deleted();
DROP TRIGGER IF EXISTS whatsapp_identity_group_revision ON chat_groups;
CREATE TRIGGER whatsapp_identity_group_revision AFTER INSERT OR UPDATE OR DELETE ON chat_groups FOR EACH ROW EXECUTE FUNCTION clarin_whatsapp_group_revision();
CREATE OR REPLACE FUNCTION clarin_whatsapp_crm_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_row JSONB;new_row JSONB;scope_row JSONB;a UUID;contact UUID;different BOOLEAN=FALSE;field TEXT;
BEGIN
 IF TG_OP<>'INSERT' THEN old_row=to_jsonb(OLD);END IF;
 IF TG_OP<>'DELETE' THEN new_row=to_jsonb(NEW);END IF;
 scope_row=COALESCE(new_row,old_row);
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='contacts' THEN
   FOREACH field IN ARRAY ARRAY['jid','phone','name','last_name','custom_name','push_name','avatar_url','is_group','do_not_contact','source'] LOOP
    different=different OR (old_row->field IS DISTINCT FROM new_row->field);
   END LOOP;
  ELSIF TG_TABLE_NAME='chats' THEN
   FOREACH field IN ARRAY ARRAY['contact_id','last_message_at'] LOOP different=different OR (old_row->field IS DISTINCT FROM new_row->field);END LOOP;
  ELSIF TG_TABLE_NAME='leads' THEN different=old_row IS DISTINCT FROM new_row;
  ELSE different=(old_row-ARRAY['updated_at','created_at']) IS DISTINCT FROM (new_row-ARRAY['updated_at','created_at']);END IF;
  IF NOT different THEN RETURN NULL;END IF;
 END IF;
 IF TG_TABLE_NAME='chats' AND COALESCE(scope_row->>'jid','') LIKE '%@g.us' THEN RETURN NULL;END IF;
 a=NULLIF(scope_row->>'account_id','')::uuid;
 IF a IS NULL AND TG_TABLE_NAME='pipeline_stages' THEN SELECT account_id INTO a FROM pipelines WHERE id=NULLIF(scope_row->>'pipeline_id','')::uuid;END IF;
 IF a IS NULL THEN contact=NULLIF(scope_row->>'contact_id','')::uuid;SELECT account_id INTO a FROM contacts WHERE id=contact;END IF;
 IF a IS NOT NULL AND EXISTS(SELECT 1 FROM accounts WHERE id=a) THEN
  INSERT INTO whatsapp_identity_crm_versions(account_id,revision) VALUES(a,1) ON CONFLICT(account_id) DO UPDATE SET revision=whatsapp_identity_crm_versions.revision+1;
 END IF;RETURN NULL;
END $$;
DO $$ DECLARE tab TEXT;BEGIN FOREACH tab IN ARRAY ARRAY['contacts','contact_aliases','contact_phones','contact_tags','tags','leads','pipelines','pipeline_stages','chats'] LOOP
 IF to_regclass(tab) IS NOT NULL THEN EXECUTE format('DROP TRIGGER IF EXISTS whatsapp_identity_crm_revision ON %I',tab);
 EXECUTE format('CREATE TRIGGER whatsapp_identity_crm_revision AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION clarin_whatsapp_crm_revision()',tab);END IF;
END LOOP;END $$;
`}
}
