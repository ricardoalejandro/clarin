package whiteboard

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDecodeIncomingScenePatch(t *testing.T) {
	payload := []byte(`{"event":"scene.patch","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066","base_sequence":8,"elements":[{"id":"a","version":1,"versionNonce":2}]}`)
	message, err := DecodeIncoming(payload)
	if err != nil {
		t.Fatal(err)
	}
	if message.Event != EventScenePatch || message.OperationID == nil || message.BaseSequence != 8 || len(message.Elements) != 1 {
		t.Fatalf("unexpected message: %#v", message)
	}
}

func TestOutgoingDurableMessagesPreserveSequenceZero(t *testing.T) {
	for _, event := range []string{EventSceneSnapshot, EventScenePatch, EventSyncRequired, EventAck} {
		payload, err := json.Marshal(OutgoingMessage{Event: event, Sequence: 0})
		if err != nil {
			t.Fatal(err)
		}
		var envelope map[string]any
		if err := json.Unmarshal(payload, &envelope); err != nil {
			t.Fatal(err)
		}
		sequence, exists := envelope["sequence"]
		if !exists || sequence != float64(0) {
			t.Fatalf("%s omitted canonical sequence zero: %s", event, payload)
		}
	}
}

func TestDecodeIncomingAllowsPersistedAppStateOnlyPatch(t *testing.T) {
	payload := []byte(`{"event":"scene.patch","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066","base_sequence":8,"app_state":{"viewBackgroundColor":"#f7f7f7"}}`)
	message, err := DecodeIncoming(payload)
	if err != nil {
		t.Fatal(err)
	}
	if len(message.Elements) != 0 || string(message.AppState) == "" {
		t.Fatalf("unexpected app-state patch: %#v", message)
	}
}

func TestDecodeIncomingRejectsEmptyOrTransientOnlyScenePatch(t *testing.T) {
	for _, payload := range []string{
		`{"event":"scene.patch","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066","base_sequence":8}`,
		`{"event":"scene.patch","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066","base_sequence":8,"app_state":{"scrollX":42,"collaborators":{}}}`,
	} {
		if _, err := DecodeIncoming([]byte(payload)); !errors.Is(err, ErrInvalidRealtimeMessage) {
			t.Fatalf("empty/non-document patch was accepted: %s (%v)", payload, err)
		}
	}
}

func TestDecodeIncomingRejectsUnknownFieldsAndOversizedPatches(t *testing.T) {
	_, err := DecodeIncoming([]byte(`{"event":"sync.request","unknown":true}`))
	if !errors.Is(err, ErrInvalidRealtimeMessage) {
		t.Fatalf("expected invalid message, got %v", err)
	}
	_, err = DecodeIncoming([]byte(strings.Repeat("x", MaxRealtimeMessageBytes+1)))
	if !errors.Is(err, ErrInvalidRealtimeMessage) {
		t.Fatalf("expected size rejection, got %v", err)
	}
	_, err = DecodeIncoming([]byte(`{"event":"sync.request"} {"event":"sync.request"}`))
	if !errors.Is(err, ErrInvalidRealtimeMessage) {
		t.Fatalf("expected trailing data rejection, got %v", err)
	}
}

func TestDecodeIncomingBoundsEphemeralPayloads(t *testing.T) {
	t.Parallel()
	oversized := strings.Repeat("x", MaxCursorPayloadBytes+1)
	payload := []byte(`{"event":"cursor.update","data":{"value":"` + oversized + `"}}`)
	if _, err := DecodeIncoming(payload); !errors.Is(err, ErrInvalidRealtimeMessage) {
		t.Fatalf("oversized cursor payload was accepted: %v", err)
	}
	oversized = strings.Repeat("x", MaxPresencePayloadBytes+1)
	payload = []byte(`{"event":"presence.update","data":{"value":"` + oversized + `"}}`)
	if _, err := DecodeIncoming(payload); !errors.Is(err, ErrInvalidRealtimeMessage) {
		t.Fatalf("oversized presence payload was accepted: %v", err)
	}
}

func TestDecodeIncomingPresentationAndFollowEvents(t *testing.T) {
	valid := []string{
		`{"event":"presentation.start","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066"}`,
		`{"event":"presentation.stop","operation_id":"1148b0ff-ff98-4abe-bcee-3dc4723e3066","data":{"presentation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066"}}`,
		`{"event":"follow.change","data":{"target_actor_id":"2148b0ff-ff98-4abe-bcee-3dc4723e3066","action":"FOLLOW"}}`,
		`{"event":"viewport.update","data":{"bounds":[-120.5,20,640,480]}}`,
	}
	for _, payload := range valid {
		if _, err := DecodeIncoming([]byte(payload)); err != nil {
			t.Fatalf("valid presentation payload was rejected: %s (%v)", payload, err)
		}
	}
}

func TestDecodeIncomingRejectsUnsafePresentationAndViewportEvents(t *testing.T) {
	invalid := []string{
		`{"event":"presentation.start"}`,
		`{"event":"presentation.start","operation_id":"0148b0ff-ff98-4abe-bcee-3dc4723e3066","data":{"actor_id":"2148b0ff-ff98-4abe-bcee-3dc4723e3066"}}`,
		`{"event":"presentation.stop","operation_id":"1148b0ff-ff98-4abe-bcee-3dc4723e3066","data":{"presentation_id":"invalid"}}`,
		`{"event":"follow.change","data":{"target_actor_id":"2148b0ff-ff98-4abe-bcee-3dc4723e3066","action":"FORCE"}}`,
		`{"event":"follow.change","data":{"target_actor_id":"2148b0ff-ff98-4abe-bcee-3dc4723e3066","action":"FOLLOW","account_id":"3148b0ff-ff98-4abe-bcee-3dc4723e3066"}}`,
		`{"event":"viewport.update","data":{"bounds":[0,0,0,10]}}`,
		`{"event":"viewport.update","data":{"bounds":[0,0,1000001,10]}}`,
		`{"event":"viewport.update","data":{"bounds":[0,0,10,10],"board_id":"4148b0ff-ff98-4abe-bcee-3dc4723e3066"}}`,
	}
	for _, payload := range invalid {
		if _, err := DecodeIncoming([]byte(payload)); !errors.Is(err, ErrInvalidRealtimeMessage) {
			t.Fatalf("unsafe presentation payload was accepted: %s (%v)", payload, err)
		}
	}
}

func TestSanitizePersistedAppStateDropsTransientAndUnknownFields(t *testing.T) {
	got, err := SanitizePersistedAppState(json.RawMessage(`{"viewBackgroundColor":"#fff","theme":"dark","zoom":{"value":2},"selectedElementIds":{"a":true},"future":42}`))
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal(got, &state); err != nil {
		t.Fatal(err)
	}
	if len(state) != 1 || string(state["viewBackgroundColor"]) != `"#fff"` {
		t.Fatalf("unexpected persisted state: %s", got)
	}
	if _, exists := state["theme"]; exists {
		t.Fatal("per-user theme leaked into canonical scene state")
	}
}

func TestSanitizePersistedAppStateValidatesAndNormalizesDocumentFields(t *testing.T) {
	got, err := SanitizePersistedAppState(json.RawMessage(`{"viewBackgroundColor":"  #f8fafc  ","gridSize":1000,"gridStep":2.6,"gridModeEnabled":true}`))
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(got, &state); err != nil {
		t.Fatal(err)
	}
	if state["viewBackgroundColor"] != "#f8fafc" || state["gridSize"] != float64(100) || state["gridStep"] != float64(3) || state["gridModeEnabled"] != true {
		t.Fatalf("unexpected normalized app state: %s", got)
	}

	legacyNull, err := SanitizePersistedAppState(json.RawMessage(`{"gridSize":null,"gridStep":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(legacyNull) != `{"gridSize":20,"gridStep":5}` {
		t.Fatalf("legacy null grid values were not restored like upstream: %s", legacyNull)
	}
}

func TestSanitizePersistedAppStateRejectsInvalidDocumentFieldTypes(t *testing.T) {
	for _, input := range []string{
		`{"viewBackgroundColor":{"css":"#fff"}}`,
		`{"viewBackgroundColor":""}`,
		`{"gridSize":"20"}`,
		`{"gridStep":{}}`,
		`{"gridModeEnabled":1}`,
	} {
		if _, err := SanitizePersistedAppState(json.RawMessage(input)); !errors.Is(err, ErrInvalidRealtimeMessage) {
			t.Fatalf("invalid canonical app state was accepted: %s (%v)", input, err)
		}
	}
}
