package database

import (
	"context"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TestContactBackfillMigrationIntegration checks the complete startup path in a
// disposable database. Full-row fingerprints intentionally include every
// Contact field, all timestamps, and the compatibility snapshots.
func TestContactBackfillMigrationIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CONTACT_BACKFILL_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_CONTACT_BACKFILL_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	databaseName := "clarin_contact_backfill_" + uuid.New().String()[:8]
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect administrative database: %v", err)
	}
	defer admin.Close()
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	exec := func(t *testing.T, query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatalf("prepare/check migration fixture: %v", err)
		}
	}
	migrate := func(t *testing.T) {
		t.Helper()
		if err := Migrate(db); err != nil {
			t.Fatalf("startup migration: %v", err)
		}
	}
	type fingerprint struct {
		Count int64
		Hash  string
	}
	snapshot := func(t *testing.T) map[string]fingerprint {
		t.Helper()
		result := make(map[string]fingerprint)
		for _, table := range []string{"contacts", "leads", "chats", "messages", "chat_group_message_state", "event_participants", "campaign_recipients", "contact_profile_migration_conflicts"} {
			var value fingerprint
			if err := db.QueryRow(ctx, `SELECT count(*),md5(COALESCE(string_agg(to_jsonb(t)::text,'' ORDER BY t.id),'')) FROM `+table+` t`).Scan(&value.Count, &value.Hash); err != nil {
				t.Fatalf("fingerprint %s: %v", table, err)
			}
			result[table] = value
		}
		return result
	}
	assertPreserved := func(t *testing.T, before map[string]fingerprint) {
		t.Helper()
		after := snapshot(t)
		for table, expected := range before {
			if after[table] != expected {
				t.Errorf("%s changed across startup (before count=%d, after count=%d)", table, expected.Count, after[table].Count)
			}
		}
	}
	assertMarker := func(t *testing.T, want bool) {
		t.Helper()
		var exists bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM app_data_migrations WHERE key='contact_profile_canonical_v1')`).Scan(&exists); err != nil || exists != want {
			t.Fatalf("profile migration marker exists=%v, want=%v, err=%v", exists, want, err)
		}
	}
	migrate(t)

	account, foreignAccount, device, contact := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	event, participant, lead, campaign, recipient := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec(t, `INSERT INTO accounts(id,name) VALUES($1,'Current Contact QA'),($2,'Other Contact QA')`, account, foreignAccount)
	exec(t, `INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Synthetic device')`, device, account)
	exec(t, `INSERT INTO contacts(id,account_id,jid,created_at,updated_at) VALUES($1,$2,$3,NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day')`, contact, account, contact.String()+"@test")
	exec(t, `INSERT INTO events(id,account_id,name) VALUES($1,$2,'Synthetic event')`, event, account)
	exec(t, `INSERT INTO event_participants(id,event_id,contact_id,name,email) VALUES($1,$2,$3,'Historical name','old@example.test')`, participant, event, contact)
	exec(t, `INSERT INTO leads(id,account_id,contact_id,title,jid,name,email) VALUES($1,$2,$3,'Synthetic lead','synthetic-lead@test','Historical name','old@example.test')`, lead, account, contact)
	exec(t, `INSERT INTO campaigns(id,account_id,device_id,name,message_template) VALUES($1,$2,$3,'Synthetic campaign','test')`, campaign, account, device)
	exec(t, `INSERT INTO campaign_recipients(id,campaign_id,contact_id,jid,name,phone) VALUES($1,$2,$3,'old@test','Historical recipient','000')`, recipient, campaign, contact)

	t.Run("completed_installation_bootstraps_marker_without_data_replay", func(t *testing.T) {
		// The old installation has its final trigger but predates the ledger.
		exec(t, `DELETE FROM app_data_migrations WHERE key='contact_profile_canonical_v1'`)
		before := snapshot(t)
		for pass := 0; pass < 2; pass++ {
			migrate(t)
			assertPreserved(t, before)
			assertMarker(t, true)
		}
		var name *string
		var fetched *time.Time
		if err := db.QueryRow(ctx, `SELECT custom_name,avatar_auto_fetched_at FROM contacts WHERE account_id=$1 AND id=$2`, account, contact).Scan(&name, &fetched); err != nil || name != nil || fetched != nil {
			t.Fatalf("current null identity/auto-fetch state was rewritten: name_set=%v fetched_set=%v err=%v", name != nil, fetched != nil, err)
		}
	})

	t.Run("avatar_backfill_only_when_column_is_introduced", func(t *testing.T) {
		checked, unchecked, recent, afterInstall := uuid.New(), uuid.New(), uuid.New(), uuid.New()
		checkedAt := time.Date(2020, 2, 3, 4, 5, 6, 0, time.UTC)
		exec(t, `INSERT INTO contacts(id,account_id,jid,created_at,avatar_checked_at) VALUES($1,$2,$3,NOW()-INTERVAL '1 day',$4)`, checked, account, checked.String()+"@test", checkedAt)
		exec(t, `INSERT INTO contacts(id,account_id,jid,created_at) VALUES($1,$3,$4,NOW()-INTERVAL '1 day'),($2,$3,$5,NOW()+INTERVAL '1 day')`, unchecked, recent, account, unchecked.String()+"@test", recent.String()+"@test")
		exec(t, `ALTER TABLE contacts DROP COLUMN avatar_auto_fetched_at`)
		migrate(t)
		var checkedValue, uncheckedValue, recentValue *time.Time
		if err := db.QueryRow(ctx, `SELECT
		 (SELECT avatar_auto_fetched_at FROM contacts WHERE id=$1),
		 (SELECT avatar_auto_fetched_at FROM contacts WHERE id=$2),
		 (SELECT avatar_auto_fetched_at FROM contacts WHERE id=$3)`, checked, unchecked, recent).Scan(&checkedValue, &uncheckedValue, &recentValue); err != nil {
			t.Fatal(err)
		}
		if checkedValue == nil || !checkedValue.Equal(checkedAt) || uncheckedValue == nil || recentValue != nil {
			t.Fatalf("legacy avatar backfill did not preserve checked timestamp/age rule")
		}
		// Once installed, a current Contact can legitimately retain NULL even
		// when old enough to have matched the former startup backfill.
		exec(t, `INSERT INTO contacts(id,account_id,jid,created_at) VALUES($1,$2,$3,NOW()-INTERVAL '1 day')`, afterInstall, foreignAccount, afterInstall.String()+"@test")
		before := snapshot(t)
		migrate(t)
		assertPreserved(t, before)
		var isNull bool
		if err := db.QueryRow(ctx, `SELECT avatar_auto_fetched_at IS NULL FROM contacts WHERE account_id=$1 AND id=$2`, foreignAccount, afterInstall).Scan(&isNull); err != nil || !isNull {
			t.Fatalf("post-install Contact was backfilled on restart: null=%v err=%v", isNull, err)
		}
	})

	t.Run("legacy_profile_recovers_once_atomically_and_keeps_account_scope", func(t *testing.T) {
		legacy, conflict, foreignEvent, foreignParticipant := uuid.New(), uuid.New(), uuid.New(), uuid.New()
		legacyParticipant, conflictLeadA, conflictLeadB := uuid.New(), uuid.New(), uuid.New()
		exec(t, `INSERT INTO contacts(id,account_id,jid) VALUES($1,$3,$4),($2,$3,$5)`, legacy, conflict, account, legacy.String()+"@test", conflict.String()+"@test")
		exec(t, `INSERT INTO event_participants(id,event_id,contact_id,name,email) VALUES($1,$2,$3,'Recovered once','recover@example.test')`, legacyParticipant, event, legacy)
		exec(t, `INSERT INTO leads(id,account_id,contact_id,title,jid,age) VALUES($1,$3,$4,'Conflict A','conflict-a@test',20),($2,$3,$4,'Conflict B','conflict-b@test',21)`, conflictLeadA, conflictLeadB, account, conflict)
		// A malformed legacy cross-account reference must never supply identity.
		exec(t, `INSERT INTO events(id,account_id,name) VALUES($1,$2,'Foreign synthetic event')`, foreignEvent, foreignAccount)
		exec(t, `INSERT INTO event_participants(id,event_id,contact_id,name,email) VALUES($1,$2,$3,'Foreign name','foreign@example.test')`, foreignParticipant, foreignEvent, legacy)
		exec(t, `DROP TRIGGER trg_contacts_sync_identity_snapshots ON contacts;
		 DELETE FROM app_data_migrations WHERE key='contact_profile_canonical_v1'`)
		// Fail the third DML after Contact and Event writes. Every preceding
		// profile write and the completion marker must roll back together.
		exec(t, `CREATE FUNCTION qa_fail_profile_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'expected profile fixture failure'; END $$;
		 CREATE TRIGGER qa_fail_profile_projection BEFORE UPDATE ON campaign_recipients FOR EACH ROW EXECUTE FUNCTION qa_fail_profile_projection()`)
		beforeFailure := snapshot(t)
		if err := Migrate(db); err == nil || !strings.Contains(err.Error(), "expected profile fixture failure") {
			t.Fatalf("expected injected profile projection failure, got: %v", err)
		}
		assertPreserved(t, beforeFailure)
		assertMarker(t, false)
		exec(t, `DROP TRIGGER qa_fail_profile_projection ON campaign_recipients; DROP FUNCTION qa_fail_profile_projection()`)
		migrate(t)
		assertMarker(t, true)
		var name, email *string
		if err := db.QueryRow(ctx, `SELECT custom_name,email FROM contacts WHERE account_id=$1 AND id=$2`, account, legacy).Scan(&name, &email); err != nil || name == nil || *name != "Recovered once" || email == nil || *email != "recover@example.test" {
			t.Fatalf("first legacy migration failed to recover same-account unique values: %v", err)
		}
		var conflictAge *int
		var evidence []int
		if err := db.QueryRow(ctx, `SELECT age FROM contacts WHERE account_id=$1 AND id=$2`, account, conflict).Scan(&conflictAge); err != nil || conflictAge != nil {
			t.Fatalf("conflicting historical values must not be promoted: %v", err)
		}
		if err := db.QueryRow(ctx, `SELECT ARRAY(SELECT jsonb_array_elements_text(candidate_values)::int) FROM contact_profile_migration_conflicts WHERE account_id=$1 AND contact_id=$2 AND field_name='age'`, account, conflict).Scan(&evidence); err != nil || !reflect.DeepEqual(evidence, []int{20, 21}) {
			t.Fatalf("legacy conflict evidence was not retained: %v", err)
		}
		var foreignName string
		if err := db.QueryRow(ctx, `SELECT name FROM event_participants WHERE id=$1`, foreignParticipant).Scan(&foreignName); err != nil || foreignName != "Foreign name" {
			t.Fatalf("foreign-account snapshot was changed: %v", err)
		}
		// Canonical clearing remains authoritative even if an old writer leaves
		// a later stale snapshot. Rebuilding the trigger must not replay DML.
		exec(t, `UPDATE contacts SET custom_name=NULL,email=NULL WHERE account_id=$1 AND id=$2`, account, legacy)
		exec(t, `UPDATE event_participants SET name='Stale after clear',email='stale@example.test' WHERE id=$1`, legacyParticipant)
		exec(t, `DROP TRIGGER trg_contacts_sync_identity_snapshots ON contacts`)
		beforeRestart := snapshot(t)
		for pass := 0; pass < 2; pass++ {
			migrate(t)
			assertPreserved(t, beforeRestart)
		}
		var installed bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='contacts'::regclass AND tgname='trg_contacts_sync_identity_snapshots' AND NOT tgisinternal)`).Scan(&installed); err != nil || !installed {
			t.Fatalf("runtime canonical trigger was not maintained: %v", err)
		}
	})
}
