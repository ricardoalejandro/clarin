package whatsapp

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"go.mau.fi/whatsmeow/types"
)

func validOutgoingChatContext(send domain.MessageSendContext, chat *domain.Chat, accountID, deviceID uuid.UUID, original, verifiedAlternate string) bool {
	return send.AccountID == accountID && send.ChatID != uuid.Nil && chat != nil && chat.AccountID == accountID && chat.ID == send.ChatID && chat.DeviceID != nil && *chat.DeviceID == deviceID && (chat.JID == original || (verifiedAlternate != "" && chat.JID == verifiedAlternate))
}

// Transport may use a different PN/LID address, but that cannot select another
// saved conversation. The authenticated composer context owns persistence.
func (p *DevicePool) outgoingChatContext(ctx context.Context, instance *DeviceInstance, original types.JID) (*domain.Chat, error) {
	send, ok := domain.MessageSendContextFrom(ctx)
	if !ok || send.ChatID == uuid.Nil {
		return nil, nil
	}
	if send.AccountID != instance.AccountID {
		return nil, repository.ErrChatBindingChanged
	}
	chat, err := p.repos.Chat.GetByID(ctx, send.ChatID)
	if err != nil {
		return nil, err
	}
	jid := original.ToNonAD().String()
	alternate := ""
	if chat != nil && chat.JID != jid && (original.Server == types.DefaultUserServer || original.Server == types.HiddenUserServer) {
		aliases, aliasErr := p.repos.Chat.WhatsAppPeerAliases(ctx, instance.AccountID, instance.ID, []string{jid})
		if aliasErr != nil {
			return nil, aliasErr
		}
		if original.Server == types.HiddenUserServer {
			alternate = aliases.PNForLID[jid]
		} else {
			alternate = aliases.LIDForPN[jid]
		}
	}
	if !validOutgoingChatContext(send, chat, instance.AccountID, instance.ID, jid, alternate) {
		return nil, fmt.Errorf("%w: la conversación o el remitente cambió", repository.ErrChatBindingChanged)
	}
	return chat, nil
}

func (p *DevicePool) outgoingMessageChat(ctx context.Context, instance *DeviceInstance, original types.JID) (*domain.Chat, error) {
	chat, err := p.outgoingChatContext(ctx, instance, original)
	if err != nil || chat != nil {
		return chat, err
	}
	return p.repos.Chat.GetOrCreate(ctx, instance.AccountID, instance.ID, original.ToNonAD().String(), "")
}
