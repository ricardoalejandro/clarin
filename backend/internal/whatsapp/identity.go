package whatsapp

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

type peerIdentityResolution struct {
	JID     types.JID
	LID     types.JID
	Pending bool
}

func messagePeerCandidates(source types.MessageSource) []types.JID {
	if source.IsFromMe {
		// Sender/SenderAlt identify this account for outgoing DMs. The peer is
		// the chat, with RecipientAlt carrying its alternate PN/LID address.
		return []types.JID{source.RecipientAlt, source.Chat}
	}
	// For incoming DMs SenderAlt is the strongest explicit PN counterpart.
	return []types.JID{source.SenderAlt, source.Sender, source.Chat}
}

func explicitMessagePeerIdentity(source types.MessageSource) (types.JID, types.JID) {
	var phoneJID, lidJID types.JID
	for _, candidate := range messagePeerCandidates(source) {
		candidate = candidate.ToNonAD()
		if candidate.IsEmpty() {
			continue
		}
		switch candidate.Server {
		case types.DefaultUserServer:
			if phoneJID.IsEmpty() {
				phoneJID = candidate
			}
		case types.HiddenUserServer:
			if lidJID.IsEmpty() {
				lidJID = candidate
			}
		}
	}
	return phoneJID, lidJID
}

// scopedPeerPhoneJID never treats the provider container's global LID cache
// as proof that this account/device observed a phone number.
func (p *DevicePool) scopedPeerPhoneJID(ctx context.Context, instance *DeviceInstance, lid types.JID) types.JID {
	if p == nil || p.repos == nil || p.repos.Chat == nil || instance == nil || lid.Server != types.HiddenUserServer {
		return types.EmptyJID
	}
	aliases, err := p.repos.Chat.WhatsAppPeerAliases(ctx, instance.AccountID, instance.ID, []string{lid.ToNonAD().String()})
	if err != nil {
		return types.EmptyJID
	}
	pn, _ := types.ParseJID(aliases.PNForLID[lid.ToNonAD().String()])
	return phoneIdentityJID(pn)
}

// Incoming PN messages may have SenderAlt filled from whatsmeow's shared
// encryption cache after wire parsing. It cannot establish a new local pair.
func messageSourceWithVerifiedPNAlt(source types.MessageSource, verifiedLID types.JID) types.MessageSource {
	if !source.IsFromMe && source.Sender.Server == types.DefaultUserServer && source.SenderAlt.Server == types.HiddenUserServer && source.SenderAlt.ToNonAD() != verifiedLID.ToNonAD() {
		source.SenderAlt = types.EmptyJID
	}
	return source
}

func (p *DevicePool) messageSourceWithScopedPNAlt(ctx context.Context, instance *DeviceInstance, source types.MessageSource) types.MessageSource {
	if source.IsFromMe || source.Sender.Server != types.DefaultUserServer || source.SenderAlt.Server != types.HiddenUserServer {
		return source
	}
	var verified types.JID
	if p != nil && p.repos != nil && p.repos.Chat != nil && instance != nil {
		aliases, err := p.repos.Chat.WhatsAppPeerAliases(ctx, instance.AccountID, instance.ID, []string{source.Sender.ToNonAD().String()})
		if err == nil {
			verified, _ = types.ParseJID(aliases.LIDForPN[source.Sender.ToNonAD().String()])
		}
	}
	return messageSourceWithVerifiedPNAlt(source, verified)
}

func (p *DevicePool) resolveMessagePeerIdentity(ctx context.Context, instance *DeviceInstance, source types.MessageSource) peerIdentityResolution {
	if source.Chat.Server == types.GroupServer {
		return peerIdentityResolution{JID: source.Chat.ToNonAD()}
	}
	source = p.messageSourceWithScopedPNAlt(ctx, instance, source)
	phoneJID, lidJID := explicitMessagePeerIdentity(source)
	if !phoneJID.IsEmpty() {
		return peerIdentityResolution{JID: phoneJID, LID: lidJID}
	}
	if !lidJID.IsEmpty() {
		if mapped := p.scopedPeerPhoneJID(ctx, instance, lidJID); !mapped.IsEmpty() {
			return peerIdentityResolution{JID: mapped, LID: lidJID}
		}
		return peerIdentityResolution{JID: lidJID, LID: lidJID, Pending: true}
	}
	chat := source.Chat.ToNonAD()
	return peerIdentityResolution{JID: chat, Pending: chat.Server == types.HiddenUserServer}
}

func (identity peerIdentityResolution) phone() string {
	if identity.JID.Server != types.DefaultUserServer {
		return ""
	}
	return identity.JID.User
}

// getOrCreateMessageChat is the single CRM identity entry point for live
// messages, polls, reactions and parsed history messages.
func (p *DevicePool) getOrCreateMessageChat(
	ctx context.Context,
	instance *DeviceInstance,
	source types.MessageSource,
	name string,
) (*domain.Chat, peerIdentityResolution, error) {
	if source.Chat.Server == types.GroupServer {
		identity := peerIdentityResolution{JID: source.Chat.ToNonAD()}
		chat, err := p.repos.Chat.GetOrCreateGroup(ctx, instance.AccountID, instance.ID, identity.JID.String(), "")
		return chat, identity, err
	}
	identity := p.resolveMessagePeerIdentity(ctx, instance, source)
	if instance == nil || identity.JID.IsEmpty() {
		return nil, identity, fmt.Errorf("WhatsApp peer identity is unavailable")
	}
	// Preserve the incoming representation when legacy PN/LID histories already
	// diverge. The repository may reuse one verified representation, but may
	// never merge Contacts or delete another history as a receive side effect.
	chatJID := privateMessageChatJID(source, identity)
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, chatJID, name)
	return chat, identity, err
}

func (p *DevicePool) reconcilePendingChatIdentities(ctx context.Context, instance *DeviceInstance) {
	if instance == nil || p.repos == nil || p.repos.Chat == nil {
		return
	}
	pendingChats, err := p.repos.Chat.GetPendingIdentitiesByDevice(ctx, instance.AccountID, instance.ID)
	if err != nil {
		log.Printf("[ChatIdentity] pending scan failed account=%s device=%s: %v", instance.AccountID, instance.ID, err)
		return
	}
	for _, pending := range pendingChats {
		lidJID, parseErr := types.ParseJID(pending.JID)
		if parseErr != nil || lidJID.Server != types.HiddenUserServer {
			continue
		}
		phoneJID := p.scopedPeerPhoneJID(ctx, instance, lidJID)
		if phoneJID.IsEmpty() {
			continue
		}
		name := ""
		if pending.Name != nil {
			name = strings.TrimSpace(*pending.Name)
		}
		operationCtx, release, lifecycleErr := p.retainDeviceOperation(ctx, instance.AccountID, instance.ID)
		if lifecycleErr != nil {
			return
		}
		_, _, _ = p.getOrCreateMessageChat(operationCtx, instance, types.MessageSource{
			Chat:      lidJID.ToNonAD(),
			Sender:    lidJID.ToNonAD(),
			SenderAlt: phoneJID.ToNonAD(),
			IsFromMe:  false,
		}, name)
		release()
	}
}

// Contact sync and initial history still call this compatibility hook. A
// provider alias proves a transport address, not permission to merge CRM data.
// Existing duplicate Contacts and all their children remain available for an
// explicit, separately reviewed repair.
func (p *DevicePool) reconcileMappedLIDContact(
	_ context.Context,
	_ uuid.UUID,
	_ string,
	canonical *domain.Contact,
) *domain.Contact {
	return canonical
}

func privateMessageChatJID(source types.MessageSource, identity peerIdentityResolution) string {
	chat := source.Chat.ToNonAD()
	if chat.Server == types.DefaultUserServer || chat.Server == types.HiddenUserServer {
		return chat.String()
	}
	return identity.JID.ToNonAD().String()
}

func isPendingWhatsAppJID(jid types.JID) bool {
	return jid.ToNonAD().Server == types.HiddenUserServer
}

func normalizedPendingJID(jid types.JID) string {
	if !isPendingWhatsAppJID(jid) {
		return ""
	}
	return strings.ToLower(jid.ToNonAD().String())
}
