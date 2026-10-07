package whatsapp

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
)

func (p *DevicePool) hydrateMessageQuote(ctx context.Context, accountID, chatID uuid.UUID, messageID string, quote domain.MessageQuote) bool {
	changed, err := p.repos.Message.HydrateMissingQuote(ctx, accountID, chatID, messageID, quote)
	if err != nil || !changed {
		return false
	}
	p.invalidateAccountMessageCaches(accountID)
	if p.hub != nil {
		if message, err := p.repos.Message.GetByReference(ctx, accountID, chatID, messageID); err == nil && message != nil {
			p.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, ws.EventMessageUpdated, map[string]interface{}{"chat_id": chatID.String(), "message": message})
		}
	}
	return true
}
