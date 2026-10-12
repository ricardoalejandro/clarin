package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestManualLeadTagsAreAtomicAdditiveAndAccountScoped(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	account, other := uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO accounts(id,name) VALUES($1,'Lead tags QA'),($2,'Other QA')`, account, other)
	t.Cleanup(func() {
		integrityExec(t, db, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, other})
	})
	repos := NewRepositories(db)
	contactID, prior, added, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	phone := "51999777121"
	jid := phone + "@s.whatsapp.net"
	integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,phone,name,notes,source) VALUES($1,$2,$3,$4,'Prior','Keep canonical notes','whatsapp')`, contactID, account, jid, phone)
	integrityExec(t, db, `INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Prior','#123456'),($3,$2,'Added','#123456'),($4,$5,'Foreign','#123456')`, prior, account, added, foreign, other)
	integrityExec(t, db, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)`, contactID, prior)
	ids := []uuid.UUID{added, added}
	name := "Updated"
	lead := &domain.Lead{AccountID: account, JID: jid, Name: &name}
	contact, err := repos.Lead.CreateManualWithTags(ctx, lead, phone, &ids, []string{"Must not create"}, false)
	if err != nil {
		t.Fatal(err)
	}
	if contact.ID != contactID || len(contact.StructuredTags) != 2 || len(lead.StructuredTags) != 2 {
		t.Fatal("additive canonical tags missing")
	}
	if contact.Notes == nil || *contact.Notes != "Keep canonical notes" {
		t.Fatal("omitted notes replaced canonical Contact notes")
	}
	if contact.Source == nil || *contact.Source != "whatsapp" {
		t.Fatal("creating opportunity replaced existing Contact provenance")
	}
	var names int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM tags WHERE account_id=$1`, account).Scan(&names); err != nil {
		t.Fatal(err)
	}
	if names != 2 {
		t.Fatal("ignored legacy names created a tag")
	}
	var linked uuid.UUID
	if err = db.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id=$1`, lead.ID).Scan(&linked); err != nil || linked != contactID {
		t.Fatal("lead contact mismatch")
	}
	empty := []uuid.UUID{}
	next := &domain.Lead{AccountID: account, JID: "manual_" + uuid.NewString() + "@clarin.lead"}
	emptyContact := uuid.New()
	integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Keeps tags')`, emptyContact, account, next.JID)
	integrityExec(t, db, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)`, emptyContact, prior)
	kept, err := repos.Lead.CreateManualWithTags(ctx, next, "", &empty, nil, false)
	if err != nil || kept.ID != emptyContact || len(kept.StructuredTags) != 1 {
		t.Fatalf("empty additions cleared prior tags: %v", err)
	}
	if next.Name == nil || *next.Name != "Keeps tags" {
		t.Fatal("response omitted canonical Contact display name")
	}
	legacy := &domain.Lead{AccountID: account, JID: "manual_" + uuid.NewString() + "@clarin.lead", Name: &name}
	if contact, err := repos.Lead.CreateManualWithTags(ctx, legacy, "", nil, []string{"Added"}, false); err != nil || len(contact.StructuredTags) != 1 {
		t.Fatalf("existing legacy tag required creation permission: %v", err)
	}
	forbidden := &domain.Lead{AccountID: account, JID: "manual_" + uuid.NewString() + "@clarin.lead", Name: &name}
	if _, err = repos.Lead.CreateManualWithTags(ctx, forbidden, "", nil, []string{"Unauthorized global"}, false); !errors.Is(err, ErrGlobalTagCreationForbidden) {
		t.Fatalf("missing create permission: %v", err)
	}
	badIDs := []uuid.UUID{foreign}
	bad := &domain.Lead{AccountID: account, JID: "manual_" + uuid.NewString() + "@clarin.lead", Name: &name}
	if _, err = repos.Lead.CreateManualWithTags(ctx, bad, "", &badIDs, nil, false); !errors.Is(err, ErrContactProfileCollectionInvalid) {
		t.Fatalf("foreign tag accepted: %v", err)
	}
	var leftovers int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contacts WHERE account_id=$1 AND jid=ANY($2::text[])`, account, []string{forbidden.JID, bad.JID}).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatal("failed request left Contact")
	}
	stage := uuid.New()
	broken := &domain.Lead{AccountID: account, JID: "manual_" + uuid.NewString() + "@clarin.lead", Name: &name, StageID: &stage}
	if _, err = repos.Lead.CreateManualWithTags(ctx, broken, "", nil, []string{"Rollback catalog"}, true); err == nil {
		t.Fatal("invalid lead stage accepted")
	}
	if err := db.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM contacts WHERE account_id=$1 AND jid=$2)+(SELECT COUNT(*) FROM tags WHERE account_id=$1 AND name='Rollback catalog')`, account, broken.JID).Scan(&leftovers); err != nil {
		t.Fatal(err)
	}
	if leftovers != 0 {
		t.Fatal("failed Lead insert left Contact/tag")
	}
	if _, err = repos.Lead.CreateManualWithTags(ctx, lead, phone, &ids, nil, false); !errors.Is(err, ErrManualLeadDuplicate) {
		t.Fatal("duplicate creation accepted")
	}
}

func TestAutomationTagMutationBindsExecutionAccountAndRejectsRemovedTags(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	account, other := uuid.New(), uuid.New()
	contact, leadID, tag, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	integrityExec(t, db, `INSERT INTO accounts(id,name) VALUES($1,'Automation tags QA'),($2,'Other')`, account, other)
	t.Cleanup(func() {
		integrityExec(t, db, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, other})
	})
	integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic')`, contact, account, contact.String()+"@test.invalid")
	integrityExec(t, db, `INSERT INTO leads(id,account_id,contact_id,jid,title) VALUES($1,$2,$3,$4,'Synthetic')`, leadID, account, contact, leadID.String()+"@test.invalid")
	integrityExec(t, db, `INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Own','#123456'),($3,$4,'Foreign','#123456')`, tag, account, foreign, other)
	repo := NewRepositories(db).Tag
	for _, item := range []struct{ account, lead, tag uuid.UUID }{{other, leadID, tag}, {account, leadID, foreign}, {account, leadID, uuid.New()}} {
		if _, err := repo.MutateLeadTagForAccount(ctx, item.account, item.lead, item.tag, true); err == nil {
			t.Fatal("invalid scoped action accepted")
		}
	}
	for _, assign := range []bool{true, true, false, false} {
		id, err := repo.MutateLeadTagForAccount(ctx, account, leadID, tag, assign)
		if err != nil || id == nil || *id != contact {
			t.Fatalf("idempotent action: %v", err)
		}
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contact_tags WHERE contact_id=$1`, contact).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatal("remove did not persist")
	}
	integrityExec(t, db, `DELETE FROM tags WHERE id=$1`, tag)
	if _, err := repo.MutateLeadTagForAccount(ctx, account, leadID, tag, true); err == nil {
		t.Fatal("deleted catalog tag reported success")
	}
}
