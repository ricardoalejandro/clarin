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

func TestFanoutEnvelopeRequiresMemberAudienceForComments(t *testing.T) {
	t.Parallel()
	envelope := FanoutEnvelope{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(),
		Message: OutgoingMessage{Event: EventCommentChanged, Data: map[string]string{"action": "created"}}}
	if _, err := envelope.Encode(); err == nil {
		t.Fatal("comment fanout without a member-only audience was accepted")
	}
	envelope.MembersOnly = true
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatalf("member-only comment fanout rejected: %v", err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil || !decoded.MembersOnly || decoded.Message.Event != EventCommentChanged {
		t.Fatalf("comment audience was not preserved: %#v %v", decoded, err)
	}
	guestID := uuid.New()
	envelope.TargetGuestID = &guestID
	if _, err := envelope.Encode(); err == nil {
		t.Fatal("member-only comment was targetable to a guest")
	}
}

func TestFanoutEnvelopeAllowsBoundedPresentationEvents(t *testing.T) {
	for _, event := range []string{EventPresentationSnapshot, EventPresentationChanged, EventFollowChange, EventViewportUpdate} {
		envelope := FanoutEnvelope{
			InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(),
			Message: OutgoingMessage{Event: event, Data: map[string]any{"ok": true}},
		}
		if _, err := envelope.Encode(); err != nil {
			t.Fatalf("%s fanout rejected: %v", event, err)
		}
	}
}
