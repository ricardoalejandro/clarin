package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"time"
)

var groupMediaSlots = make(chan struct{}, 2)

func recoverableGroupMedia(message *waE2E.Message) *waE2E.Message {
	for depth := 0; message != nil && depth < 8; depth++ {
		switch {
		case message.EphemeralMessage != nil:
			message = message.EphemeralMessage.Message
		case message.DocumentWithCaptionMessage != nil:
			message = message.DocumentWithCaptionMessage.Message
		case message.ViewOnceMessage != nil || message.ViewOnceMessageV2 != nil || message.ViewOnceMessageV2Extension != nil:
			return nil
		default:
			switch {
			case message.ImageMessage != nil:
				if message.ImageMessage.GetFileLength() > uint64(groupMediaMaxBytes) {
					return nil
				}
				return &waE2E.Message{ImageMessage: message.ImageMessage}
			case message.VideoMessage != nil:
				if message.VideoMessage.GetFileLength() > uint64(groupMediaMaxBytes) {
					return nil
				}
				return &waE2E.Message{VideoMessage: message.VideoMessage}
			case message.AudioMessage != nil:
				if message.AudioMessage.GetFileLength() > uint64(groupMediaMaxBytes) {
					return nil
				}
				return &waE2E.Message{AudioMessage: message.AudioMessage}
			case message.DocumentMessage != nil:
				if message.DocumentMessage.GetFileLength() > uint64(groupMediaMaxBytes) {
					return nil
				}
				return &waE2E.Message{DocumentMessage: message.DocumentMessage}
			case message.StickerMessage != nil:
				if message.StickerMessage.GetFileLength() > uint64(groupMediaMaxBytes) {
					return nil
				}
				return &waE2E.Message{StickerMessage: message.StickerMessage}
			}
			return nil
		}
	}
	return nil
}

// Keep only provider media metadata required for an explicit download. Never log
// this payload: it contains encrypted-media keys. The parent chat owns retention.
func (p *DevicePool) rememberGroupMedia(ctx context.Context, accountID, chatID uuid.UUID, event *events.Message) {
	media := recoverableGroupEventMedia(event)
	if media == nil {
		return
	}
	messageID := event.Info.ID
	payload, err := proto.Marshal(media)
	if err != nil || len(payload) > 1<<20 {
		return
	}
	_ = p.repos.Message.RememberGroupMedia(ctx, accountID, chatID, messageID, payload)
}

func (p *DevicePool) RecoverGroupMedia(ctx context.Context, accountID, deviceID, chatID, messageID uuid.UUID) (*domain.Message, error) {
	if !p.GroupsEnabledForAccount(accountID) {
		return nil, fmt.Errorf("los grupos todavía no están habilitados para esta cuenta")
	}
	operationCtx, release, err := p.retainDeviceOperation(ctx, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	defer release()
	instance, err := p.reportDevice(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	chat, err := p.repos.Chat.GetByID(ctx, chatID)
	if err != nil || chat == nil || chat.AccountID != accountID || chat.DeviceID == nil || *chat.DeviceID != deviceID || !domain.IsGroupJID(chat.JID) {
		return nil, fmt.Errorf("grupo no encontrado")
	}
	requestCtx, cancel := context.WithTimeout(operationCtx, 40*time.Second)
	defer cancel()
	message, err := p.repos.Message.GetByReference(requestCtx, accountID, chatID, messageID.String())
	if err != nil || message == nil || message.IsRevoked || message.MediaDeleted {
		return nil, fmt.Errorf("archivo no disponible")
	}
	if message.MediaURL != nil && *message.MediaURL != "" {
		return message, nil
	}
	if err = p.repos.Message.HydrateMentions(requestCtx, accountID, chatID, []*domain.Message{message}); err != nil {
		return nil, err
	}
	if message.MediaUnavailableReason == groupMediaTooLargeReason {
		return message, errGroupMediaTooLarge
	}
	var payload []byte
	err = p.repos.DB().QueryRow(requestCtx, `UPDATE chat_group_media_recovery SET locked_until=NOW()+INTERVAL '45 seconds',attempted_at=NOW()
 WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND (locked_until IS NULL OR locked_until<NOW()) RETURNING payload`, accountID, chatID, message.ID).Scan(&payload)
	if err != nil {
		return nil, fmt.Errorf("el archivo no está disponible o ya se está recuperando")
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _ = p.repos.DB().Exec(cleanupCtx, `UPDATE chat_group_media_recovery SET locked_until=NULL WHERE account_id=$1 AND message_id=$2`, accountID, message.ID)
	}()
	var provider waE2E.Message
	if err = proto.Unmarshal(payload, &provider); err != nil {
		return nil, fmt.Errorf("metadatos del archivo no disponibles")
	}
	content, downloadErr := p.extractGroupMessageContent(requestCtx, instance, &provider, chat.JID, message.MessageID, message.IsViewOnce)
	if errors.Is(downloadErr, errGroupMediaTooLarge) {
		if err = p.repos.Message.MarkGroupMediaTooLarge(requestCtx, accountID, chatID, message.ID); err != nil {
			return nil, fmt.Errorf("no se pudo guardar el límite de este archivo")
		}
		message.MediaUnavailableReason = groupMediaTooLargeReason
		message.MediaRecoverable = false
		p.invalidateChatCaches(accountID, chatID)
		if p.hub != nil {
			p.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, "message_media_updated", map[string]interface{}{"chat_id": chatID, "device_id": deviceID, "message": message})
		}
		return message, errGroupMediaTooLarge
	}
	if errors.Is(downloadErr, errGroupMediaBusy) {
		return nil, errGroupMediaBusy
	}
	if content.MediaURL == nil {
		return nil, fmt.Errorf("WhatsApp no pudo recuperar este archivo. Puede haber caducado; puedes volver a intentarlo")
	}
	result, err := p.repos.DB().Exec(requestCtx, `UPDATE messages SET media_url=$4,media_asset_id=$5,media_size=$6,media_mimetype=COALESCE($7,media_mimetype),media_filename=COALESCE($8,media_filename)
 WHERE account_id=$1 AND chat_id=$2 AND id=$3 AND NOT media_deleted AND NOT COALESCE(is_revoked,FALSE) AND media_url IS NULL`, accountID, chatID, message.ID, content.MediaURL, content.MediaAssetID, content.MediaSize, content.MediaMimetype, content.MediaFilename)
	if err != nil || result.RowsAffected() == 0 {
		if content.MediaAssetID != nil {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = p.repos.Message.MarkRecoveredMediaOrphan(cleanupCtx, accountID, *content.MediaAssetID)
		}
		if err != nil {
			return nil, err
		}
	}
	_, _ = p.repos.DB().Exec(requestCtx, `DELETE FROM chat_group_media_recovery WHERE account_id=$1 AND message_id=$2 AND EXISTS(SELECT 1 FROM messages WHERE account_id=$1 AND id=$2 AND media_url IS NOT NULL)`, accountID, message.ID)
	message, err = p.repos.Message.GetByReference(requestCtx, accountID, chatID, message.ID.String())
	if err != nil {
		return nil, err
	}
	if message == nil || message.MediaURL == nil {
		return nil, fmt.Errorf("el mensaje cambió durante la recuperación")
	}
	p.invalidateChatCaches(accountID, chatID)
	if p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, "message_media_updated", map[string]interface{}{"chat_id": chatID, "device_id": deviceID, "message": message})
	}
	return message, nil
}

func recoverableGroupEventMedia(event *events.Message) *waE2E.Message {
	if event == nil || event.IsViewOnce {
		return nil
	}
	return recoverableGroupMedia(event.Message)
}
