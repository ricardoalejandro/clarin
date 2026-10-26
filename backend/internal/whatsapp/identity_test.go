package whatsapp

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

func TestExplicitMessagePeerIdentityPrefersIncomingSenderAltPN(t *testing.T) {
	t.Parallel()
	lid := types.NewJID("65657383165996", types.HiddenUserServer)
	pn := types.NewJID("51904806007", types.DefaultUserServer)
	phoneJID, lidJID := explicitMessagePeerIdentity(types.MessageSource{
		Chat: lid, Sender: lid, SenderAlt: pn, IsFromMe: false,
	})
	if phoneJID != pn || lidJID != lid {
		t.Fatalf("resolved phone/lid = %s/%s, want %s/%s", phoneJID, lidJID, pn, lid)
	}
}

func TestExplicitMessagePeerIdentityUsesOutgoingRecipientAlt(t *testing.T) {
	t.Parallel()
	lid := types.NewJID("65657383165996", types.HiddenUserServer)
	pn := types.NewJID("51904806007", types.DefaultUserServer)
	own := types.NewJID("51975967076", types.DefaultUserServer)
	phoneJID, lidJID := explicitMessagePeerIdentity(types.MessageSource{
		Chat: lid, Sender: own, RecipientAlt: pn, IsFromMe: true,
	})
	if phoneJID != pn || lidJID != lid {
		t.Fatalf("resolved phone/lid = %s/%s, want %s/%s", phoneJID, lidJID, pn, lid)
	}
}

func TestExplicitMessagePeerIdentityDoesNotUseOwnOutgoingSender(t *testing.T) {
	t.Parallel()
	lid := types.NewJID("65657383165996", types.HiddenUserServer)
	own := types.NewJID("51975967076", types.DefaultUserServer)
	phoneJID, lidJID := explicitMessagePeerIdentity(types.MessageSource{
		Chat: lid, Sender: own, IsFromMe: true,
	})
	if !phoneJID.IsEmpty() || lidJID != lid {
		t.Fatalf("resolved phone/lid = %s/%s, want empty/%s", phoneJID, lidJID, lid)
	}
}

func TestPendingJIDNormalizationNeverReturnsPhoneDigits(t *testing.T) {
	t.Parallel()
	lid := types.NewJID("65657383165996", types.HiddenUserServer)
	if got := normalizedPendingJID(lid); got != "65657383165996@lid" {
		t.Fatalf("normalizedPendingJID() = %q", got)
	}
	if got := normalizedPendingJID(types.NewJID("51904806007", types.DefaultUserServer)); got != "" {
		t.Fatalf("normalizedPendingJID(PN) = %q, want empty", got)
	}
}

func TestMappedLIDContactNeverMergesCRMOnProviderObservation(t *testing.T) {
	t.Parallel()
	accountID := uuid.New()
	canonical := &domain.Contact{ID: uuid.New(), AccountID: accountID}
	// No repositories are attached: the compatibility hook must not perform a
	// lookup, merge, delete or rewrite even for a proven mapping.
	pool := &DevicePool{}
	if got := pool.reconcileMappedLIDContact(context.Background(), accountID, "7001@lid", canonical); got != canonical {
		t.Fatal("provider mapping replaced the canonical CRM identity")
	}
}

func TestPrivateMessageChatJIDPreservesLegacyExactRoutes(t *testing.T) {
	lid := types.NewJID("7001", types.HiddenUserServer)
	pn := types.NewJID("51900000001", types.DefaultUserServer)
	identity := peerIdentityResolution{JID: pn, LID: lid}
	for _, chat := range []types.JID{lid, pn} {
		if got := privateMessageChatJID(types.MessageSource{Chat: chat}, identity); got != chat.String() {
			t.Fatalf("changed exact legacy route %s to %s", chat, got)
		}
	}
}

func TestIncomingPNAltCannotIntroduceAnUnverifiedLID(t *testing.T) {
	pn, lid := types.NewJID("51900000001", types.DefaultUserServer), types.NewJID("7001", types.HiddenUserServer)
	source := types.MessageSource{Chat: pn, Sender: pn, SenderAlt: lid}
	got := messageSourceWithVerifiedPNAlt(source, types.EmptyJID)
	if got.Sender != pn || !got.SenderAlt.IsEmpty() {
		t.Fatalf("provider-global alt became pair evidence: %+v", got)
	}
	if got := messageSourceWithVerifiedPNAlt(source, lid); got.SenderAlt != lid {
		t.Fatal("already-scoped pair was discarded")
	}
	if got := messageSourceWithVerifiedPNAlt(source, types.NewJID("7002", types.HiddenUserServer)); !got.SenderAlt.IsEmpty() {
		t.Fatal("different scoped LID legitimized stale global alias")
	}
	actualLID := types.MessageSource{Chat: lid, Sender: lid, SenderAlt: pn}
	if got := messageSourceWithVerifiedPNAlt(actualLID, types.EmptyJID); got.SenderAlt != pn {
		t.Fatal("wire LID-to-PN evidence was discarded")
	}
	ownOutgoing := types.MessageSource{Chat: lid, Sender: pn, SenderAlt: lid, RecipientAlt: pn, IsFromMe: true}
	if got := messageSourceWithVerifiedPNAlt(ownOutgoing, types.EmptyJID); got.RecipientAlt != pn {
		t.Fatal("own outgoing wire recipient alt was discarded")
	}
}
