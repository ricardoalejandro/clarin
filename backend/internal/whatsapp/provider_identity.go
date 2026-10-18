package whatsapp

import (
	"context"
	"errors"
	"strings"

	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
)

// phoneIdentityJID accepts only an explicit provider phone identity. In
// particular, neither a numeric LID nor the queried number proves a PN mapping.
func phoneIdentityJID(jid types.JID) types.JID {
	jid = jid.ToNonAD()
	if jid.Server != types.DefaultUserServer || len(jid.User) < 7 || len(jid.User) > 15 {
		return types.EmptyJID
	}
	for _, digit := range jid.User {
		if digit < '0' || digit > '9' {
			return types.EmptyJID
		}
	}
	return jid
}

func whatsAppCheckResult(result types.IsOnWhatsAppResponse, mappedPhone types.JID) domain.WhatsAppCheckResult {
	jid := result.JID.ToNonAD()
	for _, candidate := range []types.JID{result.PhoneNumber, result.JID, mappedPhone} {
		if phone := phoneIdentityJID(candidate); !phone.IsEmpty() {
			jid = phone
			break
		}
	}
	verifiedName := ""
	if result.VerifiedName != nil && result.VerifiedName.Details != nil {
		verifiedName = result.VerifiedName.Details.GetVerifiedName()
	}
	return domain.WhatsAppCheckResult{
		Phone:        result.Query,
		IsOnWhatsApp: result.IsIn,
		JID:          jid.String(),
		VerifiedName: verifiedName,
	}
}

// sentChatIdentity keeps CRM phone identity stable when whatsmeow replaces a
// requested PN with its LID for transport. SendResponse.Chat remains untouched
// so callers still have the exact provider destination when needed.
func sentChatIdentity(requested, actual, mappedPhone types.JID) types.JID {
	requested = requested.ToNonAD()
	actual = actual.ToNonAD()
	if actual.IsEmpty() {
		actual = requested
	}
	if actual.Server != types.HiddenUserServer {
		return actual
	}
	if phone := phoneIdentityJID(requested); !phone.IsEmpty() {
		return phone
	}
	if phone := phoneIdentityJID(mappedPhone); !phone.IsEmpty() {
		return phone
	}
	return actual
}

func (p *DevicePool) sentMessageChatIdentity(ctx context.Context, requested types.JID, response whatsmeow.SendResponse) types.JID {
	actual := response.Chat.ToNonAD()
	if actual.IsEmpty() {
		actual = requested.ToNonAD()
	}
	var mappedPhone types.JID
	if actual.Server == types.HiddenUserServer && phoneIdentityJID(requested).IsEmpty() && p.store != nil && p.store.LIDMap != nil {
		mappedPhone, _ = p.store.LIDMap.GetPNForLID(ctx, actual)
	}
	return sentChatIdentity(requested, actual, mappedPhone)
}

func shouldRetrySendViaLID(requested types.JID, response whatsmeow.SendResponse, err error) bool {
	// Recent whatsmeow already converts PN to LID before sending. Repeating
	// that rejected destination adds no fallback. Cancellation and timeouts
	// are also never proof that the first physical send did not reach WhatsApp.
	return err != nil &&
		!errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) &&
		requested.Server == types.DefaultUserServer &&
		(response.Chat.IsEmpty() || response.Chat.Server == types.DefaultUserServer) &&
		strings.Contains(err.Error(), "server returned error 463")
}
