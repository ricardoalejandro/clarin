package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// forwardingContent follows content wrappers, never a quoted payload. Presence
// of a supported complete envelope is required before declaring an original.
func forwardingContent(message *waE2E.Message) (*waE2E.Message, *waE2E.ContextInfo, bool) {
	editedWrapper := false
	for depth := 0; message != nil && depth < 8; depth++ {
		switch {
		case message.EphemeralMessage != nil:
			message = message.EphemeralMessage.Message
		case message.ViewOnceMessage != nil:
			message = message.ViewOnceMessage.Message
		case message.ViewOnceMessageV2 != nil:
			message = message.ViewOnceMessageV2.Message
		case message.ViewOnceMessageV2Extension != nil:
			message = message.ViewOnceMessageV2Extension.Message
		case message.DocumentWithCaptionMessage != nil:
			message = message.DocumentWithCaptionMessage.Message
		case message.EditedMessage != nil:
			editedWrapper = true
			message = message.EditedMessage.Message
		case message.DeviceSentMessage != nil:
			message = message.DeviceSentMessage.Message
		default:
			if editedWrapper {
				var info *waE2E.ContextInfo
				switch {
				case message.ExtendedTextMessage != nil:
					info = message.ExtendedTextMessage.ContextInfo
				case message.ImageMessage != nil:
					info = message.ImageMessage.ContextInfo
				case message.VideoMessage != nil:
					info = message.VideoMessage.ContextInfo
				case message.AudioMessage != nil:
					info = message.AudioMessage.ContextInfo
				case message.DocumentMessage != nil:
					info = message.DocumentMessage.ContextInfo
				case message.StickerMessage != nil:
					info = message.StickerMessage.ContextInfo
				}
				if info == nil || (!info.GetIsForwarded() && info.GetForwardingScore() == 0) {
					return message, nil, false
				}
			}
			switch {
			case message.Conversation != nil:
				return message, nil, true
			case message.ExtendedTextMessage != nil:
				return message, message.ExtendedTextMessage.ContextInfo, true
			case message.ImageMessage != nil:
				return message, message.ImageMessage.ContextInfo, true
			case message.VideoMessage != nil:
				return message, message.VideoMessage.ContextInfo, true
			case message.AudioMessage != nil:
				return message, message.AudioMessage.ContextInfo, true
			case message.DocumentMessage != nil:
				return message, message.DocumentMessage.ContextInfo, true
			case message.StickerMessage != nil:
				return message, message.StickerMessage.ContextInfo, true
			case message.ContactMessage != nil:
				return message, message.ContactMessage.ContextInfo, true
			case message.LocationMessage != nil:
				return message, message.LocationMessage.ContextInfo, true
			}
			return message, nil, false
		}
	}
	return nil, nil, false
}

func applyProviderForwarding(message *domain.Message, raw *waE2E.Message) {
	content, info, supported := forwardingContent(raw)
	var flag *bool
	var score *uint32
	if info != nil {
		flag, score = info.IsForwarded, info.ForwardingScore
	}
	message.Forwarding = domain.ClassifyProviderForwarding(flag, score, supported)
	message.ForwardingSource = "provider"
	if content != nil && content.AudioMessage != nil {
		message.AudioPTT = proto.Bool(content.AudioMessage.GetPTT())
	}
}

// whatsmeow unwraps edited messages before dispatch. Use the raw envelope, or
// retain its explicit edit flag, so a partial edit cannot invent an original.
func applyProviderEventForwarding(message *domain.Message, evt *events.Message) {
	if evt == nil {
		applyProviderForwarding(message, nil)
		return
	}
	raw := evt.RawMessage
	if raw == nil {
		raw = evt.Message
	}
	applyProviderForwarding(message, raw)
	if evt.IsEdit && message.Forwarding.State == domain.ForwardingNotForwarded {
		message.Forwarding = domain.MessageForwarding{State: domain.ForwardingUnknown}
	}
}

func originalForwarding() domain.MessageForwarding {
	return domain.ClassifyProviderForwarding(nil, nil, true)
}

// NewWhatsAppMessageID reserves the exact ID used for a durable forward target.
func (p *DevicePool) NewWhatsAppMessageID(deviceID uuid.UUID) (string, error) {
	instance := p.GetDevice(deviceID)
	if instance == nil || instance.Client == nil || !instance.Client.IsConnected() {
		return "", fmt.Errorf("el dispositivo no está conectado")
	}
	return instance.Client.GenerateMessageID(), nil
}

func forwardFailure(code string, attempted bool, err error) error {
	return &domain.ForwardSendError{Code: code, OutcomeUnknown: attempted, Err: err}
}

// buildNativeForward creates an allow-listed fresh envelope. No source quote,
// participant, chat ID, mention, or encrypted media key is copied blindly.
func buildNativeForward(source *domain.Message, media *PreUploadedMedia) (*waE2E.Message, domain.MessageForwarding, error) {
	if source == nil || source.IsRevoked || source.IsViewOnce || source.MediaDeleted || source.MediaUnavailableReason != "" {
		return nil, domain.MessageForwarding{}, fmt.Errorf("el contenido no se puede reenviar")
	}
	forwarding, err := domain.NextForwarding(*source)
	if err != nil {
		return nil, forwarding, err
	}
	kind := domain.MessageTypeText
	if source.MessageType != nil {
		kind = *source.MessageType
	}
	body := ""
	if source.Body != nil {
		body = *source.Body
	}
	info := &waE2E.ContextInfo{}
	if forwarding.State != domain.ForwardingNotForwarded {
		info.IsForwarded = proto.Bool(true)
		info.ForwardingScore = forwarding.Score
	}
	if kind == domain.MessageTypeText {
		return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(body), ContextInfo: info}}, forwarding, nil
	}
	if media == nil {
		return nil, forwarding, fmt.Errorf("el archivo no está disponible")
	}
	var message *waE2E.Message
	switch kind {
	case domain.MessageTypeImage:
		message = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, ContextInfo: info}}
	case domain.MessageTypeVideo, domain.MessageTypeGIF:
		message = &waE2E.Message{VideoMessage: &waE2E.VideoMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, GifPlayback: proto.Bool(kind == domain.MessageTypeGIF), ContextInfo: info}}
	case domain.MessageTypeAudio:
		if source.AudioPTT == nil {
			return nil, forwarding, fmt.Errorf("no se conoce si el audio original es una nota de voz")
		}
		message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, PTT: source.AudioPTT, ContextInfo: info}}
	case domain.MessageTypeDocument:
		filename := mediaDisplayFilename(media.OriginalFilename, media.OriginalURL)
		message = &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, FileName: &filename, ContextInfo: info}}
	case domain.MessageTypeSticker:
		if !media.StickerAnimationKnown {
			return nil, forwarding, fmt.Errorf("no se pudo verificar si el sticker original es animado")
		}
		message = &waE2E.Message{StickerMessage: &waE2E.StickerMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: proto.String("image/webp"), IsAnimated: proto.Bool(media.StickerAnimated), FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, ContextInfo: info}}
	default:
		return nil, forwarding, fmt.Errorf("este tipo de contenido todavía no admite reenvío nativo")
	}
	return message, forwarding, nil
}

// ForwardMessageWithID sends once with the pre-reserved provider ID. A failure
// after calling WhatsApp is uncertain and must never result in an automatic copy.
func (p *DevicePool) ForwardMessageWithID(ctx context.Context, deviceID uuid.UUID, to string, source *domain.Message, providerID string) (*domain.Message, error) {
	if !p.NativeForwardingEnabledForDevice(deviceID) {
		return nil, forwardFailure("forward_capability_unverified", false, fmt.Errorf("el reenvío nativo aún no está verificado para este dispositivo"))
	}
	ctx, release, err := p.retainDeviceOperation(ctx, uuid.Nil, deviceID)
	if err != nil {
		return nil, forwardFailure("device_unavailable", false, err)
	}
	defer release()
	instance := p.GetDevice(deviceID)
	if instance == nil || instance.Client == nil || !instance.Client.IsConnected() {
		return nil, forwardFailure("device_unavailable", false, fmt.Errorf("el dispositivo no está conectado"))
	}
	if source == nil || source.AccountID != instance.AccountID || source.DeviceID == nil || *source.DeviceID != deviceID || strings.TrimSpace(providerID) == "" {
		return nil, forwardFailure("forward_source_invalid", false, fmt.Errorf("el origen del reenvío no pertenece al dispositivo"))
	}
	recipient, err := types.ParseJID(to)
	if err != nil || recipient.IsEmpty() || (recipient.Server != types.DefaultUserServer && recipient.Server != types.HiddenUserServer && recipient.Server != types.GroupServer) {
		return nil, forwardFailure("recipient_invalid", false, fmt.Errorf("destinatario no válido"))
	}
	if err = p.ensureOutboundAllowed(ctx, instance, recipient); err != nil {
		return nil, forwardFailure("recipient_unavailable", false, err)
	}
	// Forwarding operates on an existing canonical destination. It must never
	// create a Contact/chat or move the sender back after a concurrent change.
	var target *domain.Chat
	if send, ok := domain.MessageSendContextFrom(ctx); ok && send.ChatID != uuid.Nil {
		if send.AccountID != instance.AccountID {
			return nil, forwardFailure("forward_destination_changed", false, fmt.Errorf("el contexto del destino cambió"))
		}
		target, err = p.repos.Chat.GetByID(ctx, send.ChatID)
	} else {
		target, err = p.repos.Chat.FindByDeviceJID(ctx, instance.AccountID, deviceID, recipient.ToNonAD().String())
	}
	if err != nil || !validNativeForwardTarget(target, instance.AccountID, deviceID, recipient.ToNonAD().String()) {
		return nil, forwardFailure("forward_destination_changed", false, fmt.Errorf("el destino ya no está disponible en este dispositivo"))
	}
	if _, err = domain.NextForwarding(*source); err != nil {
		return nil, err
	}
	kind := domain.MessageTypeText
	if source.MessageType != nil {
		kind = *source.MessageType
	}
	var media *PreUploadedMedia
	if kind != domain.MessageTypeText {
		if source.MediaURL == nil || *source.MediaURL == "" {
			return nil, forwardFailure("forward_media_unavailable", false, fmt.Errorf("el archivo no está disponible"))
		}
		// Reject unsupported content before any provider upload.
		switch kind {
		case domain.MessageTypeImage, domain.MessageTypeVideo, domain.MessageTypeGIF, domain.MessageTypeAudio, domain.MessageTypeDocument, domain.MessageTypeSticker:
		default:
			return nil, forwardFailure("forward_type_unsupported", false, fmt.Errorf("este tipo todavía no admite reenvío nativo"))
		}
		if source.IsRevoked || source.IsViewOnce || source.MediaDeleted || source.MediaUnavailableReason != "" || (kind == domain.MessageTypeAudio && source.AudioPTT == nil) {
			return nil, forwardFailure("forward_media_unavailable", false, fmt.Errorf("no se puede conservar el contenido original"))
		}
		media, err = p.UploadMedia(ctx, deviceID, *source.MediaURL, kind)
		if err != nil {
			return nil, forwardFailure("forward_media_unavailable", false, err)
		}
		if source.MediaFilename != nil {
			media.OriginalFilename = *source.MediaFilename
		}
	}
	raw, forwarding, err := buildNativeForward(source, media)
	if err != nil {
		return nil, forwardFailure("forward_content_unavailable", false, err)
	}
	// Media preparation may outlive the earlier group membership/admin check.
	// Obtain fresh provider permission before the final source/target checks.
	ctx, err = refreshNativeForwardGroup(ctx, instance.AccountID, deviceID, target, p.PrepareGroupSend)
	if err != nil {
		return nil, err
	}
	if err = p.ensureOutboundAllowed(ctx, instance, recipient); err != nil {
		return nil, forwardFailure("recipient_unavailable", false, err)
	}
	freshSource, lookupErr := p.repos.Message.GetByReference(ctx, instance.AccountID, source.ChatID, source.ID.String())
	if lookupErr != nil || !sameNativeForwardSource(source, freshSource) {
		return nil, forwardFailure("forward_source_changed", false, fmt.Errorf("el mensaje original cambió durante la preparación; prepara el reenvío nuevamente"))
	}
	currentTarget, targetErr := p.repos.Chat.GetByID(ctx, target.ID)
	if targetErr != nil || !sameNativeForwardTarget(target, currentTarget) {
		return nil, forwardFailure("forward_destination_changed", false, fmt.Errorf("el destino cambió durante la preparación; prepara el reenvío nuevamente"))
	}
	response, err := instance.Client.SendMessage(ctx, recipient, raw, whatsmeow.SendRequestExtra{ID: providerID})
	if err != nil {
		return nil, forwardFailure("forward_outcome_unknown", true, err)
	}
	chat := currentTarget
	message := &domain.Message{AccountID: instance.AccountID, DeviceID: &instance.ID, ChatID: chat.ID, MessageID: response.ID, FromJID: strPtr(instance.JID), FromName: strPtr("Me"), Body: source.Body, MessageType: source.MessageType, MediaURL: source.MediaURL, MediaMimetype: source.MediaMimetype, MediaFilename: source.MediaFilename, MediaSize: source.MediaSize, MediaAssetID: source.MediaAssetID, AudioPTT: source.AudioPTT, IsFromMe: true, Status: strPtr("sent"), Timestamp: response.Timestamp, Forwarding: forwarding, ForwardingSource: "clarin", Provider: strPtr(domain.DeviceProviderWhatsAppWeb)}
	if err = p.repos.Message.Create(ctx, message); err != nil {
		// Our own synchronized echo may have persisted first. A matching durable
		// provider ID confirms the same physical send, not another outbound attempt.
		if errors.Is(err, pgx.ErrNoRows) {
			existing, lookupErr := p.repos.Message.GetByMessageID(ctx, chat.ID, response.ID)
			if lookupErr == nil && existing.AccountID == instance.AccountID && existing.DeviceID != nil && *existing.DeviceID == deviceID && existing.IsFromMe {
				message = existing
				err = nil
			}
		}
		if err != nil {
			return nil, forwardFailure("forward_persistence_pending", true, err)
		}
	}
	p.invalidateChatCaches(instance.AccountID, chat.ID)
	body := ""
	if message.Body != nil {
		body = *message.Body
	}
	_ = p.repos.Chat.UpdateLastMessage(ctx, instance.AccountID, chat.ID, body, response.Timestamp, false)
	if p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, ws.EventMessageSent, map[string]interface{}{"chat_id": chat.ID.String(), "device_id": deviceID, "message": message})
	}
	return message, nil
}

// Duplicate/history projections may enrich an existing message's forwarding
// truth. Emit the canonical row, without changing attention or insertion order.
func (p *DevicePool) broadcastForwardingHydration(ctx context.Context, instance *DeviceInstance, incoming *domain.Message) {
	if incoming == nil || !incoming.ForwardingHydrated || p.hub == nil {
		return
	}
	canonical, err := p.repos.Message.GetByMessageID(ctx, incoming.ChatID, incoming.MessageID)
	if err != nil || canonical.AccountID != instance.AccountID {
		return
	}
	p.invalidateChatCaches(instance.AccountID, incoming.ChatID)
	p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "message_media_updated", map[string]interface{}{"chat_id": incoming.ChatID, "device_id": instance.ID, "message": canonical})
}

func sameNativeForwardSource(expected, current *domain.Message) bool {
	return expected != nil && current != nil && domain.MessageForwardFingerprint(expected) == domain.MessageForwardFingerprint(current)
}

// NativeForwardingEnabledForDevice allows a provider rollout to be limited to
// explicitly verified devices. It never grants account ownership or send access.
func (p *DevicePool) NativeForwardingEnabledForDevice(deviceID uuid.UUID) bool {
	if p == nil || p.cfg == nil || !p.cfg.WhatsAppNativeForwardingEnabled || deviceID == uuid.Nil {
		return false
	}
	allow := strings.TrimSpace(p.cfg.WhatsAppNativeForwardingDeviceIDs)
	if allow == "" {
		return true
	}
	for _, raw := range strings.Split(allow, ",") {
		if id, err := uuid.Parse(strings.TrimSpace(raw)); err == nil && id == deviceID {
			return true
		}
	}
	return false
}

func validNativeForwardTarget(target *domain.Chat, accountID, deviceID uuid.UUID, jid string) bool {
	return target != nil && target.ID != uuid.Nil && target.AccountID == accountID && target.DeviceID != nil && *target.DeviceID == deviceID && target.ContactID != nil && *target.ContactID != uuid.Nil && target.JID == jid
}
func sameNativeForwardTarget(expected, current *domain.Chat) bool {
	return expected != nil && current != nil && expected.DeviceID != nil && current.ContactID != nil && expected.ContactID != nil && current.ID == expected.ID && validNativeForwardTarget(current, expected.AccountID, *expected.DeviceID, expected.JID) && *current.ContactID == *expected.ContactID
}

// Only group destinations need a renewed remote membership/admin snapshot;
// private destinations retain their own canonical suppression checks.
func refreshNativeForwardGroup(ctx context.Context, accountID, deviceID uuid.UUID, target *domain.Chat, verify func(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string, []domain.MessageMention, bool) (context.Context, error)) (context.Context, error) {
	if target == nil || !validNativeForwardTarget(target, accountID, deviceID, target.JID) {
		return ctx, forwardFailure("forward_destination_changed", false, fmt.Errorf("el destino cambió durante la preparación"))
	}
	if !domain.IsGroupJID(target.JID) {
		return ctx, nil
	}
	updated, err := verify(ctx, accountID, deviceID, target.ID, target.JID, nil, true)
	if err != nil {
		return ctx, forwardFailure("recipient_unavailable", false, err)
	}
	return updated, nil
}
