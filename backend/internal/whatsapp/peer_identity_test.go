package whatsapp

import (
	"context"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/appstate"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waSyncAction"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"testing"
	"time"
)

func TestPeerHistoryReadsNamesAndHandlesWithoutInventingPhones(t *testing.T) {
	lid, pn, name, handle := "7001@lid", "51900000001@s.whatsapp.net", "Observed name", "profile.12"
	deleted := true
	data := &waHistorySync.HistorySync{InlineContacts: []*waHistorySync.InlineContact{{LidJID: &lid, FullName: &name, Username: &handle}}, Accounts: []*waHistorySync.Account{{Lid: &lid, IsUsernameDeleted: &deleted}}}
	rows := peerHistoryObservations(data)
	if len(rows) != 2 || rows[0].LID != lid || rows[0].PN != "" || rows[0].Fields["full_name"] != name || rows[0].Fields["username"] != handle || rows[0].ObservedAt != nil {
		t.Fatalf("incorrect delivered identity: %+v", rows)
	}
	if v, ok := rows[1].Fields["username"]; !ok || v != "" || rows[1].Source != "history_account_deleted" {
		t.Fatal("explicit username deletion lost")
	}
	data.InlineContacts[0].PnJID = &pn
	rows = peerHistoryObservations(data)
	if rows[0].PN != pn || rows[0].JID != lid {
		t.Fatal("verified pair not preserved")
	}
	data.InlineContacts[0].Username = nil
	data.Accounts = nil
	rows = peerHistoryObservations(data)
	if _, ok := rows[0].Fields["username"]; ok {
		t.Fatal("missing username was interpreted as deletion")
	}
}
func TestPeerAppStateReadsActualLIDAction(t *testing.T) {
	name, handle := "LID saved name", "new.profile"
	at := time.Now().UnixMilli()
	evt := &events.AppState{Index: []string{appstate.IndexLIDContact, "7001@lid"}, SyncActionValue: &waSyncAction.SyncActionValue{Timestamp: &at, LidContactAction: &waSyncAction.LidContactAction{FullName: &name, Username: &handle}}}
	rows := peerAppStateObservations(evt)
	if len(rows) != 1 || rows[0].PN != "" || rows[0].Fields["username"] != handle || rows[0].Source != "lid_contact_action" {
		t.Fatalf("LID action not exposed: %+v", rows)
	}
	evt.Index[0] = "unrelated"
	if len(peerAppStateObservations(evt)) != 0 {
		t.Fatal("unrelated action became identity")
	}
}
func TestDurablePeerResolvesOfflineAndKeepsDeletedNamesDeleted(t *testing.T) {
	lid, pn := "7001@lid", "51900000001@s.whatsapp.net"
	at := time.Now().UTC()
	snap := &domain.WhatsAppPeerIdentitySnapshot{Fields: map[string]map[string]domain.WhatsAppIdentityField{lid: {"full_name": {Value: "New identity", Source: "contact_action", ObservedAt: &at}, "username": {Value: "alias.12", Source: "contact_action", ObservedAt: &at}}}, PNForLID: map[string]string{}, LIDForPN: map[string]string{}}
	got := projectDurablePeer(context.Background(), nil, domain.GroupParticipant{JID: lid, Name: "Old projection"}, nil, snap)
	if got.Name != "New identity" || got.Phone != "" || got.Username != "alias.12" {
		t.Fatalf("durable LID identity unavailable: %+v", got)
	}
	snap.PNForLID[lid] = pn
	snap.LIDForPN[pn] = lid
	got = projectDurablePeer(context.Background(), nil, domain.GroupParticipant{JID: pn, Phone: "51900000001"}, nil, snap)
	if got.Name != "New identity" || got.LID != lid {
		t.Fatalf("verified reverse alias ignored: %+v", got)
	}
	snap.Fields[lid]["full_name"] = domain.WhatsAppIdentityField{Value: "", Source: "contact_action", ObservedAt: &at}
	snap.Fields[lid]["username"] = domain.WhatsAppIdentityField{Value: "", Source: "contact_action", ObservedAt: &at}
	cache := map[types.JID]types.ContactInfo{types.NewJID("7001", types.HiddenUserServer): {FullName: "Stale provider name"}, types.NewJID("51900000001", types.DefaultUserServer): {FullName: "Stale PN alias"}}
	got = projectDurablePeer(context.Background(), nil, domain.GroupParticipant{JID: lid, Name: "Old projection", LID: lid}, cache, snap)
	if got.Name == "Old projection" || got.Name == "Stale provider name" || got.Name == "Stale PN alias" || got.Username != "" {
		t.Fatalf("tombstone revived an old identity: %+v", got)
	}
}

func TestPeerStableLIDWinsOverReassignedPhone(t *testing.T) {
	a := domain.GroupParticipant{JID: "51900000001@s.whatsapp.net", LID: "7001@lid", Phone: "51900000001"}
	b := domain.GroupParticipant{JID: a.JID, LID: "7002@lid", Phone: a.Phone}
	if memberIdentityAliasesIntersect(a, b) {
		t.Fatal("reused phone crossed two verified stable LIDs")
	}
	snap := &domain.WhatsAppPeerIdentitySnapshot{Fields: map[string]map[string]domain.WhatsAppIdentityField{}, LIDForPN: map[string]string{a.JID: b.LID}, PNForLID: map[string]string{b.LID: a.JID}}
	got := projectDurablePeer(context.Background(), nil, a, nil, snap)
	if got.Phone != "" || got.JID != a.LID || got.LID != a.LID {
		t.Fatalf("old member borrowed the new owner's phone: %+v", got)
	}
}

func TestPeerHistoryReadsOnlyDeliveredPhoneMappings(t *testing.T) {
	pn, lid := "51900000001@s.whatsapp.net", "7001@lid"
	rows := peerHistoryObservations(&waHistorySync.HistorySync{PhoneNumberToLidMappings: []*waHistorySync.PhoneNumberToLIDMapping{nil, {PnJID: &pn, LidJID: &lid}}})
	if len(rows) != 1 || rows[0].PN != pn || rows[0].LID != lid || rows[0].Source != "history_contact" || rows[0].ObservedAt != nil || len(rows[0].Fields) != 0 {
		t.Fatalf("history mapping was inferred or omitted: %+v", rows)
	}
	if len(peerHistoryObservations(&waHistorySync.HistorySync{})) != 0 {
		t.Fatal("empty device history imported another session's mappings")
	}
	rows = peerHistoryObservations(&waHistorySync.HistorySync{Conversations: []*waHistorySync.Conversation{{ID: &lid, PnJID: &pn}}})
	if len(rows) != 1 || rows[0].PN != pn || rows[0].LID != lid || len(rows[0].Fields) != 0 {
		t.Fatalf("delivered conversation pair required a username: %+v", rows)
	}

}

func TestPeerPhoneReassignmentTombstoneIsAliasLocal(t *testing.T) {
	lid, pn := "7002@lid", "51900000001@s.whatsapp.net"
	older := time.Now().UTC().Add(-time.Hour)
	later := older.Add(time.Minute)
	for _, dated := range []bool{false, true} {
		var at *time.Time
		if dated {
			at = &older
		}
		snap := &domain.WhatsAppPeerIdentitySnapshot{
			PNForLID: map[string]string{lid: pn}, LIDForPN: map[string]string{pn: lid},
			Fields: map[string]map[string]domain.WhatsAppIdentityField{
				lid: {"full_name": {Value: "Current stable identity", Source: "contact_action", ObservedAt: at}, "username": {Value: "current.handle", Source: "contact_action", ObservedAt: at}},
				pn:  {"full_name": {Value: "", Source: "alias_reassigned", ObservedAt: &later}, "push_name": {Value: "", Source: "alias_reassigned", ObservedAt: &later}, "username": {Value: "", Source: "alias_reassigned", ObservedAt: &later}},
			},
		}
		cache := map[types.JID]types.ContactInfo{types.NewJID("51900000001", types.DefaultUserServer): {FullName: "Previous phone owner", PushName: "Previous push name"}}
		got := projectDurablePeer(context.Background(), nil, domain.GroupParticipant{JID: pn, Name: "Previous phone owner"}, cache, snap)
		if got.Name != "Current stable identity" || got.Username != "current.handle" || got.LID != lid || got.IdentityFields["full_name"].Source != "contact_action" {
			t.Fatalf("alias-local invalidation erased stable LID facts (dated=%v): %+v", dated, got)
		}
		delete(snap.Fields, lid)
		got = projectDurablePeer(context.Background(), nil, domain.GroupParticipant{JID: pn, Name: "Previous phone owner"}, cache, snap)
		if got.Name != "51900000001" || got.NameSource != "phone" || got.Username != "" {
			t.Fatalf("alias invalidation resurrected old cached identity: %+v", got)
		}
	}
}

func TestPeerNameEventsNeverIntroduceProviderGlobalAlternates(t *testing.T) {
	pn, lid := types.NewJID("51900000001", types.DefaultUserServer), types.NewJID("7001", types.HiddenUserServer)
	for _, jid := range []types.JID{pn, lid} {
		alt := pn
		if jid == pn {
			alt = lid
		}
		info := &types.MessageInfo{MessageSource: types.MessageSource{Sender: jid, SenderAlt: alt}, Timestamp: time.Now().UTC()}
		push := peerPushNameObservation(&events.PushName{JID: jid, JIDAlt: alt, Message: info, NewPushName: "Original JID name"})
		business := peerBusinessNameObservation(&events.BusinessName{JID: jid, Message: info, NewBusinessName: "Original JID business"})
		for _, rows := range [][]domain.WhatsAppPeerObservation{push, business} {
			if len(rows) != 1 || rows[0].JID != jid.String() || (rows[0].PN != "" && rows[0].LID != "") {
				t.Fatalf("name event introduced global pair: %+v", rows)
			}
		}
	}
}
