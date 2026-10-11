package database

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestStorageInventorySourceSpecification(t *testing.T) {
	sources := map[string]storageInventorySourceSpec{}
	for _, spec := range storageInventorySourceSpecs() {
		if _, duplicate := sources[spec.table]; duplicate {
			t.Fatalf("duplicate inventory source %q", spec.table)
		}
		if spec.mediaFields == "" || spec.accountMode == "" || !strings.Contains(","+spec.changeFields+",", ",account_id,") {
			t.Fatalf("incomplete inventory source: %+v", spec)
		}
		sources[spec.table] = spec
	}
	for _, guard := range storageReferenceGuardSpecs {
		spec, ok := sources[guard.table]
		if !ok || spec.accountMode != guard.accountMode {
			t.Fatalf("guarded writer %s has no equivalent inventory invalidation", guard.table)
		}
		for _, field := range strings.Split(guard.fields, ",") {
			if !strings.Contains(","+spec.changeFields+",", ","+field+",") {
				t.Fatalf("%s.%s can change without invalidating inventory", guard.table, field)
			}
		}
	}
	if sources["messages"].mediaFields != "media_url,media_asset_id" || sources["contacts"].mediaFields != "avatar_url,avatar_media_asset_id" {
		t.Fatal("plain messages or contacts must not be treated as media sources")
	}
	for table, field := range map[string]string{
		"messages": "chat_id", "campaign_attachments": "campaign_id", "quick_reply_attachments": "quick_reply_id",
		"dynamic_items": "dynamic_id", "dynamic_links": "dynamic_id", "dynamic_link_extra_media": "link_id",
		"survey_answers": "response_id", "task_attachments": "task_id", "whiteboard_assets": "library_id",
		"whiteboard_revision_assets": "revision_id", "media_assets": "filename", "storage_objects": "object_key",
	} {
		if !strings.Contains(","+sources[table].changeFields+",", ","+field+",") {
			t.Fatalf("%s.%s is missing from invalidation fields", table, field)
		}
	}
}

// Every run creates its own disposable database. Validate pgx's effective
// configuration, including URI overrides/fallbacks, before any mutation.
func TestStorageInventoryMigrationsIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_STORAGE_INVENTORY_INTEGRATION") != "1" {
		t.Skip("enable against disposable loopback PostgreSQL 16")
	}
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		t.Fatal("parse inventory test database configuration")
	}
	if cfg.ConnConfig.Host != "127.0.0.1" || (cfg.ConnConfig.Database != "clarin_cloud_dev" && cfg.ConnConfig.Database != "program_survey_integrity_test" && !strings.HasPrefix(cfg.ConnConfig.Database, "clarin_storage_")) {
		t.Fatal("inventory migration tests require a disposable loopback database")
	}
	for _, fallback := range cfg.ConnConfig.Fallbacks {
		if fallback.Host != "127.0.0.1" || fallback.Port != cfg.ConnConfig.Port {
			t.Fatal("inventory test database cannot fall back to another host")
		}
	}
	ctx := context.Background()
	admin, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal("connect inventory test database")
	}
	defer admin.Close()
	var version int
	if err := admin.QueryRow(ctx, `SELECT current_setting('server_version_num')::integer`).Scan(&version); err != nil || version < 160000 || version >= 170000 {
		t.Fatalf("native PostgreSQL 16 is required: version=%d query_error=%t", version, err != nil)
	}
	name := "clarin_storage_inventory_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+name); err != nil {
		t.Fatal("create isolated inventory test database")
	}
	defer func() {
		if _, err := admin.Exec(ctx, `DROP DATABASE `+name); err != nil {
			t.Error("could not remove owned inventory test database")
		}
	}()
	isolated := cfg.Copy()
	isolated.ConnConfig.Database = name
	db, err := pgxpool.NewWithConfig(ctx, isolated)
	if err != nil {
		t.Fatal("connect isolated inventory test database")
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatal(err)
	}
	migrate := func() {
		t.Helper()
		for i, statement := range StorageInventoryMigrations() {
			if _, err := db.Exec(ctx, statement); err != nil {
				t.Fatalf("inventory migration %d: %v", i, err)
			}
		}
	}
	migrate()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	accountA, accountB := uuid.New(), uuid.New()
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Inventory QA A'),($2,'Inventory QA B')`, accountA, accountB)
	contactA, contactB, chatA, chatB, assetA, assetB, messageA, messageB := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	keyA, keyB := accountA.String()+"/uploads/inventory.pdf", accountB.String()+"/uploads/inventory.pdf"
	for _, fixture := range []struct {
		account, contact, chat, asset, message uuid.UUID
		key                                    string
	}{
		{accountA, contactA, chatA, assetA, messageA, keyA}, {accountB, contactB, chatB, assetB, messageB, keyB},
	} {
		exec(`INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Inventory contact')`, fixture.contact, fixture.account, fixture.contact.String())
		exec(`INSERT INTO chats(id,account_id,contact_id,jid,name) VALUES($1,$2,$3,$4,'Inventory chat')`, fixture.chat, fixture.account, fixture.contact, fixture.contact.String())
		exec(`INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,size_bytes) VALUES($1,$2,$3,$4,'inventory.pdf',10)`, fixture.asset, fixture.account, fixture.asset.String(), fixture.key)
		exec(`INSERT INTO messages(id,account_id,chat_id,message_id,timestamp,media_asset_id,media_filename) VALUES($1,$2,$3,$4,NOW(),$5,'inventory.pdf')`, fixture.message, fixture.account, fixture.chat, fixture.message.String(), fixture.asset)
	}
	generation := func(account uuid.UUID, kind string, id uuid.UUID) int64 {
		t.Helper()
		var value int64
		if err := db.QueryRow(ctx, `SELECT generation FROM storage_inventory_sources WHERE account_id=$1 AND source_kind=$2 AND source_id=$3`, account, kind, id.String()).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	assertInvalidated := func(account uuid.UUID, kind string, id uuid.UUID, previous int64) {
		t.Helper()
		if got := generation(account, kind, id); got == previous {
			t.Fatalf("%s source retained stale generation %d", kind, got)
		}
	}
	t.Run("plain messages and irrelevant edits do not enqueue work", func(t *testing.T) {
		for i := 0; i < 20; i++ {
			exec(`INSERT INTO messages(account_id,chat_id,message_id,timestamp,body) VALUES($1,$2,$3,NOW(),'Text only')`, accountA, chatA, fmt.Sprintf("plain-%d", i))
		}
		var count int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_inventory_sources WHERE account_id=$1 AND source_kind IN ('messages','contacts')`, accountA).Scan(&count); err != nil || count != 1 {
			t.Fatalf("plain content created inventory work: count=%d err=%v", count, err)
		}
		before := generation(accountA, "messages", messageA)
		exec(`UPDATE messages SET body='Edited text',is_read=TRUE WHERE account_id=$1 AND id=$2`, accountA, messageA)
		if got := generation(accountA, "messages", messageA); got != before {
			t.Fatal("unrelated message edit invalidated media")
		}
	})
	t.Run("metadata and asset changes invalidate immediately only in their account", func(t *testing.T) {
		beforeA, beforeB := generation(accountA, "messages", messageA), generation(accountB, "messages", messageB)
		exec(`UPDATE storage_inventory_sources SET indexed_generation=generation WHERE account_id=$1 AND source_kind='messages' AND source_id=$2`, accountA, messageA.String())
		exec(`INSERT INTO storage_inventory_references(account_id,source_kind,source_id,object_key,source_generation,origin,ref_id,readable)
		 SELECT account_id,source_kind,source_id,$3,generation,'chats',source_id,TRUE FROM storage_inventory_sources WHERE account_id=$1 AND source_kind='messages' AND source_id=$2`, accountA, messageA.String(), keyA)
		exec(`UPDATE media_assets SET filename='renamed.pdf',object_key=$3 WHERE account_id=$1 AND id=$2`, accountA, assetA, accountA.String()+"/uploads/renamed.pdf")
		assertInvalidated(accountA, "messages", messageA, beforeA)
		if generation(accountB, "messages", messageB) != beforeB {
			t.Fatal("account A asset change invalidated account B")
		}
		var visible int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_inventory_references r JOIN storage_inventory_sources s USING(account_id,source_kind,source_id)
		 WHERE r.account_id=$1 AND r.readable AND r.source_generation=s.generation AND s.indexed_generation=s.generation`, accountA).Scan(&visible); err != nil || visible != 0 {
			t.Fatalf("stale asset key stayed authorized: count=%d err=%v", visible, err)
		}
		beforeA = generation(accountA, "messages", messageA)
		exec(`UPDATE messages SET media_filename='message-renamed.pdf' WHERE account_id=$1 AND id=$2`, accountA, messageA)
		assertInvalidated(accountA, "messages", messageA, beforeA)
		beforeA = generation(accountA, "messages", messageA)
		exec(`UPDATE chats SET name='Renamed chat' WHERE account_id=$1 AND id=$2`, accountA, chatA)
		assertInvalidated(accountA, "messages", messageA, beforeA)
	})
	t.Run("parent changes and cascaded legacy child deletion invalidate", func(t *testing.T) {
		parent, otherParent, child := uuid.New(), uuid.New(), uuid.New()
		for _, id := range []uuid.UUID{parent, otherParent} {
			exec(`INSERT INTO dynamics(id,account_id,type,name,slug) VALUES($1,$2,'scratch','Inventory dynamic',$3)`, id, accountA, id.String())
		}
		exec(`INSERT INTO dynamic_items(id,dynamic_id,image_url) VALUES($1,$2,$3)`, child, parent, "/api/media/file/"+keyA)
		before := generation(accountA, "dynamic_items", child)
		exec(`UPDATE dynamics SET name='Renamed dynamic' WHERE account_id=$1 AND id=$2`, accountA, parent)
		assertInvalidated(accountA, "dynamic_items", child, before)
		before = generation(accountA, "dynamic_items", child)
		exec(`UPDATE dynamic_items SET dynamic_id=$2 WHERE id=$1`, child, otherParent)
		assertInvalidated(accountA, "dynamic_items", child, before)
		before = generation(accountA, "dynamic_items", child)
		exec(`DELETE FROM dynamics WHERE account_id=$1 AND id=$2`, accountA, otherParent)
		assertInvalidated(accountA, "dynamic_items", child, before)
	})
	t.Run("physical totals account for both buckets and presence without drift", func(t *testing.T) {
		assertTotals := func(account uuid.UUID, wantCount, wantBytes int64) {
			t.Helper()
			var count, bytes int64
			if err := db.QueryRow(ctx, `SELECT object_count,size_bytes FROM storage_inventory_totals WHERE account_id=$1`, account).Scan(&count, &bytes); err != nil || count != wantCount || bytes != wantBytes {
				t.Fatalf("totals=%d/%d want=%d/%d err=%v", count, bytes, wantCount, wantBytes, err)
			}
		}
		for _, bucket := range []string{"ordinary", "private"} {
			exec(`INSERT INTO storage_inventory_objects(account_id,bucket_kind,object_key,size_bytes,last_modified) VALUES($1,$2,$3,10,NOW())`, accountA, bucket, keyA)
		}
		exec(`INSERT INTO storage_inventory_objects(account_id,bucket_kind,object_key,size_bytes,last_modified) VALUES($1,'ordinary',$2,7,NOW())`, accountB, keyB)
		assertTotals(accountA, 2, 20)
		assertTotals(accountB, 1, 7)
		exec(`UPDATE storage_inventory_objects SET size_bytes=25,observed_at=NOW() WHERE account_id=$1 AND bucket_kind='ordinary' AND object_key=$2`, accountA, keyA)
		assertTotals(accountA, 2, 35)
		exec(`UPDATE storage_inventory_objects SET presence='missing' WHERE account_id=$1 AND bucket_kind='private' AND object_key=$2`, accountA, keyA)
		assertTotals(accountA, 1, 25)
		exec(`UPDATE storage_inventory_objects SET presence='missing',size_bytes=99 WHERE account_id=$1 AND bucket_kind='private' AND object_key=$2`, accountA, keyA)
		assertTotals(accountA, 1, 25)
		exec(`UPDATE storage_inventory_objects SET presence='present' WHERE account_id=$1 AND bucket_kind='private' AND object_key=$2`, accountA, keyA)
		assertTotals(accountA, 2, 124)
		migrate()
		assertTotals(accountA, 2, 124)
		exec(`DELETE FROM storage_inventory_objects WHERE account_id=$1 AND bucket_kind='private' AND object_key=$2`, accountA, keyA)
		assertTotals(accountA, 1, 25)
		assertTotals(accountB, 1, 7)
		if _, err := db.Exec(ctx, `INSERT INTO storage_inventory_objects(account_id,bucket_kind,object_key,size_bytes,last_modified) VALUES($1,'ordinary',$2,1,NOW())`, accountA, keyB); err == nil {
			t.Fatal("physical inventory accepted another account's key")
		}
		if _, err := db.Exec(ctx, `UPDATE storage_inventory_objects SET size_bytes=-1 WHERE account_id=$1`, accountA); err == nil {
			t.Fatal("physical inventory accepted negative bytes")
		}
		assertTotals(accountA, 1, 25)
	})
	t.Run("parser upgrade atomically hides old references exactly once", func(t *testing.T) {
		// Simulate an already-indexed installation created by the old parser.
		exec(`UPDATE storage_inventory_sources SET indexed_generation=generation WHERE account_id=ANY($1::uuid[])`, []uuid.UUID{accountA, accountB})
		exec(`DELETE FROM storage_inventory_projection_upgrades WHERE version='exact-object-key-parser-v2'`)
		beforeA, beforeB := generation(accountA, "messages", messageA), generation(accountB, "messages", messageB)
		migrate()
		assertInvalidated(accountA, "messages", messageA, beforeA)
		assertInvalidated(accountB, "messages", messageB, beforeB)
		var visible, dirty int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_inventory_references r JOIN storage_inventory_sources s USING(account_id,source_kind,source_id)
		 WHERE r.readable AND r.source_generation=s.generation AND s.indexed_generation=s.generation`).Scan(&visible); err != nil || visible != 0 {
			t.Fatalf("old parser reference remained visible: count=%d err=%v", visible, err)
		}
		if err := db.QueryRow(ctx, `SELECT count(*) FROM storage_inventory_sources WHERE generation<>indexed_generation`).Scan(&dirty); err != nil || dirty == 0 {
			t.Fatalf("upgrade did not leave resumable worker jobs: count=%d err=%v", dirty, err)
		}
		upgradedA, upgradedB := generation(accountA, "messages", messageA), generation(accountB, "messages", messageB)
		migrate()
		if generation(accountA, "messages", messageA) != upgradedA || generation(accountB, "messages", messageB) != upgradedB {
			t.Fatal("repeated startup invalidated the projection again")
		}
	})
	t.Run("deleted accounts leave no projection or totals", func(t *testing.T) {
		exec(`DELETE FROM accounts WHERE id=$1`, accountA)
		for _, table := range []string{"storage_inventory_objects", "storage_inventory_sources", "storage_inventory_references", "storage_inventory_totals"} {
			var count int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM `+table+` WHERE account_id=$1`, accountA).Scan(&count); err != nil || count != 0 {
				t.Fatalf("deleted account retained %s: count=%d err=%v", table, count, err)
			}
		}
		if generation(accountB, "messages", messageB) == 0 {
			t.Fatal("unrelated account disappeared")
		}
	})
}
