package api

import (
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
