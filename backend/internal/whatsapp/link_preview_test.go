package whatsapp

import (
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"testing"
)

func TestReceivedLinkPreviewOnlyUsesExtendedText(t *testing.T) {
	url := "https://example.test/path"
	extended := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("See " + url), MatchedText: proto.String(url), Title: proto.String("Provider title"), Description: proto.String("Provider description"), JPEGThumbnail: []byte{1, 2, 3}, ThumbnailDirectPath: proto.String("/must-not-download")}}
	for _, tc := range []struct {
		name           string
		message        *waE2E.Message
		viewOnce, want bool
	}{
		{"received", extended, false, true},
		{"ephemeral", &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: extended}}, false, true},
		{"plain", &waE2E.Message{Conversation: proto.String(url)}, false, false},
		{"view-once", &waE2E.Message{ViewOnceMessageV2: &waE2E.FutureProofMessage{Message: extended}}, false, false},
		{"unwrapped-view-once", extended, true, false},
		{"nil", nil, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			preview, thumbnail := receivedLinkPreview(tc.message, tc.viewOnce)
			if (preview != nil) != tc.want {
				t.Fatal("unexpected preview availability")
			}
			if tc.want && (preview.Title != "Provider title" || len(thumbnail) != 3) {
				t.Fatal("lost provider metadata")
			}
		})
	}
	event := (&events.Message{RawMessage: &waE2E.Message{ViewOnceMessageV2Extension: &waE2E.FutureProofMessage{Message: extended}}}).UnwrapRaw()
	if preview, _ := receivedLinkPreview(event.Message, event.IsViewOnce); preview != nil {
		t.Fatal("unwrapped view-once leaked preview")
	}
	extended.ExtendedTextMessage.ViewOnce = proto.Bool(true)
	if preview, _ := receivedLinkPreview(extended, false); preview != nil {
		t.Fatal("ExtendedText view-once leaked preview")
	}
	if !historyLinkPreviewAllowed(&events.Message{Message: extended}) {
		t.Fatal("ordinary history preview rejected")
	}
	edit := &events.Message{Message: extended, RawMessage: &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: proto.String("original")}, EditedMessage: extended}}}
	if historyLinkPreviewAllowed(edit) {
		t.Fatal("unwrapped historical edit could enrich original metadata")
	}
}
