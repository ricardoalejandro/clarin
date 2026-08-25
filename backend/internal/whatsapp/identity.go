package whatsapp

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
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

func (p *DevicePool) resolveMessagePeerIdentity(ctx context.Context, source types.MessageSource) peerIdentityResolution {
	phoneJID, lidJID := explicitMessagePeerIdentity(source)
	if !phoneJID.IsEmpty() {
		if !lidJID.IsEmpty() && p.store != nil && p.store.LIDMap != nil {
			// Persist the explicit provider pair before any CRM write so future
			// receipts/history events resolve even if their Alt field is absent.
			_ = p.store.LIDMap.PutLIDMapping(ctx, lidJID, phoneJID)
		}
		return peerIdentityResolution{JID: phoneJID, LID: lidJID}
	}
	if !lidJID.IsEmpty() && p.store != nil && p.store.LIDMap != nil {
		if mapped, err := p.store.LIDMap.GetPNForLID(ctx, lidJID); err == nil && !mapped.IsEmpty() && mapped.Server == types.DefaultUserServer {
			return peerIdentityResolution{JID: mapped.ToNonAD(), LID: lidJID}
		}
	}
	if !lidJID.IsEmpty() {
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
	identity := p.resolveMessagePeerIdentity(ctx, source)
	if instance == nil || identity.JID.IsEmpty() {
		return nil, identity, fmt.Errorf("WhatsApp peer identity is unavailable")
	}
	canonicalJID := identity.JID.ToNonAD().String()
	chat, err := p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, canonicalJID, name)
	if err != nil {
		return nil, identity, err
	}
	if identity.LID.IsEmpty() || identity.JID.Server != types.DefaultUserServer {
		return chat, identity, nil
	}

	reconciled, reconcileErr := p.repos.Chat.ReconcileLIDChat(
		ctx,
		instance.AccountID,
		instance.ID,
		chat.ID,
		identity.LID.ToNonAD().String(),
		canonicalJID,
	)
	if reconcileErr != nil {
		// The current message can still be safely persisted in the canonical
		// chat. The unresolved source remains visible for a later retry.
		log.Printf("[ChatIdentity] reconcile failed account=%s device=%s: %v", instance.AccountID, instance.ID, reconcileErr)
		return chat, identity, nil
	}
	if reconciled.SourceChatID == nil {
		return chat, identity, nil
	}

	if reconciled.SourceContactID != nil && reconciled.CanonicalContactID != nil && *reconciled.SourceContactID != *reconciled.CanonicalContactID {
		if _, mergeErr := p.repos.Contact.MergeContacts(
			ctx,
			instance.AccountID,
			*reconciled.CanonicalContactID,
			[]uuid.UUID{*reconciled.SourceContactID},
			nil,
		); mergeErr != nil {
			log.Printf("[ChatIdentity] contact merge failed account=%s device=%s source_chat=%s: %v", instance.AccountID, instance.ID, *reconciled.SourceChatID, mergeErr)
		}
	}

	if refreshed, refreshErr := p.repos.Chat.GetByID(ctx, chat.ID); refreshErr == nil && refreshed != nil {
		chat = refreshed
	}
	p.invalidateChatCaches(instance.AccountID, chat.ID)
	p.invalidateAccountMessageCaches(instance.AccountID)
	if p.cache != nil {
		_ = p.cache.Del(context.Background(), "contacts:"+instance.AccountID.String())
		_ = p.cache.Del(context.Background(), "leads:"+instance.AccountID.String())
	}
	operationID := uuid.NewString()
	p.hub.BroadcastToAccount(instance.AccountID, ws.EventChatIdentityReconciled, map[string]interface{}{
		"operation_id":        operationID,
		"source_chat_id":      reconciled.SourceChatID.String(),
		"canonical_chat":      chat,
		"moved_message_count": reconciled.MovedMessageCount,
	})
	log.Printf("[ChatIdentity] reconciled account=%s device=%s source_chat=%s canonical_chat=%s moved_messages=%d operation=%s",
		instance.AccountID, instance.ID, *reconciled.SourceChatID, chat.ID, reconciled.MovedMessageCount, operationID)
	return chat, identity, nil
}

func (p *DevicePool) reconcilePendingChatIdentities(ctx context.Context, instance *DeviceInstance) {
	if instance == nil || p.store == nil || p.store.LIDMap == nil {
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
		phoneJID, mapErr := p.store.LIDMap.GetPNForLID(ctx, lidJID.ToNonAD())
		if mapErr != nil || phoneJID.IsEmpty() || phoneJID.Server != types.DefaultUserServer {
			continue
		}
		name := ""
		if pending.Name != nil {
			name = strings.TrimSpace(*pending.Name)
		}
		_, _, _ = p.getOrCreateMessageChat(ctx, instance, types.MessageSource{
			Chat:      lidJID.ToNonAD(),
			Sender:    lidJID.ToNonAD(),
			SenderAlt: phoneJID.ToNonAD(),
			IsFromMe:  false,
		}, name)
	}
}

func shouldMergeMappedLIDContact(accountID uuid.UUID, lidJID string, canonical, source *domain.Contact) bool {
	return accountID != uuid.Nil &&
		strings.HasSuffix(strings.ToLower(strings.TrimSpace(lidJID)), "@lid") &&
		canonical != nil && source != nil &&
		canonical.AccountID == accountID && source.AccountID == accountID &&
		canonical.ID != uuid.Nil && source.ID != uuid.Nil && canonical.ID != source.ID
}

// reconcileMappedLIDContact removes the legacy duplicate Contact projection
// once WhatsApp has proven that its LID and phone JID are the same identity.
// MergeContacts preserves aliases and relinks account-scoped CRM references.
func (p *DevicePool) reconcileMappedLIDContact(
	ctx context.Context,
	accountID uuid.UUID,
	lidJID string,
	canonical *domain.Contact,
) *domain.Contact {
	if canonical == nil || strings.TrimSpace(lidJID) == "" {
		return canonical
	}
	source, err := p.repos.Contact.GetByJID(ctx, accountID, lidJID)
	if err != nil {
		log.Printf("[ChatIdentity] mapped contact lookup failed account=%s lid=%s: %v", accountID, lidJID, err)
		return canonical
	}
	if !shouldMergeMappedLIDContact(accountID, lidJID, canonical, source) {
		return canonical
	}
	merged, err := p.repos.Contact.MergeContacts(ctx, accountID, canonical.ID, []uuid.UUID{source.ID}, nil)
	if err != nil {
		log.Printf("[ChatIdentity] mapped contact merge failed account=%s source_contact=%s canonical_contact=%s: %v", accountID, source.ID, canonical.ID, err)
		return canonical
	}
	if merged != nil && merged.MergedContact != nil {
		canonical = merged.MergedContact
	}
	log.Printf("[ChatIdentity] mapped contact reconciled account=%s source_contact=%s canonical_contact=%s", accountID, source.ID, canonical.ID)
	return canonical
}

func (p *DevicePool) reconcileAllMappedLIDContacts(ctx context.Context) {
	pairs, err := p.repos.Contact.GetMappedLIDContactPairs(ctx)
	if err != nil {
		log.Printf("[ChatIdentity] mapped contact scan failed: %v", err)
		return
	}
	for _, pair := range pairs {
		canonical, lookupErr := p.repos.Contact.GetByJID(ctx, pair.AccountID, pair.PhoneJID)
		if lookupErr != nil {
			log.Printf("[ChatIdentity] canonical contact lookup failed account=%s contact=%s: %v", pair.AccountID, pair.CanonicalContactID, lookupErr)
			continue
		}
		p.reconcileMappedLIDContact(ctx, pair.AccountID, pair.LIDJID, canonical)
	}
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
