package database

// MessageForwardingMigrations is additive so a compatible backend may be
// deployed before the strict frontend. Legacy rows deliberately stay unknown.
func MessageForwardingMigrations() []string {
	return []string{
		`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarding JSONB NOT NULL DEFAULT '{"state":"unknown","score":null}'::jsonb, ADD COLUMN IF NOT EXISTS forwarding_source TEXT NOT NULL DEFAULT 'legacy', ADD COLUMN IF NOT EXISTS audio_ptt BOOLEAN`,
		`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='messages_forwarding_valid') THEN ALTER TABLE messages ADD CONSTRAINT messages_forwarding_valid CHECK(jsonb_typeof(forwarding)='object' AND forwarding ? 'score' AND forwarding->>'state' IS NOT NULL AND forwarding->>'state' IN ('unknown','not_forwarded','forwarded','frequently_forwarded') AND forwarding_source IN ('legacy','provider','clarin') AND (forwarding->>'score' IS NULL OR (jsonb_typeof(forwarding->'score')='number' AND (forwarding->>'score')::numeric BETWEEN 0 AND 4294967295 AND trunc((forwarding->>'score')::numeric)=(forwarding->>'score')::numeric))); END IF; END $$`,
		`CREATE OR REPLACE FUNCTION clarin_merge_message_forwarding(old_value JSONB,new_value JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
 WITH v AS (SELECT CASE old_value->>'state' WHEN 'not_forwarded' THEN 1 WHEN 'forwarded' THEN 2 WHEN 'frequently_forwarded' THEN 3 ELSE 0 END a,CASE new_value->>'state' WHEN 'not_forwarded' THEN 1 WHEN 'forwarded' THEN 2 WHEN 'frequently_forwarded' THEN 3 ELSE 0 END b,GREATEST((old_value->>'score')::bigint,(new_value->>'score')::bigint) score)
 SELECT jsonb_build_object('state',CASE WHEN score>=5 OR GREATEST(a,b)=3 THEN 'frequently_forwarded' WHEN score>0 OR GREATEST(a,b)=2 THEN 'forwarded' WHEN GREATEST(a,b)=1 THEN 'not_forwarded' ELSE 'unknown' END,'score',CASE WHEN GREATEST(a,b)=0 THEN NULL WHEN GREATEST(a,b)=1 THEN 0 ELSE NULLIF(score,0) END) FROM v $$`,
		`CREATE TABLE IF NOT EXISTS message_forward_operations(account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,id UUID NOT NULL,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,device_id UUID NOT NULL,source_chat_id UUID NOT NULL,source_message_id UUID NOT NULL,request_hash TEXT NOT NULL,source_fingerprint TEXT NOT NULL,source_forwarding JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(account_id,id))`,
		`CREATE TABLE IF NOT EXISTS message_forward_targets(account_id UUID NOT NULL,operation_id UUID NOT NULL,chat_id UUID NOT NULL,destination_jid TEXT NOT NULL,provider_message_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','uncertain')),code TEXT NOT NULL DEFAULT '',safe_error TEXT NOT NULL DEFAULT '',can_retry BOOLEAN NOT NULL DEFAULT FALSE,started_at TIMESTAMPTZ,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(account_id,operation_id,chat_id),FOREIGN KEY(account_id,operation_id) REFERENCES message_forward_operations(account_id,id) ON DELETE CASCADE)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS message_forward_targets_provider_id ON message_forward_targets(account_id,provider_message_id)`,
		`CREATE INDEX IF NOT EXISTS message_forward_operations_actor ON message_forward_operations(account_id,user_id,created_at DESC)`,
	}
}
