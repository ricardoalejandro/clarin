package repository

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhatsAppGroupReportPostgresPhoneMatchNeverUsesLIDDigits(t *testing.T) {
	db := programSurveyIntegrityPool(t)
	ctx := context.Background()
	f := integrityProgram(t, db)
	foreign := integrityProgram(t, db)
	lidOnly, legacyPN, canonicalPN, explicitPhone, usernameOnly := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, row := range []struct {
		id    uuid.UUID
		jid   string
		phone *string
	}{
		{lidOnly, "51980000001@lid", nil},
		{legacyPN, "980000002@c.us", nil},
		{canonicalPN, "51980000003@s.whatsapp.net", nil},
		{explicitPhone, "700004@lid", reportIdentityTestPhone("+51 980 000 004")},
		{usernameOnly, "51980000005@example.test", nil},
	} {
		integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,phone,name) VALUES($1,$2,$3,$4,'Synthetic same display name')`, row.id, f.account, row.jid, row.phone)
	}
	integrityExec(t, db, `INSERT INTO contacts(id,account_id,jid,phone,name) VALUES($1,$2,'51980000006@s.whatsapp.net','51980000006','Synthetic foreign identity')`, uuid.New(), foreign.account)
	identities := []domain.WhatsAppGroupReportIdentity{
		{Ordinal: 1, Phone: reportIdentityTestPhone("51980000001"), PhoneJID: "51980000001@s.whatsapp.net", LID: "800001@lid"},
		{Ordinal: 2, Phone: reportIdentityTestPhone("51980000002")},
		{Ordinal: 3, Phone: reportIdentityTestPhone("51980000003")},
		{Ordinal: 4, Phone: reportIdentityTestPhone("51980000004")},
		{Ordinal: 5, Phone: reportIdentityTestPhone("51980000005"), WhatsAppName: "Synthetic same display name", Username: "51980000005"},
		{Ordinal: 6, Phone: reportIdentityTestPhone("51980000006")},
		{Ordinal: 7, LID: "51980000001@lid"},
	}
	matches, err := NewRepositories(db).Report.MatchWhatsAppGroupMembers(ctx, f.account, identities)
	if err != nil {
		t.Fatal(err)
	}
	for _, ordinal := range []int{1, 5, 6} {
		if len(matches[ordinal]) != 0 {
			t.Fatalf("unproven digits, display identity or foreign account matched ordinal %d", ordinal)
		}
	}
	for ordinal, expected := range map[int]uuid.UUID{2: legacyPN, 3: canonicalPN, 4: explicitPhone, 7: lidOnly} {
		if len(matches[ordinal]) != 1 || matches[ordinal][0] != expected {
			t.Fatalf("proven identity no longer matches ordinal %d: %v", ordinal, matches[ordinal])
		}
	}
}

func reportIdentityTestPhone(value string) *string { return &value }
