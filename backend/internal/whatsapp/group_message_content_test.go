package whatsapp

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestGroupMessageContentSeparatesTransportFromUserPayload(t *testing.T) {
	pool := &DevicePool{}
	key := &waE2E.SenderKeyDistributionMessage{AxolotlSenderKeyDistributionMessage: []byte{1}}
	for _, test := range []struct {
		name    string
		message *waE2E.Message
		want    bool
	}{
		{"nil", nil, false},
		{"sender_key_only", &waE2E.Message{SenderKeyDistributionMessage: key}, false},
		{"context_only", &waE2E.Message{MessageContextInfo: &waE2E.MessageContextInfo{MessageSecret: []byte{1}}}, false},
		{"empty_text", &waE2E.Message{Conversation: proto.String("")}, false},
		{"sender_key_and_text", &waE2E.Message{SenderKeyDistributionMessage: key, Conversation: proto.String("Visible")}, true},
		{"extended_text", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("Visible")}}, true},
		{"ephemeral_text", &waE2E.Message{EphemeralMessage: &waE2E.FutureProofMessage{Message: &waE2E.Message{Conversation: proto.String("Visible")}}}, true},
		{"image_without_caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}, true},
		{"audio_without_caption", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}, true},
		{"document_without_caption", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{}}, true},
		{"reaction", &waE2E.Message{ReactionMessage: &waE2E.ReactionMessage{}}, true},
		{"poll", &waE2E.Message{PollCreationMessage: &waE2E.PollCreationMessage{}}, true},
		{"protocol", &waE2E.Message{ProtocolMessage: &waE2E.ProtocolMessage{}}, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := pool.groupMessageHasContent(context.Background(), &events.Message{Message: test.message}); got != test.want {
				t.Fatalf("has content=%v, want %v", got, test.want)
			}
		})
	}
}
