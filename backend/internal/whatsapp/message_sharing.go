package whatsapp

import (
	"context"
	"errors"
	"fmt"
	"mime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

// sharedContentKinds validates content before any media upload. Sharing mode
// changes provenance only; it never makes unavailable/private content usable.
func sharedContentKinds(source *domain.Message, mode, variant string) (string, string, error) {
	if source == nil || source.IsRevoked || source.IsViewOnce || source.MediaDeleted || source.MediaUnavailableReason != "" || source.MediaRecoverable {
		return "", "", fmt.Errorf("el contenido no está disponible para compartir")
	}
	if mode != domain.MessageSharingCopy && mode != domain.MessageSharingNative {
		return "", "", fmt.Errorf("modo de envío no válido")
	}
	if variant != domain.MessageContentOriginal && variant != domain.MessageContentAudioDocument {
		return "", "", fmt.Errorf("formato de contenido no válido")
	}
	kind := domain.MessageTypeText
	if source.MessageType != nil {
		kind = *source.MessageType
	}
	if variant == domain.MessageContentAudioDocument && (mode != domain.MessageSharingCopy || kind != domain.MessageTypeAudio) {
		return "", "", fmt.Errorf("solo un audio enviado como nuevo puede compartirse como archivo")
	}
	switch kind {
	case domain.MessageTypeText:
		if source.Body == nil || strings.TrimSpace(*source.Body) == "" {
			return "", "", fmt.Errorf("el mensaje de texto está vacío")
		}
	case domain.MessageTypeImage, domain.MessageTypeVideo, domain.MessageTypeGIF, domain.MessageTypeDocument, domain.MessageTypeSticker:
	case domain.MessageTypeAudio:
		if source.AudioPTT == nil && variant != domain.MessageContentAudioDocument {
			return "", "", fmt.Errorf("no se conoce si el audio original es una nota de voz; puedes enviarlo como archivo")
		}
	default:
		return "", "", fmt.Errorf("este tipo de contenido todavía no admite compartir")
	}
	uploadKind := kind
	if variant == domain.MessageContentAudioDocument {
		uploadKind = domain.MessageTypeDocument
	}
	return kind, uploadKind, nil
}

// buildSharedMessage creates a new allow-listed envelope for both modes. It
// never copies source IDs, quotes, mentions, previews or encrypted media keys.
func buildSharedMessage(source *domain.Message, media *PreUploadedMedia, mode, variant string) (*waE2E.Message, domain.MessageForwarding, error) {
	kind, _, err := sharedContentKinds(source, mode, variant)
	if err != nil {
		return nil, domain.MessageForwarding{}, err
	}
	forwarding := originalForwarding()
	if mode == domain.MessageSharingNative {
		forwarding, err = domain.NextForwarding(*source)
		if err != nil {
			return nil, forwarding, err
		}
	}
	info := &waE2E.ContextInfo{}
	if forwarding.State != domain.ForwardingNotForwarded {
		info.IsForwarded = proto.Bool(true)
		info.ForwardingScore = forwarding.Score
	}
	body := ""
	if source.Body != nil {
		body = *source.Body
	}
	if kind == domain.MessageTypeText {
		return &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String(body), ContextInfo: info}}, forwarding, nil
	}
	if media == nil {
		return nil, forwarding, fmt.Errorf("el archivo no está disponible")
	}
	if variant == domain.MessageContentAudioDocument {
		kind = domain.MessageTypeDocument
	}
	var message *waE2E.Message
	switch kind {
	case domain.MessageTypeImage:
		message = &waE2E.Message{ImageMessage: &waE2E.ImageMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, ContextInfo: info}}
	case domain.MessageTypeVideo, domain.MessageTypeGIF:
		message = &waE2E.Message{VideoMessage: &waE2E.VideoMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, GifPlayback: proto.Bool(kind == domain.MessageTypeGIF), ContextInfo: info}}
	case domain.MessageTypeAudio:
		message = &waE2E.Message{AudioMessage: &waE2E.AudioMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &media.Mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, PTT: source.AudioPTT, ContextInfo: info}}
	case domain.MessageTypeDocument:
		filename := mediaDisplayFilename(media.OriginalFilename, media.OriginalURL)
		mimetype := media.Mimetype
		if variant == domain.MessageContentAudioDocument {
			filename = sharedAudioDocumentFilename(source, media)
			mimetype = sharedAudioDocumentMimetype(source, media)
		}
		message = &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: &mimetype, FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, Caption: &body, FileName: &filename, ContextInfo: info}}
	case domain.MessageTypeSticker:
		if !media.StickerAnimationKnown {
			return nil, forwarding, fmt.Errorf("no se pudo verificar si el sticker original es animado")
		}
		message = &waE2E.Message{StickerMessage: &waE2E.StickerMessage{URL: &media.URL, DirectPath: &media.DirectPath, MediaKey: media.MediaKey, Mimetype: proto.String("image/webp"), IsAnimated: proto.Bool(media.StickerAnimated), FileEncSHA256: media.FileEncSHA256, FileSHA256: media.FileSHA256, FileLength: &media.FileLength, ContextInfo: info}}
	}
	return message, forwarding, nil
}

func sharedAudioDocumentMimetype(source *domain.Message, media *PreUploadedMedia) string {
	if source != nil && source.MediaMimetype != nil {
		if parsed, _, err := mime.ParseMediaType(*source.MediaMimetype); err == nil && strings.HasPrefix(parsed, "audio/") {
			return *source.MediaMimetype
		}
	}
	if media != nil {
		if media.OriginalMimetype != "" {
			return media.OriginalMimetype
		}
		return media.Mimetype
	}
	return "application/octet-stream"
}

func sharedAudioDocumentFilename(source *domain.Message, media *PreUploadedMedia) string {
	preferred := ""
	if source != nil && source.MediaFilename != nil {
		preferred = strings.TrimSpace(*source.MediaFilename)
	}
	if preferred == "" && media != nil {
		preferred = strings.TrimSpace(media.OriginalFilename)
	}
	if preferred != "" {
		return mediaDisplayFilename(preferred, "")
	}
	// A storage object key is not a useful filename. This deterministic name
	// uses the actual original audio format and does not disclose source IDs.
	parsed, _, _ := mime.ParseMediaType(sharedAudioDocumentMimetype(source, media))
	ext := ".bin"
	switch strings.ToLower(parsed) {
	case "audio/ogg", "application/ogg":
		ext = ".ogg"
	case "audio/mpeg":
		ext = ".mp3"
	case "audio/mp4", "audio/x-m4a":
		ext = ".m4a"
	case "audio/aac":
		ext = ".aac"
	case "audio/wav", "audio/x-wav", "audio/vnd.wave":
		ext = ".wav"
	case "audio/webm":
		ext = ".webm"
	case "audio/flac", "audio/x-flac":
		ext = ".flac"
	}
	return "audio" + ext
}

// Native forwarding may strengthen policy itself (score 0→1 or 4→5).
// Keep that result separate from provider flags, including on incomplete echoes.
func sharedOutputLimits(source *domain.Message, forwarding domain.MessageForwarding) domain.MessageSharingLimits {
	inherited := domain.EffectiveMessageSharingLimits(source)
	return domain.EffectiveMessageSharingLimits(&domain.Message{Forwarding: forwarding, SharingLimits: &inherited})
}

func sharedMessageForPersistence(instance *DeviceInstance, chat *domain.Chat, source *domain.Message, media *PreUploadedMedia, providerID string, sentAt time.Time, forwarding domain.MessageForwarding, variant string, limits domain.MessageSharingLimits) *domain.Message {
	message := &domain.Message{AccountID: instance.AccountID, DeviceID: &instance.ID, ChatID: chat.ID, MessageID: providerID, FromJID: strPtr(instance.JID), FromName: strPtr("Me"), Body: source.Body, MessageType: source.MessageType, MediaURL: source.MediaURL, MediaMimetype: source.MediaMimetype, MediaFilename: source.MediaFilename, MediaSize: source.MediaSize, MediaAssetID: source.MediaAssetID, AudioPTT: source.AudioPTT, IsFromMe: true, Status: strPtr("sent"), Timestamp: sentAt, Forwarding: forwarding, ForwardingSource: "clarin", Provider: strPtr(domain.DeviceProviderWhatsAppWeb), SharingLimits: &limits}
	if variant == domain.MessageContentAudioDocument {
		message.MessageType = strPtr(domain.MessageTypeDocument)
		message.AudioPTT = nil
		message.MediaMimetype = strPtr(sharedAudioDocumentMimetype(source, media))
		message.MediaFilename = strPtr(sharedAudioDocumentFilename(source, media))
	}
	return message
}

// This boundary owns both persistence races after the physical provider send.
// No error here can be reported as safe to resend with a new provider ID.
type sharedMessageStore interface {
	Create(context.Context, *domain.Message) error
	GetByMessageID(context.Context, uuid.UUID, string) (*domain.Message, error)
	MergeMessageSharingLimits(context.Context, uuid.UUID, uuid.UUID, uuid.UUID, string, domain.MessageSharingLimits) (*domain.Message, error)
}

func sameSharedPersistedMessage(expected, current *domain.Message) bool {
	return expected != nil && current != nil && expected.DeviceID != nil && current.DeviceID != nil && current.AccountID == expected.AccountID && *current.DeviceID == *expected.DeviceID && current.ChatID == expected.ChatID && current.MessageID == expected.MessageID && current.IsFromMe
}

func persistSharedMessage(ctx context.Context, store sharedMessageStore, message *domain.Message, limits domain.MessageSharingLimits) (*domain.Message, error) {
	if err := store.Create(ctx, message); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// Our synchronized echo may already own the same reserved provider ID.
			existing, lookupErr := store.GetByMessageID(ctx, message.ChatID, message.MessageID)
			if lookupErr != nil || !sameSharedPersistedMessage(message, existing) {
				return nil, forwardFailure("forward_persistence_pending", true, err)
			}
		} else {
			return nil, forwardFailure("forward_persistence_pending", true, err)
		}
	}
	canonical, err := store.MergeMessageSharingLimits(ctx, message.AccountID, *message.DeviceID, message.ChatID, message.MessageID, limits)
	if err != nil || !sameSharedPersistedMessage(message, canonical) {
		if err == nil {
			err = fmt.Errorf("no se pudo confirmar el mensaje compartido")
		}
		return nil, forwardFailure("forward_persistence_pending", true, err)
	}
	return canonical, nil
}
