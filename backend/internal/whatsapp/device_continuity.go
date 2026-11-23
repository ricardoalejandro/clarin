package whatsapp

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// A resource lease prevents reset/deletion while the authenticated owner is
// checked. Reconnect callbacks never import Contacts or rewrite message origin.
func (p *DevicePool) reconcileDeviceChatContinuity(ctx context.Context, accountID, deviceID uuid.UUID) error {
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return err
	}
	defer release()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return err
	}
	fingerprint := deviceSessionFingerprint(instance.Client.Store)
	if err = p.requirePeerIdentitySession(instance, fingerprint); err != nil {
		return err
	}
	if instance.Client.Store.ID == nil {
		return repository.ErrWhatsAppIdentitySessionChanged
	}
	ids, err := p.repos.Chat.ReconcileWhatsAppGroups(operationCtx, accountID, deviceID, instance.Client.Store.ID.ToNonAD().String(), instance.Client.Store.LID.ToNonAD().String())
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		chats := make([]*domain.Chat, 0, len(ids))
		for _, id := range ids {
			chats = append(chats, &domain.Chat{ID: id, AccountID: accountID})
		}
		if err = p.repos.Chat.HydrateContinuity(operationCtx, accountID, chats); err != nil {
			return err
		}
		p.invalidateAccountMessageCaches(accountID)
		if p.cache != nil {
			_ = p.cache.DelPattern(operationCtx, "chats:"+accountID.String()+":*")
		}
		if p.hub != nil {
			for _, chat := range chats {
				p.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, "chat_continuity_reconciled", map[string]interface{}{"device_id": chat.DeviceID, "canonical_chat_id": chat.CanonicalChatID, "alias_chat_ids": chat.AliasChatIDs, "binding_revision": chat.BindingRevision, "binding_state": chat.BindingState})
			}
		}
	}
	return nil
}
