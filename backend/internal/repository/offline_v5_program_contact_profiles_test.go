package repository

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
)

// The helper runs in the same account-scoped snapshot transaction as preparation.
// This test intentionally creates foreign links to prove child joins do not trust IDs alone.
func TestOfflineV5IntegrationProgramContactProfilesUseExactRosterAndCanonicalIdentity(t *testing.T) {
	pool := offlineV5IntegrationPool(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	account, otherAccount, program, otherProgram, contact, unrelated, foreign, tag, foreignTag, field := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Offline profile account'),($2,'Foreign profile account')`, account, otherAccount)
	exec(`INSERT INTO programs(id,account_id,name,type) VALUES($1,$2,'Prepared group','course'),($3,$4,'Foreign group','course')`, program, account, otherProgram, otherAccount)
	exec(`INSERT INTO contacts(id,account_id,jid,name,distrito,ocupacion) VALUES($1,$2,$3,'Álvaro','Ñaña','Docente'),($4,$2,$5,'Unrelated',NULL,NULL),($6,$7,$8,'Foreign',NULL,NULL)`, contact, account, contact.String()+"@test.invalid", unrelated, unrelated.String()+"@test.invalid", foreign, otherAccount, foreign.String()+"@test.invalid")
	exec(`INSERT INTO program_participants(program_id,contact_id,status,enrolled_at) VALUES($1,$2,'active','2026-10-01'),($3,$4,'active','2026-10-01')`, program, contact, otherProgram, foreign)
	exec(`INSERT INTO contact_phones(contact_id,phone,label) VALUES($1,'00001','mobile'),($2,'00002','mobile')`, contact, foreign)
	exec(`INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Prepared tag','#123456'),($3,$4,'Foreign tag','#654321')`, tag, account, foreignTag, otherAccount)
	exec(`INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2),($1,$3)`, contact, tag, foreignTag)
	exec(`INSERT INTO custom_field_definitions(id,account_id,name,slug,field_type) VALUES($1,$2,'Consent','consent','checkbox')`, field, account)
	exec(`INSERT INTO custom_field_values(field_id,contact_id,value_bool) VALUES($1,$2,FALSE)`, field, contact)
	profiles, err := offlineV5ProgramContactProfiles(ctx, tx, account, program)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 {
		t.Fatalf("expected exact roster identity, got %d", len(profiles))
	}
	identity := profiles[0]["contact"].(map[string]any)
	if identity["id"] != contact.String() || identity["distrito"] != "Ñaña" || identity["ocupacion"] != "Docente" {
		t.Fatalf("canonical identity: %#v", identity)
	}
	if len(profiles[0]["phones"].([]any)) != 1 || len(profiles[0]["tags"].([]any)) != 1 {
		t.Fatal("expected only account-bound children")
	}
	values := profiles[0]["custom_fields"].([]any)
	if len(values) != 1 || values[0].(map[string]any)["value_bool"] != false || values[0].(map[string]any)["field_id"] != field.String() {
		t.Fatalf("canonical values: %#v", values)
	}
	encoded, err := json.Marshal(profiles)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"Foreign", "Unrelated", "device_id", "google_id", "avatar_url"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("unexpected dependency data %q", forbidden)
		}
	}
	foreignProfiles, err := offlineV5ProgramContactProfiles(ctx, tx, account, otherProgram)
	if err != nil {
		t.Fatal(err)
	}
	if len(foreignProfiles) != 0 {
		t.Fatal("foreign Program must not expose identities")
	}
}
