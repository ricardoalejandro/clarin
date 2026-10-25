package domain

import (
	"bytes"
	"testing"
	"time"
)

func TestGroupIdentityVersionMaterialIsStableAndMaterial(t *testing.T) {
	group := &ChatGroup{Kind: "group", MembershipStatus: "member"}
	members := []GroupParticipant{{JID: "51900000002@s.whatsapp.net", LID: "702@lid", Phone: "51900000002", Role: "admin", Name: "A"}, {JID: "701@lid", Role: "member", Name: "B"}}
	baseline := WhatsAppGroupIdentityVersionMaterial(group, members)
	members[0].Name = "Changed"
	members[0].NameSource = "push_name"
	members[0].AvatarURL = "/temporary"
	members[0], members[1] = members[1], members[0]
	if !bytes.Equal(baseline, WhatsAppGroupIdentityVersionMaterial(group, members)) {
		t.Fatal("presentation/order changed material revision")
	}
	members[0].Role = "admin"
	if bytes.Equal(baseline, WhatsAppGroupIdentityVersionMaterial(group, members)) {
		t.Fatal("role not included")
	}
}
func TestIdentityRecoveryRetryBudget(t *testing.T) {
	for attempt, want := range map[int]time.Duration{1: 30 * time.Second, 2: 2 * time.Minute, 3: 10 * time.Minute, 4: 10 * time.Minute} {
		if got := WhatsAppIdentityRecoveryRetryDelay(attempt); got != want {
			t.Fatal(attempt, got, want)
		}
	}
	previous := WhatsAppIdentityField{Value: "First", Source: "provider_cache"}
	for _, next := range []WhatsAppIdentityField{{Value: "Different", Source: "contact_action"}, {Value: "", Source: "history_account_deleted"}} {
		if WhatsAppIdentityFieldNewer(next, previous) {
			t.Fatal("undated snapshot overwrote known field")
		}
	}
}
