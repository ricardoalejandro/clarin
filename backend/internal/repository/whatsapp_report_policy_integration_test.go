package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhatsAppCoveragePolicyIntegrationContactsSurviveWithoutCommercialData(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	account, contact := leadPolicyFixture(t, pool)
	other, otherContact := leadPolicyFixture(t, pool)
	reports, accounts := &ReportRepository{db: pool}, &AccountRepository{db: pool}
	for _, ids := range [][2]uuid.UUID{{account, contact}, {other, otherContact}} {
		integrityExec(t, pool, `INSERT INTO leads(id,account_id,contact_id,jid,status,title) VALUES($1,$2,$3,$5,'open','Synthetic active'),($4,$2,$3,$5,'won','Synthetic historical')`, uuid.New(), ids[0], ids[1], uuid.New(), ids[1].String()+"@test.invalid")
	}
	tag := uuid.New()
	integrityExec(t, pool, `INSERT INTO tags(id,account_id,name,color) VALUES($1,$2,'Synthetic contact tag','#64748b')`, tag, account)
	integrityExec(t, pool, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2)`, contact, tag)
	integrityExec(t, pool, `UPDATE contacts SET do_not_contact=TRUE WHERE id=$1`, contact)
	contacts, err := reports.GetWhatsAppReportContacts(ctx, account, []uuid.UUID{contact, otherContact})
	if err != nil || len(contacts) != 1 || contacts[contact] == nil {
		t.Fatalf("account contacts: %+v %v", contacts, err)
	}
	if len(contacts[contact].ActiveLeads) != 1 || contacts[contact].HistoricalLeadCount != 1 {
		t.Fatalf("enabled commercial context: %+v", contacts[contact])
	}
	if _, err = accounts.UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); err != nil {
		t.Fatal(err)
	}
	contacts, err = reports.GetWhatsAppReportContacts(ctx, account, []uuid.UUID{contact, otherContact})
	if err != nil || len(contacts) != 1 || contacts[contact] == nil {
		t.Fatalf("disabled contact: %+v %v", contacts, err)
	}
	got := contacts[contact]
	if len(got.ActiveLeads) != 0 || got.HistoricalLeadCount != 0 || len(got.Tags) != 1 || !got.DoNotContact || got.DisplayName != "Synthetic contact" {
		t.Fatalf("contact identity/context corrupted: %+v", got)
	}
	otherContacts, err := reports.GetWhatsAppReportContacts(ctx, other, []uuid.UUID{otherContact, contact})
	if err != nil || len(otherContacts) != 1 || len(otherContacts[otherContact].ActiveLeads) != 1 || otherContacts[otherContact].HistoricalLeadCount != 1 {
		t.Fatalf("other account affected: %+v %v", otherContacts, err)
	}
	stale := &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsEnabled: true, LeadsPolicyVersion: 1}
	if release, err := reports.AcquireWhatsAppCoveragePublication(ctx, account, stale); !errors.Is(err, ErrLeadPolicyConflict) {
		if release != nil {
			release()
		}
		t.Fatalf("stale report published: %v", err)
	}
	current := &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsPolicyVersion: 2}
	release, err := reports.AcquireWhatsAppCoveragePublication(ctx, account, current)
	if err != nil {
		t.Fatalf("independent report blocked: %v", err)
	}
	release()
	var count int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM leads WHERE account_id=$1`, account, &count)
	if count != 2 {
		t.Fatalf("historical leads changed: %d", count)
	}
}
