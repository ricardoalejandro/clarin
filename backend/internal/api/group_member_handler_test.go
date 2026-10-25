package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestGroupMemberFingerprintBindsIdentityButNotPresentation(t *testing.T) {
	a, d, g, c := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	member := domain.GroupParticipant{JID: "51900000001@s.whatsapp.net", LID: "7001@lid", Phone: "51900000001", Name: "Initial", Role: "member"}
	base := groupMemberFingerprint("test-secret", a, d, g, member, &c)
	presentation := member
	presentation.Name = "New name"
	presentation.Role = "admin"
	presentation.AvatarURL = "/new-photo"
	if groupMemberFingerprint("test-secret", a, d, g, presentation, &c) != base {
		t.Fatal("innocent update invalidated identity")
	}
	for _, tc := range []struct {
		a, d, g uuid.UUID
		m       domain.GroupParticipant
		contact *uuid.UUID
	}{{uuid.New(), d, g, member, &c}, {a, uuid.New(), g, member, &c}, {a, d, uuid.New(), member, &c}, {a, d, g, member, nil}} {
		if groupMemberFingerprint("test-secret", tc.a, tc.d, tc.g, tc.m, tc.contact) == base {
			t.Fatal("identity scope was not bound")
		}
	}
	changed := member
	changed.Phone = "51900000002"
	if groupMemberFingerprint("test-secret", a, d, g, changed, &c) == base {
		t.Fatal("phone change accepted")
	}
}

func TestGroupMemberCapabilitiesNeverInventAnAction(t *testing.T) {
	member := domain.GroupParticipant{Phone: "51900000001", Role: "member"}
	if !groupMemberCapabilities(member, true).CanMessage {
		t.Fatal("ordinary member could not open private chat")
	}
	for _, tc := range []struct {
		m         domain.GroupParticipant
		connected bool
	}{{member, false}, {domain.GroupParticipant{JID: "7001@lid"}, true}, {domain.GroupParticipant{Phone: member.Phone, IsSelf: true}, true}} {
		caps := groupMemberCapabilities(tc.m, tc.connected)
		if caps.CanMessage || caps.MessageDisabledReason == "" {
			t.Fatalf("unsupported action: %+v", caps)
		}
	}
}

func TestGroupMemberContactProjectionRequiresAuthorizedContext(t *testing.T) {
	for _, permission := range []string{domain.PermChats, domain.PermLeads} {
		if groupActorCanReadContacts(&service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{permission}}) {
			t.Fatal("parallel module enabled Contact projection")
		}
	}
	if !groupActorCanReadContacts(&service.JWTClaims{Role: domain.RoleAgent, Permissions: []string{domain.PermContacts}}) {
		t.Fatal("Contacts permission ignored")
	}
	member := domain.GroupParticipant{Name: "WhatsApp identity", AvatarSource: "whatsapp", AvatarURL: "/temporary"}
	if got := projectGroupMemberContact(member, nil); got != member {
		t.Fatal("unknown Contact changed visible identity")
	}
	got := projectGroupMemberContact(member, &repository.GroupMemberContact{Name: "Canonical Contact"})
	if got.Name != "Canonical Contact" || got.AvatarSource != "contact" || got.AvatarURL != "" {
		t.Fatalf("canonical empty avatar replaced by WA photo: %+v", got)
	}
}

func TestGroupMemberReferenceAcceptsEncodedUserJIDsOnly(t *testing.T) {
	if got, err := groupMemberReference("7001%40lid"); err != nil || got != "7001@lid" {
		t.Fatalf("encoded alias rejected: %q %v", got, err)
	}
	for _, raw := range []string{"12001@g.us", "https://example.invalid/avatar", "%zz", "invalid"} {
		if _, err := groupMemberReference(raw); err == nil {
			t.Fatalf("unsupported member reference accepted: %s", raw)
		}
	}
}

func TestGroupMemberSearchUsesVisibleResolvedIdentity(t *testing.T) {
	member := domain.GroupParticipant{JID: "7001@lid", Name: "Saved LID identity", WhatsAppName: "Saved LID identity", Phone: "51900000001", RedactedPhone: "+51····01"}
	for _, query := range []string{"saved lid", "51900000001", "+51··", "  SAVED  "} {
		if got := groupParticipantsMatchingSearch([]domain.GroupParticipant{member}, query); len(got) != 1 || got[0] != member.JID {
			t.Fatalf("resolved identity not searchable with %q: %+v", query, got)
		}
	}
	if len(groupParticipantsMatchingSearch([]domain.GroupParticipant{member}, "Private CRM name")) != 0 {
		t.Fatal("search inferred a hidden CRM identity")
	}
	visible := projectGroupMemberContact(member, &repository.GroupMemberContact{Name: "Private CRM name"})
	if len(groupParticipantsMatchingSearch([]domain.GroupParticipant{visible}, "private crm")) != 1 {
		t.Fatal("authorized canonical name was not searchable")
	}
	if len(groupParticipantsMatchingSearch([]domain.GroupParticipant{visible}, "missing")) != 0 {
		t.Fatal("empty search result restored an unrelated row")
	}
}
