package repository

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestManualContactAtomicMetadataAndTagPermissions(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	account := uuid.New()
	integrityExec(t, db, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic contact integrity')`, account)
	t.Cleanup(func() { integrityExec(t, db, `DELETE FROM accounts WHERE id=$1`, account) })
	r := NewContactProfileRepository(db)
	name := "Manual name"
	phone := "51999777111"
	jid := phone + "@s.whatsapp.net"
	patch := ContactProfilePatch{NameSet: true, Name: &name, CustomNameSet: true, CustomName: &name, PhoneSet: true, Phone: &phone, TagIDsSet: true}
	_, err := r.CreateManual(ctx, account, jid, phone, patch, []string{"forbidden-new-tag"}, false)
	if !errors.Is(err, ErrGlobalTagCreationForbidden) {
		t.Fatalf("missing tag permission: %v", err)
	}
	var contacts, tags int
	if err = db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM contacts WHERE account_id=$1),(SELECT COUNT(*) FROM tags WHERE account_id=$1)`, account).Scan(&contacts, &tags); err != nil {
		t.Fatal(err)
	}
	if contacts != 0 || tags != 0 {
		t.Fatal("failed request left partial identity or catalog tag")
	}
	oversized := strings.Repeat("x", 256)
	bad := patch
	bad.EmailSet = true
	bad.Email = &oversized
	if _, err = r.CreateManual(ctx, account, jid, phone, bad, []string{"rolled-back"}, true); err == nil {
		t.Fatal("invalid metadata accepted")
	}
	if err = db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM contacts WHERE account_id=$1),(SELECT COUNT(*) FROM tags WHERE account_id=$1)`, account).Scan(&contacts, &tags); err != nil {
		t.Fatal(err)
	}
	if contacts != 0 || tags != 0 {
		t.Fatal("metadata failure left partial identity or tag")
	}
	integrityExec(t, db, `INSERT INTO tags(account_id,name,color) VALUES($1,'existing','#fff')`, account)
	contact, err := r.CreateManual(ctx, account, jid, phone, patch, []string{"existing"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if contact.CustomName == nil || *contact.CustomName != name || len(contact.StructuredTags) != 1 {
		t.Fatal("canonical response missing metadata/tags")
	}
	updated := "New name"
	update := ContactProfilePatch{CustomNameSet: true, CustomName: &updated, TagIDsSet: true}
	if _, err = r.UpdateWithTagNames(ctx, account, contact.ID, update, []string{"existing", "unauthorized"}, false); !errors.Is(err, ErrGlobalTagCreationForbidden) {
		t.Fatalf("compat mutation allowed new tag: %v", err)
	}
	persisted, err := r.Get(ctx, account, contact.ID)
	if err != nil {
		t.Fatal(err)
	}
	if *persisted.CustomName != name {
		t.Fatal("failed tag mutation partially updated profile")
	}
}

func TestContactNameSortingUsesVisibleIdentity(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	account := uuid.New()
	integrityExec(t, db, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic sort integrity')`, account)
	t.Cleanup(func() { integrityExec(t, db, `DELETE FROM accounts WHERE id=$1`, account) })
	a, b := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,name,custom_name,push_name) VALUES($1,$2,$3,'Fallback','Zulu','Alpha'),($4,$2,$5,'Bravo',NULL,'Zulu')`, a, account, a.String()+"@test.invalid", b, b.String()+"@test.invalid")
	r := NewRepositories(db).Contact
	rows, _, err := r.GetByAccountIDWithFilters(ctx, account, domain.ContactFilter{SortBy: "name", Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 || rows[0].ID != b || rows[1].ID != a {
		t.Fatal("sort does not match displayed contact identity")
	}
}
