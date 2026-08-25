package whatsapp

import (
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

func TestShouldMergeMappedLIDContactRequiresSameAccountAndDifferentContacts(t *testing.T) {
	t.Parallel()
	accountID := uuid.New()
	canonical := &domain.Contact{ID: uuid.New(), AccountID: accountID}
	source := &domain.Contact{ID: uuid.New(), AccountID: accountID}
	if !shouldMergeMappedLIDContact(accountID, "65657383165996@lid", canonical, source) {
		t.Fatal("expected a proven same-account LID duplicate to be mergeable")
	}
	if shouldMergeMappedLIDContact(accountID, "51904806007@s.whatsapp.net", canonical, source) {
		t.Fatal("phone JIDs must not be treated as legacy LID duplicates")
	}
	source.AccountID = uuid.New()
	if shouldMergeMappedLIDContact(accountID, "65657383165996@lid", canonical, source) {
		t.Fatal("cross-account contacts must never be merged")
	}
}
