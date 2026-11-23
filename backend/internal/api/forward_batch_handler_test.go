package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestForwardBatchRequestCanonicalAndBounded(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	req := forwardBatchRequest{SourceChatID: uuid.New(), SourceMessageID: uuid.New(), DeviceID: uuid.New(), DestinationChatIDs: []uuid.UUID{a, b}, ClientOperationID: uuid.New()}
	_, first, err := canonicalForwardRequest(req)
	if err != nil {
		t.Fatal(err)
	}
	req.DestinationChatIDs = []uuid.UUID{b, a}
	_, second, err := canonicalForwardRequest(req)
	if err != nil || first != second {
		t.Fatal("destination order changed idempotency")
	}
	req.DestinationChatIDs = []uuid.UUID{a, a}
	if _, _, err = canonicalForwardRequest(req); err == nil {
		t.Fatal("duplicate targets accepted")
	}
	req.DestinationChatIDs = make([]uuid.UUID, 6)
	if _, _, err = canonicalForwardRequest(req); err == nil {
		t.Fatal("unbounded targets accepted")
	}
}
func TestForwardBatchSourceHonestTypes(t *testing.T) {
	score := uint32(0)
	body := "Synthetic"
	kind := "text"
	m := &domain.Message{Body: &body, MessageType: &kind, Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded, Score: &score}}
	if err := validateForwardSource(m); err != nil {
		t.Fatal(err)
	}
	m.MessageType = nil
	if err := validateForwardSource(m); err != nil {
		t.Fatal("nil message type must be canonical text", err)
	}
	m.MessageType = &kind
	m.Forwarding = domain.MessageForwarding{}
	if err := validateForwardSource(m); err == nil {
		t.Fatal("legacy source accepted")
	}
	m.Forwarding = domain.MessageForwarding{State: domain.ForwardingNotForwarded}
	kind = "poll"
	if err := validateForwardSource(m); err == nil {
		t.Fatal("poll forwarding exposed")
	}
	kind = "audio"
	m.MediaURL = &body
	if err := validateForwardSource(m); err == nil {
		t.Fatal("unknown PTT accepted")
	}
	ptt := false
	m.AudioPTT = &ptt
	m.Body = nil
	if err := validateForwardSource(m); err != nil {
		t.Fatal(err)
	}
	m.IsViewOnce = true
	if err := validateForwardSource(m); err == nil {
		t.Fatal("view-once forwarded")
	}
}
func TestForwardBatchLimitsUseSourceStateAndDestinationKinds(t *testing.T) {
	source := &domain.Message{Forwarding: domain.MessageForwarding{State: domain.ForwardingForwarded}}
	groups := []*domain.Chat{{JID: "1@g.us"}, {JID: "2@g.us"}}
	if err := validateForwardDestinationLimits(source, groups); err == nil {
		t.Fatal("two groups accepted for forwarded source")
	}
	direct := []*domain.Chat{{JID: "1@s.whatsapp.net"}, {JID: "2@s.whatsapp.net"}}
	if err := validateForwardDestinationLimits(source, direct); err != nil {
		t.Fatal(err)
	}
	source.Forwarding.State = domain.ForwardingFrequentlyForwarded
	if err := validateForwardDestinationLimits(source, direct); err == nil {
		t.Fatal("frequent source forwarded twice")
	}
}

func TestForwardTypedFailureRetryRequiresSameSource(t *testing.T) {
	for _, code := range []string{"forward_source_changed", "forward_destination_changed", "forward_source_invalid", "recipient_invalid", "forward_content_unavailable", "forward_capability_unverified", "forwarding_source_unknown", "forwarding_score_unknown", "forward_type_unsupported", "forward_audio_kind_unknown"} {
		if forwardTypedFailureRetry(code) {
			t.Fatalf("unsafe source retry: %s", code)
		}
	}
	if !forwardTypedFailureRetry("forward_device_unavailable") {
		t.Fatal("known pre-send transient failure cannot retry")
	}
}

func TestForwardingCapabilityDefaultsOff(t *testing.T) {
	server := &Server{}
	if server.forwardingEnabled(uuid.New()) {
		t.Fatal("unconfigured provider advertises native forwarding")
	}
}

func TestSharingRequestDefaultsPreserveLegacyHash(t *testing.T) {
	req := forwardBatchRequest{SourceChatID: uuid.New(), SourceMessageID: uuid.New(), DeviceID: uuid.New(), DestinationChatIDs: []uuid.UUID{uuid.New()}, ClientOperationID: uuid.New()}
	legacy := struct {
		SourceChatID       uuid.UUID   `json:"source_chat_id"`
		SourceMessageID    uuid.UUID   `json:"source_message_id"`
		DeviceID           uuid.UUID   `json:"device_id"`
		DestinationChatIDs []uuid.UUID `json:"destination_chat_ids"`
		ClientOperationID  uuid.UUID   `json:"client_operation_id"`
	}{req.SourceChatID, req.SourceMessageID, req.DeviceID, req.DestinationChatIDs, req.ClientOperationID}
	raw, _ := json.Marshal(legacy)
	sum := sha256.Sum256(raw)
	expected := hex.EncodeToString(sum[:])
	normalized, hash, err := canonicalForwardRequest(req)
	if err != nil || hash != expected || normalized.Mode != domain.MessageSharingNative || normalized.ContentVariant != domain.MessageContentOriginal {
		t.Fatal("legacy hash changed", hash, expected, err)
	}
	req.Mode = domain.MessageSharingNative
	req.ContentVariant = domain.MessageContentOriginal
	if _, hash, err = canonicalForwardRequest(req); err != nil || hash != expected {
		t.Fatal("explicit defaults changed hash", err)
	}
	req.Mode = domain.MessageSharingCopy
	if _, hash, err = canonicalForwardRequest(req); err != nil || hash == expected {
		t.Fatal("copy reused native identity", err)
	}
	req.ContentVariant = domain.MessageContentAudioDocument
	if _, other, err := canonicalForwardRequest(req); err != nil || other == hash {
		t.Fatal("variant not bound to identity", err)
	}
	for _, bad := range []forwardBatchRequest{func() forwardBatchRequest { v := req; v.Mode = "automatic"; return v }(), func() forwardBatchRequest { v := req; v.ContentVariant = "guess"; return v }(), func() forwardBatchRequest { v := req; v.Mode = domain.MessageSharingNative; return v }()} {
		if _, _, err := canonicalForwardRequest(bad); err == nil {
			t.Fatal("invalid sharing preparation accepted")
		}
	}
}
func TestCopySourceRequiresExplicitAudioVariant(t *testing.T) {
	body, media, kind := "Synthetic", "https://test.invalid/audio", "audio"
	source := &domain.Message{Body: &body}
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentOriginal); err != nil {
		t.Fatal("legacy text cannot be copied", err)
	}
	if err := validateForwardSource(source); err == nil {
		t.Fatal("legacy text can be natively forwarded")
	}
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err == nil {
		t.Fatal("text converted to audio document")
	}
	source.MessageType = &kind
	source.MediaURL = &media
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentOriginal); err == nil {
		t.Fatal("unknown PTT guessed")
	}
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err != nil {
		t.Fatal(err)
	}
	source.IsRevoked = true
	if err := validateMessageSharingSource(source, domain.MessageSharingCopy, domain.MessageContentAudioDocument); err == nil {
		t.Fatal("revoked media copied")
	}
}
func TestLocalSharingPolicySurvivesUnmarkedCopy(t *testing.T) {
	source := &domain.Message{Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}, SharingLimits: &domain.MessageSharingLimits{MaxChats: 1, MaxGroups: 1}}
	if err := validateForwardDestinationLimits(source, []*domain.Chat{{JID: "1@s.whatsapp.net"}, {JID: "2@s.whatsapp.net"}}); err == nil {
		t.Fatal("unmarked copy laundered limits")
	}
}
