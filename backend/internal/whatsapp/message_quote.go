package whatsapp

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

func quoteContext(message *waE2E.Message) *waE2E.ContextInfo {
	// Bound wrapper traversal even for malformed provider payloads.
	for depth := 0; message != nil && depth < 8; depth++ {
		switch {
		case message.GetEphemeralMessage() != nil:
			message = message.GetEphemeralMessage().GetMessage()
		case message.GetViewOnceMessage() != nil:
			message = message.GetViewOnceMessage().GetMessage()
		case message.GetViewOnceMessageV2() != nil:
			message = message.GetViewOnceMessageV2().GetMessage()
		case message.GetDocumentWithCaptionMessage() != nil:
			message = message.GetDocumentWithCaptionMessage().GetMessage()
		default:
			contexts := []*waE2E.ContextInfo{message.GetExtendedTextMessage().GetContextInfo(), message.GetImageMessage().GetContextInfo(), message.GetVideoMessage().GetContextInfo(), message.GetAudioMessage().GetContextInfo(), message.GetDocumentMessage().GetContextInfo(), message.GetStickerMessage().GetContextInfo()}
			for _, info := range contexts {
				if info.GetStanzaID() != "" {
					return info
				}
			}
			return nil
		}
	}
	return nil
}

func nonemptyQuote(value string) *string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return &value
}

func extractQuote(message *waE2E.Message, ownJID string, original *domain.Message, ownAliases ...string) domain.MessageQuote {
	info := quoteContext(message)
	if info == nil {
		return domain.MessageQuote{}
	}
	quote := domain.MessageQuote{MessageID: nonemptyQuote(info.GetStanzaID()), Sender: nonemptyQuote(info.GetParticipant())}
	if quoted := info.GetQuotedMessage(); quoted != nil {
		switch {
		case quoted.GetConversation() != "":
			quote.Body = nonemptyQuote(quoted.GetConversation())
		case quoted.GetExtendedTextMessage() != nil:
			quote.Body = nonemptyQuote(quoted.GetExtendedTextMessage().GetText())
		case quoted.GetImageMessage() != nil:
			quote.Body = nonemptyQuote(quoted.GetImageMessage().GetCaption())
			if quote.Body == nil {
				quote.Body = strPtr("📷 Imagen")
			}
		case quoted.GetVideoMessage() != nil:
			quote.Body = nonemptyQuote(quoted.GetVideoMessage().GetCaption())
			if quote.Body == nil {
				quote.Body = strPtr("🎥 Video")
			}
		case quoted.GetDocumentMessage() != nil:
			quote.Body = nonemptyQuote(quoted.GetDocumentMessage().GetFileName())
			if quote.Body == nil {
				quote.Body = strPtr("📄 Documento")
			}
		case quoted.GetAudioMessage() != nil:
			quote.Body = strPtr("🎵 Audio")
		case quoted.GetStickerMessage() != nil:
			quote.Body = strPtr("Sticker")
		}
	}
	if original != nil {
		quote.IsFromMe = boolPtr(original.IsFromMe)
		if original.FromJID != nil && strings.TrimSpace(*original.FromJID) != "" {
			quote.Sender = original.FromJID
		} else if original.FromName != nil && strings.TrimSpace(*original.FromName) != "" {
			quote.Sender = original.FromName
		}
		if original.Body != nil && strings.TrimSpace(*original.Body) != "" {
			quote.Body = original.Body
		} else if original.MediaFilename != nil && strings.TrimSpace(*original.MediaFilename) != "" {
			quote.Body = original.MediaFilename
		}
	} else if quote.Sender != nil {
		if sender, err := types.ParseJID(*quote.Sender); err == nil && !sender.IsEmpty() {
			comparable := false
			for _, candidate := range append([]string{ownJID}, ownAliases...) {
				own, err := types.ParseJID(candidate)
				if err != nil || own.IsEmpty() || sender.Server != own.Server {
					continue
				}
				comparable = true
				if sender.ToNonAD().String() == own.ToNonAD().String() {
					quote.IsFromMe = boolPtr(true)
					break
				}
			}
			if comparable && quote.IsFromMe == nil {
				quote.IsFromMe = boolPtr(false)
			}
		}
	}
	return quote
}

func (p *DevicePool) extractMessageQuote(ctx context.Context, instance *DeviceInstance, chatID uuid.UUID, message *waE2E.Message) domain.MessageQuote {
	info := quoteContext(message)
	if info == nil {
		return domain.MessageQuote{}
	}
	original, _ := p.repos.Message.GetByReference(ctx, instance.AccountID, chatID, info.GetStanzaID())
	ownJID := ""
	ownLID := ""
	if instance.Client != nil && instance.Client.Store != nil && instance.Client.Store.ID != nil {
		ownJID = instance.Client.Store.ID.String()
		ownLID = instance.Client.Store.LID.String()
	}
	return extractQuote(message, ownJID, original, ownLID)
}
