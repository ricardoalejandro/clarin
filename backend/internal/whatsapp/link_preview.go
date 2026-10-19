package whatsapp

import (
	"context"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
)

// Only the already-delivered ExtendedText payload is inspected. Do not fetch
// the URL, remote thumbnail path, favicon or embedded video metadata.
func receivedLinkPreview(message *waE2E.Message, viewOnce bool) (*domain.MessageLinkPreview, []byte) {
	message, wrappedViewOnce := unwrapGroupMedia(message)
	if message == nil || viewOnce || wrappedViewOnce {
		return nil, nil
	}
	extended := message.GetExtendedTextMessage()
	if extended == nil || extended.GetViewOnce() {
		return nil, nil
	}
	preview := domain.ReceivedMessageLinkPreview(extended.GetText(), extended.GetMatchedText(), extended.GetTitle(), extended.GetDescription())
	if preview == nil {
		return nil, nil
	}
	return preview, extended.GetJPEGThumbnail()
}

// ParseWebMessage unwraps MESSAGE_EDIT. Direct history has no durable edit
// ordering; do not enrich an original from this ambiguous edited projection.
// Group edits are processed separately through their ordered replay state.
func historyLinkPreviewAllowed(event *events.Message) bool {
	return event != nil && groupEventProtocol(event) == nil
}

func (p *DevicePool) attachReceivedLinkPreview(ctx context.Context, msg *domain.Message, message *waE2E.Message, viewOnce bool) {
	preview, thumbnail := receivedLinkPreview(message, viewOnce || msg.IsViewOnce)
	msg.LinkPreview, msg.LinkPreviewMediaAssetID = preview, nil
	if preview == nil || len(thumbnail) == 0 || len(thumbnail) > 1<<20 || p.storage == nil {
		return
	}
	url, asset, err := p.storeReceivedLinkPreviewThumbnail(ctx, msg.AccountID, thumbnail)
	if err == nil && asset != nil && url != "" {
		preview.ThumbnailURL = &url
		msg.LinkPreviewMediaAssetID = asset
	}
}

func (p *DevicePool) enrichReceivedLinkPreview(ctx context.Context, instance *DeviceInstance, msg *domain.Message) {
	updated, err := p.repos.Message.EnrichLinkPreview(ctx, msg)
	if err != nil || !updated {
		return
	}
	p.invalidateChatCaches(instance.AccountID, msg.ChatID)
	if p.hub != nil {
		p.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "message_link_preview_updated", map[string]any{
			"chat_id": msg.ChatID, "device_id": instance.ID, "message_id": msg.ID, "body_snapshot": msg.Body, "is_edited_snapshot": msg.IsEdited, "link_preview": msg.LinkPreview, "link_preview_version": msg.LinkPreviewVersion,
		})
	}
}
