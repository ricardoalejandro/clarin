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

func TestFanoutEnvelopeAllowsOnlyEmptyInternalAccessChangeSignal(t *testing.T) {
	t.Parallel()
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), AccessChanged: true,
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatalf("internal access-change signal rejected: %v", err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil || !decoded.AccessChanged || decoded.Message.Event != "" {
		t.Fatalf("access-change signal did not round trip: %#v %v", decoded, err)
	}

	invalid := []FanoutEnvelope{
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), AccessChanged: true,
			Message: OutgoingMessage{Event: EventScenePatch}},
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), AccessChanged: true, MembersOnly: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), AccessChanged: true,
			Message: OutgoingMessage{Data: map[string]any{"access": "manage"}}},
	}
	target := uuid.New()
	invalid = append(invalid, FanoutEnvelope{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(),
		AccessChanged: true, TargetUserID: &target})
	for _, item := range invalid {
		if _, err := item.Encode(); err == nil {
			t.Fatalf("invalid access-change fanout was accepted: %#v", item)
		}
	}
}

func TestFanoutEnvelopeAllowsOnlyEmptyAccountAccessChangeSignal(t *testing.T) {
	t.Parallel()
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(), AccountID: uuid.New(), AccountAccessChanged: true,
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatalf("account access-change signal rejected: %v", err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil || !decoded.AccountAccessChanged || decoded.BoardID != uuid.Nil || decoded.Message.Event != "" {
		t.Fatalf("account access-change signal did not round trip: %#v %v", decoded, err)
	}

	invalid := []FanoutEnvelope{
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), AccountAccessChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), AccountAccessChanged: true, AccessChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), AccountAccessChanged: true,
			Message: OutgoingMessage{Event: EventScenePatch}},
	}
	for _, item := range invalid {
		if _, err := item.Encode(); err == nil {
			t.Fatalf("invalid account access-change fanout was accepted: %#v", item)
		}
	}
}

func TestFanoutEnvelopeAllowsOnlyAccountScopedUserAuthoritySignal(t *testing.T) {
	t.Parallel()
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(), AccountID: uuid.New(), UserAuthorityChanged: true,
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatalf("user authority signal rejected: %v", err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil || !decoded.UserAuthorityChanged || decoded.BoardID != uuid.Nil || decoded.Message.Event != "" {
		t.Fatalf("user authority signal did not round trip: %#v %v", decoded, err)
	}

	target := uuid.New()
	invalid := []FanoutEnvelope{
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), UserAuthorityChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), UserAuthorityChanged: true, AccountAccessChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), UserAuthorityChanged: true, AccessChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), UserAuthorityChanged: true, TargetUserID: &target},
		{InstanceID: uuid.New(), AccountID: uuid.New(), UserAuthorityChanged: true,
			Message: OutgoingMessage{Event: EventAccessRevoked}},
	}
	for _, item := range invalid {
		if _, err := item.Encode(); err == nil {
			t.Fatalf("invalid user authority fanout was accepted: %#v", item)
		}
	}
}

func TestFanoutEnvelopeAllowsOnlyPayloadFreeWhiteboardHubControls(t *testing.T) {
	t.Parallel()
	for _, control := range []FanoutEnvelope{
		{InstanceID: uuid.New(), AccountID: uuid.New(), WhiteboardHubChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), WorkHubRevoked: true},
	} {
		payload, err := control.Encode()
		if err != nil {
			t.Fatalf("Hub control rejected: %v", err)
		}
		decoded, err := DecodeFanout(payload)
		if err != nil || decoded.BoardID != uuid.Nil || decoded.Message.Event != "" ||
			decoded.WhiteboardHubChanged != control.WhiteboardHubChanged || decoded.WorkHubRevoked != control.WorkHubRevoked {
			t.Fatalf("Hub control did not round trip: %#v %v", decoded, err)
		}
	}

	boardID, targetID := uuid.New(), uuid.New()
	invalid := []FanoutEnvelope{
		{InstanceID: uuid.New(), AccountID: uuid.New(), WhiteboardHubChanged: true, WorkHubRevoked: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: boardID, WhiteboardHubChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), WhiteboardHubChanged: true, AccessChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), WorkHubRevoked: true, UserAuthorityChanged: true},
		{InstanceID: uuid.New(), AccountID: uuid.New(), WhiteboardHubChanged: true, TargetUserID: &targetID},
		{InstanceID: uuid.New(), AccountID: uuid.New(), WorkHubRevoked: true,
			Message: OutgoingMessage{Data: map[string]any{"name": "secret"}}},
	}
	for _, envelope := range invalid {
		if _, err := envelope.Encode(); err == nil {
			t.Fatalf("invalid Hub control was accepted: %#v", envelope)
		}
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

func TestFanoutEnvelopeRestrictsSourceEpochToEphemeralEvents(t *testing.T) {
	t.Parallel()
	envelope := FanoutEnvelope{
		InstanceID: uuid.New(), AccountID: uuid.New(), BoardID: uuid.New(), SourceAccessRevision: 17,
		Message: OutgoingMessage{Event: EventPresentationChanged, Data: map[string]any{"status": "started"}},
	}
	payload, err := envelope.Encode()
	if err != nil {
		t.Fatalf("source-epoch presentation rejected: %v", err)
	}
	decoded, err := DecodeFanout(payload)
	if err != nil || decoded.SourceAccessRevision != 17 {
		t.Fatalf("source epoch did not round trip: %#v %v", decoded, err)
	}
	envelope.Message = OutgoingMessage{Event: EventScenePatch, Sequence: 2}
	if _, err := envelope.Encode(); err == nil {
		t.Fatal("durable scene fanout accepted sender-only epoch semantics")
	}
}
