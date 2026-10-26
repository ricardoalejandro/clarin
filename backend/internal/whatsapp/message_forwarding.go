package whatsapp

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
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

// buildNativeForward preserves the original native-only helper contract.
func buildNativeForward(source *domain.Message, media *PreUploadedMedia) (*waE2E.Message, domain.MessageForwarding, error) {
	return buildSharedMessage(source, media, domain.MessageSharingNative, domain.MessageContentOriginal)
}

// ForwardMessageWithID retains the native/original compatibility entry point.
func (p *DevicePool) ForwardMessageWithID(ctx context.Context, deviceID uuid.UUID, to string, source *domain.Message, providerID string) (*domain.Message, error) {
	return p.ShareMessageWithID(ctx, deviceID, to, source, providerID, domain.MessageSharingNative, domain.MessageContentOriginal)
}

// ShareMessageWithID sends once with a pre-reserved provider ID. Copy builds a
// normal new message; native forwarding retains its verified capability gate.
// A failure after the provider call is uncertain and never triggers a resend.
func (p *DevicePool) ShareMessageWithID(ctx context.Context, deviceID uuid.UUID, to string, source *domain.Message, providerID, mode, variant string) (*domain.Message, error) {
	mode, err := domain.NormalizeMessageSharingMode(mode)
	if err != nil {
		return nil, forwardFailure("share_mode_invalid", false, err)
	}
	variant, err = domain.NormalizeMessageContentVariant(variant)
	if err != nil {
		return nil, forwardFailure("share_variant_invalid", false, err)
	}
	if mode == domain.MessageSharingNative && !p.NativeForwardingEnabledForDevice(deviceID) {
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
	if source == nil || source.AccountID != instance.AccountID || strings.TrimSpace(providerID) == "" {
		return nil, forwardFailure("forward_source_invalid", false, fmt.Errorf("el origen del reenvío no pertenece al dispositivo"))
	}
	allowed, authorizationErr := p.repos.Message.MessageSharingDeviceAllowed(ctx, instance.AccountID, source.ChatID, deviceID, source, mode)
	if authorizationErr != nil || !allowed {
		return nil, forwardFailure("forward_source_invalid", false, fmt.Errorf("el origen no pertenece a la conexión verificada"))
	}
	available, availabilityErr := p.repos.Message.SharingSourceAvailable(ctx, instance.AccountID, source.ChatID, source)
	if availabilityErr != nil || !available {
		return nil, forwardFailure("forward_content_unavailable", false, fmt.Errorf("el contenido del mensaje ya no está disponible"))
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
	kind, uploadKind, err := sharedContentKinds(source, mode, variant)
	if err != nil {
		return nil, forwardFailure("forward_content_unavailable", false, err)
	}
	if mode == domain.MessageSharingNative {
		if _, err = domain.NextForwarding(*source); err != nil {
			return nil, err
		}
	}
	var media *PreUploadedMedia
	if kind != domain.MessageTypeText {
		if source.MediaURL == nil || strings.TrimSpace(*source.MediaURL) == "" {
			return nil, forwardFailure("forward_media_unavailable", false, fmt.Errorf("el archivo no está disponible"))
		}
		media, err = p.UploadMedia(ctx, deviceID, *source.MediaURL, uploadKind)
		if err != nil {
			return nil, forwardFailure("forward_media_unavailable", false, err)
		}
		if source.MediaFilename != nil {
			media.OriginalFilename = *source.MediaFilename
		}
		if variant == domain.MessageContentAudioDocument {
			media.Mimetype = sharedAudioDocumentMimetype(source, media)
			media.OriginalFilename = sharedAudioDocumentFilename(source, media)
		}
	}
	raw, forwarding, err := buildSharedMessage(source, media, mode, variant)
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
	allowed, authorizationErr = p.repos.Message.MessageSharingDeviceAllowed(ctx, instance.AccountID, source.ChatID, deviceID, freshSource, mode)
	if authorizationErr != nil || !allowed {
		return nil, forwardFailure("forward_source_changed", false, fmt.Errorf("la conexión del origen cambió durante la preparación"))
	}
	available, availabilityErr = p.repos.Message.SharingSourceAvailable(ctx, instance.AccountID, source.ChatID, freshSource)
	if availabilityErr != nil || !available {
		return nil, forwardFailure("forward_content_unavailable", false, fmt.Errorf("el contenido del mensaje cambió durante la preparación"))
	}
	currentTarget, targetErr := p.repos.Chat.GetByID(ctx, target.ID)
	if targetErr != nil || !sameNativeForwardTarget(target, currentTarget) {
		return nil, forwardFailure("forward_destination_changed", false, fmt.Errorf("el destino cambió durante la preparación; prepara el reenvío nuevamente"))
	}
	response, err := instance.Client.SendMessage(ctx, recipient, raw, whatsmeow.SendRequestExtra{ID: providerID})
	if err != nil {
		return nil, forwardFailure("forward_outcome_unknown", true, err)
	}
	if response.ID != providerID {
		return nil, forwardFailure("forward_outcome_unknown", true, fmt.Errorf("WhatsApp devolvió un identificador distinto del envío reservado"))
	}
	chat := currentTarget
	limits := sharedOutputLimits(source, forwarding)
	message := sharedMessageForPersistence(instance, chat, source, media, response.ID, response.Timestamp, forwarding, variant, limits)
	message, err = persistSharedMessage(ctx, p.repos.Message, message, limits)
	if err != nil {
		return nil, err
	}
	p.invalidateChatCaches(instance.AccountID, chat.ID)
	body := ""
	if message.Body != nil {
		body = *message.Body
	}
	if err = p.repos.Chat.UpdateLastMessage(ctx, instance.AccountID, chat.ID, body, response.Timestamp, false); err != nil {
		return nil, forwardFailure("forward_persistence_pending", true, err)
	}
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
	return expected != nil && current != nil && expected.DeviceID != nil && current.ContactID != nil && expected.ContactID != nil && current.ID == expected.ID && current.BindingRevision == expected.BindingRevision && current.BindingState == expected.BindingState && validNativeForwardTarget(current, expected.AccountID, *expected.DeviceID, expected.JID) && *current.ContactID == *expected.ContactID
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
