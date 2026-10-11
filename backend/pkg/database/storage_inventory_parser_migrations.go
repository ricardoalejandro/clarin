package database

// This marker is schema metadata, shared across accounts. It records one
// atomic upgrade of an existing projection, never media ownership or access.
// Only projection generations change; the bounded worker rebuilds references
// from their own account's sources, without scanning payloads at startup.
func storageInventoryParserMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS storage_inventory_projection_upgrades (
		 version TEXT PRIMARY KEY,
		 applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`DO $$ BEGIN
		 INSERT INTO storage_inventory_projection_upgrades(version)
		 VALUES('exact-object-key-parser-v2') ON CONFLICT DO NOTHING;
		 IF FOUND THEN
		   UPDATE storage_inventory_sources
		   SET generation=nextval('storage_inventory_generation_seq'),
		       changed_at=clock_timestamp(),next_attempt_at=NOW(),attempts=0,last_error=''
		   WHERE indexed_generation>0;
		 END IF;
		 END $$`,
	}
}
