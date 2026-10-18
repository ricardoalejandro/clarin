package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

func TestWhatsAppCheckResultPreservesProvenPhoneIdentity(t *testing.T) {
	t.Parallel()
	phone := types.NewJID("51987654321", types.DefaultUserServer)
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	for _, test := range []struct {
		name     string
		result   types.IsOnWhatsAppResponse
		mapped   types.JID
		wantJID  string
		wantIsIn bool
	}{
		{"legacy phone result", types.IsOnWhatsAppResponse{JID: phone, IsIn: true}, types.EmptyJID, phone.String(), true},
		{"LID with explicit phone", types.IsOnWhatsAppResponse{JID: lid, PhoneNumber: phone, IsIn: true}, types.EmptyJID, phone.String(), true},
		{"LID with stored mapping", types.IsOnWhatsAppResponse{JID: lid, IsIn: true}, phone, phone.String(), true},
		{"unresolved numeric LID is never a phone", types.IsOnWhatsAppResponse{JID: lid, Query: phone.User, IsIn: true}, types.EmptyJID, lid.String(), true},
		{"negative remains negative", types.IsOnWhatsAppResponse{PhoneNumber: phone, IsIn: false}, types.EmptyJID, phone.String(), false},
		{"missing identity is not fabricated from query", types.IsOnWhatsAppResponse{Query: phone.User, IsIn: true}, types.EmptyJID, "", true},
		{"invalid phone field cannot replace LID", types.IsOnWhatsAppResponse{JID: lid, PhoneNumber: types.NewJID("123", types.DefaultUserServer), IsIn: true}, types.EmptyJID, lid.String(), true},
		{"LID field cannot serve as phone mapping", types.IsOnWhatsAppResponse{JID: lid, PhoneNumber: lid, IsIn: true}, lid, lid.String(), true},
		{"linked phone device suffix is removed", types.IsOnWhatsAppResponse{JID: lid, PhoneNumber: types.JID{User: phone.User, Server: phone.Server, Device: 7}, IsIn: true}, types.EmptyJID, phone.String(), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := whatsAppCheckResult(test.result, test.mapped)
			if got.JID != test.wantJID || got.IsOnWhatsApp != test.wantIsIn || got.Phone != test.result.Query {
				t.Fatalf("unexpected result: %+v, want JID %q, registered %v and original query", got, test.wantJID, test.wantIsIn)
			}
		})
	}
}

func TestSentChatIdentityUsesTransportWithoutDuplicatingCRMChat(t *testing.T) {
	t.Parallel()
	phone := types.NewJID("51987654321", types.DefaultUserServer)
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	group := types.NewJID("120363000000000001", types.GroupServer)
	for _, test := range []struct {
		name                      string
		requested, actual, mapped types.JID
		want                      types.JID
	}{
		{"upstream converts phone to LID", phone, lid, types.EmptyJID, phone},
		{"explicit LID with mapping", lid, lid, phone, phone},
		{"explicit LID unresolved", lid, lid, types.EmptyJID, lid},
		{"provider returns phone", lid, phone, types.EmptyJID, phone},
		{"missing provider destination", phone, types.EmptyJID, types.EmptyJID, phone},
		{"group never becomes participant phone", group, group, phone, group},
		{"actual group is preserved", phone, group, phone, group},
		{"remove transport device suffix", types.JID{User: phone.User, Server: phone.Server, Device: 7}, lid, types.EmptyJID, phone},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := sentChatIdentity(test.requested, test.actual, test.mapped); got != test.want {
				t.Fatalf("sentChatIdentity() = %s, want %s", got, test.want)
			}
		})
	}
}

func TestLIDFallbackNeverRepeatsAnEffectiveLIDOrAmbiguousSend(t *testing.T) {
	t.Parallel()
	phone := types.NewJID("51987654321", types.DefaultUserServer)
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	rejected := errors.New("server returned error 463")
	for _, test := range []struct {
		name              string
		requested, actual types.JID
		err               error
		want              bool
	}{
		{"explicit phone rejection", phone, phone, rejected, true},
		{"legacy response lacks destination", phone, types.EmptyJID, rejected, true},
		{"upstream already sent via LID", phone, lid, rejected, false},
		{"explicit LID rejection", lid, lid, rejected, false},
		{"success", phone, phone, nil, false},
		{"other provider rejection", phone, phone, errors.New("server returned error 500"), false},
		{"canceled", phone, phone, context.Canceled, false},
		{"deadline", phone, phone, context.DeadlineExceeded, false},
		{"cancellation wrapping old rejection", phone, phone, fmt.Errorf("%w: %v", context.Canceled, rejected), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldRetrySendViaLID(test.requested, whatsmeow.SendResponse{Chat: test.actual}, test.err); got != test.want {
				t.Fatalf("shouldRetrySendViaLID() = %v, want %v", got, test.want)
			}
		})
	}
}
