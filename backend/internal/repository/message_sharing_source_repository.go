package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// A copy reads content from the selected private Chat and sends a fresh message
// with its current sender. Historical device provenance is immutable and is not
// the sender selection. Native forwarding and group continuity keep their
// existing device/owner rules. Shared with the operation's transactional check.
// Query aliases and $1..$5 are fixed: account, Chat, Message, device, mode.
const messageSharingSourceDeviceSQL = `(
 (current.jid NOT LIKE '%@g.us' AND (
  ($5::text='copy' AND source.id=current.id) OR
  ($5::text='native' AND m.device_id=$4::uuid))) OR
 (current.jid LIKE '%@g.us' AND (
  (current.whatsapp_owner_id IS NULL AND source.id=current.id AND m.device_id=$4::uuid) OR
  (current.binding_state='verified_continuity' AND current.whatsapp_owner_id IS NOT NULL AND source.whatsapp_owner_id=current.whatsapp_owner_id))))`

func (r *MessageRepository) MessageSharingDeviceAllowed(ctx context.Context, accountID, chatID, deviceID uuid.UUID, message *domain.Message, mode string) (bool, error) {
	normalized, err := domain.NormalizeMessageSharingMode(mode)
	if err != nil {
		return false, err
	}
	if normalized != domain.MessageSharingCopy {
		return r.MessageDeviceAllowed(ctx, accountID, chatID, deviceID, message)
	}
	if message == nil || message.AccountID != accountID {
		return false, nil
	}
	var allowed bool
	err = r.db.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM chats requested
 JOIN chats current ON current.account_id=requested.account_id AND current.id=COALESCE(requested.canonical_chat_id,requested.id)
 JOIN messages m ON m.account_id=current.account_id AND m.id=$3
 JOIN chats source ON source.account_id=m.account_id AND source.id=m.chat_id
 JOIN devices d ON d.account_id=current.account_id AND d.id=current.device_id
 WHERE requested.account_id=$1 AND requested.id=$2 AND current.device_id=$4::uuid
 AND d.status='connected' AND d.delete_operation_id IS NULL
 AND COALESCE(NULLIF(d.provider,''),'whatsapp_web')='whatsapp_web'
 AND COALESCE(source.canonical_chat_id,source.id)=current.id
 AND `+messageSharingSourceDeviceSQL+`)`, accountID, chatID, message.ID, deviceID, normalized).Scan(&allowed)
	return allowed, err
}
