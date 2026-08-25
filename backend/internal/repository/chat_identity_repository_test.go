package repository

import (
	"os"
	"strings"
	"testing"
)

func TestValidateChatIdentityPair(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		lid      string
		phone    string
		wantFail bool
	}{
		{name: "valid", lid: "65657383165996@lid", phone: "51904806007@s.whatsapp.net"},
		{name: "source must be lid", lid: "51904806007@s.whatsapp.net", phone: "51904806007@s.whatsapp.net", wantFail: true},
		{name: "target must be phone jid", lid: "65657383165996@lid", phone: "65657383165996@lid", wantFail: true},
		{name: "empty", lid: "", phone: "", wantFail: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateChatIdentityPair(test.lid, test.phone)
			if (err != nil) != test.wantFail {
				t.Fatalf("validateChatIdentityPair() error = %v, wantFail=%v", err, test.wantFail)
			}
		})
	}
}

func TestPhoneFromJIDNeverTreatsLIDAsPhone(t *testing.T) {
	t.Parallel()
	if got := phoneFromJID("65657383165996@lid"); got != "" {
		t.Fatalf("phoneFromJID(LID) = %q, want empty", got)
	}
	if got := phoneFromJID("51904806007:12@s.whatsapp.net"); got != "51904806007" {
		t.Fatalf("phoneFromJID(PN) = %q, want canonical digits", got)
	}
}

func TestMappedLIDContactScanKeepsCanonicalJoinAccountScoped(t *testing.T) {
	t.Parallel()
	source, err := os.ReadFile("chat_identity_repository.go")
	if err != nil {
		t.Fatalf("read repository source: %v", err)
	}
	query := string(source)
	for _, invariant := range []string{
		"phone_contact.account_id=lid_contact.account_id",
		"LOWER(phone_contact.jid)=LOWER(mapping.pn || '@s.whatsapp.net')",
		"WHERE lid_contact.id<>phone_contact.id",
	} {
		if !strings.Contains(query, invariant) {
			t.Fatalf("mapped LID contact scan lost invariant %q", invariant)
		}
	}
}
