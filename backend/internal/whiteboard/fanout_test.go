package whiteboard

import (
	"testing"

	"github.com/google/uuid"
)

func TestFanoutEnvelopeRoundTripAndScopeValidation(t *testing.T) {
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(),
		AccountID:  uuid.New(),
		BoardID:    uuid.New(),
		Message: OutgoingMessage{
			Event:    EventScenePatch,
			Sequence: 8,
		},
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.AccountID != envelope.AccountID || decoded.BoardID != envelope.BoardID || decoded.Message.Sequence != 8 {
		t.Fatalf("unexpected decoded fanout: %#v", decoded)
	}

	envelope.AccountID = uuid.Nil
	if _, err := envelope.Encode(); err == nil {
		t.Fatal("expected account-scoped validation failure")
	}
}

func TestFanoutEnvelopeRejectsAckAndErrors(t *testing.T) {
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(),
		AccountID:  uuid.New(),
		BoardID:    uuid.New(),
		Message:    OutgoingMessage{Event: EventAck},
	}
	if _, err := envelope.Encode(); err == nil {
		t.Fatal("client-specific acknowledgement must not be sent through Redis")
	}
}

func TestFanoutEnvelopeAcceptsBoundedSyncInvalidation(t *testing.T) {
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(),
		Message: OutgoingMessage{Event: EventSyncRequired, Sequence: 42, Data: map[string]string{"reason": "scene_too_large"}},
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) > MaxRealtimeMessageBytes {
		t.Fatalf("sync invalidation exceeded fanout limit: %d", len(payload))
	}
}
