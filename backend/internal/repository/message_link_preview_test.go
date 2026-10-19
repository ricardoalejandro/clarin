package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"testing"
)

func TestMessageLinkPreviewObjectKey(t *testing.T) {
	account := uuid.New()
	prefix := account.String() + "/link-previews/"
	hash := strings.Repeat("a", 64)
	for _, key := range []string{prefix + hash + ".jpg", prefix + hash + "-" + uuid.NewString() + ".jpg"} {
		if !validLinkPreviewObjectKey(account, key) {
			t.Fatal("valid owned preview key rejected")
		}
	}
	for _, key := range []string{prefix + "../photo.jpg", prefix + hash + ".jpg?external=1", prefix + hash + "/other.jpg", uuid.NewString() + "/link-previews/" + hash + ".jpg", prefix + hash + ".svg", prefix + hash + "-invalid.jpg"} {
		if validLinkPreviewObjectKey(account, key) {
			t.Fatal("unsafe or foreign preview key accepted")
		}
	}
}

func TestMessageLinkPreviewNeverEnrichesEditedSnapshots(t *testing.T) {
	device := uuid.New()
	body := "https://example.test/"
	sender := "51999000111@s.whatsapp.net"
	message := &domain.Message{AccountID: uuid.New(), ChatID: uuid.New(), DeviceID: &device, FromJID: &sender, Body: &body, IsEdited: true, LinkPreview: domain.ReceivedMessageLinkPreview(body, body, "Old snapshot", "")}
	// A nil DB proves rejection occurs before any historical lookup or write.
	changed, err := (&MessageRepository{}).EnrichLinkPreview(context.Background(), message)
	if err != nil || changed {
		t.Fatal("edited provider snapshot was eligible for enrichment", err)
	}
}

func TestMessageLinkPreviewRemovedReplayGuard(t *testing.T) {
	for _, required := range []string{"rr.account_id=$1", "source.source_id=rr.snapshot->>'source_id'", "source.slot=rr.snapshot->>'slot'", "rr.adapter='link_preview'", "'removed','purging','purged'", "rr.snapshot->'after'->>'body'=$4", "(rr.snapshot->'after'->'preview')-'thumbnail_url'"} {
		if !strings.Contains(removedLinkPreviewReplaySQL, required) {
			t.Fatalf("removed preview replay lost guard %s", required)
		}
	}
	body := "https://example.test/"
	thumbnail := "/api/media/file/synthetic"
	asset := uuid.New()
	msg := &domain.Message{Body: &body, LinkPreview: &domain.MessageLinkPreview{URL: body, Title: "Keep title", Description: "Keep description", ThumbnailURL: &thumbnail}, LinkPreviewMediaAssetID: &asset}
	clearLinkPreviewThumbnail(msg)
	if msg.LinkPreview == nil || msg.LinkPreview.URL != body || msg.LinkPreview.Title != "Keep title" || msg.LinkPreview.Description != "Keep description" || msg.LinkPreview.ThumbnailURL != nil || msg.LinkPreviewMediaAssetID != nil || *msg.Body != body {
		t.Fatal("retirement changed content beyond the thumbnail")
	}
	// Text-only metadata does not need a removal lookup or an active DB handle.
	if removed, err := removedLinkPreviewReplayTx(context.Background(), nil, uuid.New(), uuid.New(), "synthetic", msg, false); err != nil || removed {
		t.Fatal("metadata-only edit consulted thumbnail removals")
	}
}
