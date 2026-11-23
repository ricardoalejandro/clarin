package api

import (
	"errors"
	"fmt"
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/whatsapp"
	"google.golang.org/protobuf/proto"
)

func TestAudioSendErrorsAreSafeAndActionable(t *testing.T) {
	for _, item := range []struct {
		code   string
		status int
	}{{"audio_caption_unsupported", 422}, {"audio_invalid", 422}, {"audio_codec_unsupported", 422}, {"audio_voice_codec_unsupported", 422}, {"audio_preparation_timeout", 503}, {"audio_processor_unavailable", 503}} {
		err := fmt.Errorf("wrapped: %w", &whatsapp.AudioPreparationError{Code: item.code, Message: "Safe message"})
		status, code, message, ok := audioSendError(err)
		if !ok || status != item.status || code != item.code || message != "Safe message" {
			t.Fatal("audio error mapping changed", status, code, message, ok)
		}
	}
	if _, _, _, ok := audioSendError(errors.New("unrelated provider error")); ok {
		t.Fatal("non-audio error reclassified")
	}
}
func TestSharedAudioCaptionRequiresExplicitDocument(t *testing.T) {
	source := &domain.Message{Body: proto.String("Keep this text"), MessageType: proto.String(domain.MessageTypeAudio), MediaURL: proto.String("/api/media/file/synthetic"), AudioPTT: proto.Bool(false), Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}}
	for _, mode := range []string{domain.MessageSharingCopy, domain.MessageSharingNative} {
		err := validateMessageSharingSource(source, mode, domain.MessageContentOriginal)
		var typed *forwardBatchError
		if !errors.As(err, &typed) || typed.status != 422 || typed.code != "audio_caption_unsupported" {
			t.Fatal("caption silently dropped", err)
		}
	}
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err != nil {
		t.Fatal("explicit document lost caption path", err)
	}
	for _, code := range []string{"audio_caption_unsupported", "audio_invalid", "audio_codec_unsupported", "audio_voice_codec_unsupported"} {
		if forwardTypedFailureRetry(code) {
			t.Fatal("invalid preparation can retry blindly", code)
		}
	}
	for _, code := range []string{"audio_processor_unavailable", "audio_preparation_timeout"} {
		if !forwardTypedFailureRetry(code) {
			t.Fatal("known pre-send transient failure lost explicit retry", code)
		}
	}
}
