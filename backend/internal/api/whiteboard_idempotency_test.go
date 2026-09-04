package api

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func TestWhiteboardPatchRequestHashIsStableAcrossServerRebase(t *testing.T) {
	t.Parallel()
	elements := []json.RawMessage{json.RawMessage(`{"id":"a","version":2,"versionNonce":7}`)}
	appState := json.RawMessage(`{"viewBackgroundColor":"#fff"}`)
	first, err := whiteboardPatchRequestPayloadHash(4, elements, appState)
	if err != nil {
		t.Fatal(err)
	}
	retryAfterOtherWrites, err := whiteboardPatchRequestPayloadHash(4, elements, appState)
	if err != nil {
		t.Fatal(err)
	}
	if first != retryAfterOtherWrites {
		t.Fatal("same client operation changed identity after server rebase")
	}
	differentBase, err := whiteboardPatchRequestPayloadHash(5, elements, appState)
	if err != nil {
		t.Fatal(err)
	}
	if first == differentBase {
		t.Fatal("distinct client base sequence reused request identity")
	}
}

func TestWhiteboardCopyNameKeepsSuffixWithinDatabaseLimit(t *testing.T) {
	t.Parallel()
	name := whiteboardCopyName("Mapa anual")
	if name != "Mapa anual (copia)" {
		t.Fatalf("unexpected copy name: %q", name)
	}
	long := whiteboardCopyName(strings.Repeat("á", 200))
	if len([]rune(long)) > 200 || len([]rune(long)) < len([]rune(" (copia)")) {
		t.Fatalf("copy name escaped rune limit: %d", len([]rune(long)))
	}
}

func TestWhiteboardRealtimePatchAckCarriesCanonicalSceneAfterRebaseOrReplay(t *testing.T) {
	t.Parallel()
	scene := &domain.WhiteboardScene{
		BoardID: uuid.New(), Sequence: 9, Scene: json.RawMessage(`{"type":"excalidraw","elements":[{"id":"remote"}]}`),
		SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.6", UpdatedAt: time.Unix(1_700_000_000, 0).UTC(),
	}
	outgoing := whiteboardcore.OutgoingMessage{Data: whiteboardRealtimePatchData{BaseSequence: 8, ClientBaseSequence: 6}}
	data := whiteboardRealtimePatchAckData(&domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: 9}, outgoing, 6)
	if data["rebased"] != true || data["scene"] == nil {
		t.Fatalf("rebased ACK omitted canonical scene: %#v", data)
	}

	fresh := whiteboardRealtimePatchAckData(&domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: 9},
		whiteboardcore.OutgoingMessage{Data: whiteboardRealtimePatchData{BaseSequence: 8, ClientBaseSequence: 8}}, 8)
	if _, exists := fresh["scene"]; exists {
		t.Fatalf("ordinary ACK unnecessarily included a full scene: %#v", fresh)
	}

	replayed := whiteboardRealtimePatchAckData(&domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: 9, Idempotent: true},
		whiteboardcore.OutgoingMessage{Data: whiteboardRealtimePatchData{BaseSequence: 9, ClientBaseSequence: 8}}, 8)
	if replayed["rebased"] != true || replayed["scene"] == nil || replayed["idempotent"] != true {
		t.Fatalf("idempotent ACK omitted canonical recovery scene: %#v", replayed)
	}
}

func TestWhiteboardRealtimePatchAckUsesBoundedSyncForLargeCanonicalScene(t *testing.T) {
	t.Parallel()
	largeScene := json.RawMessage(`{"type":"excalidraw","opaque":"` + strings.Repeat("x", whiteboardcore.MaxRealtimeSnapshotMessageBytes) + `","elements":[]}`)
	scene := &domain.WhiteboardScene{
		BoardID: uuid.New(), Sequence: 11, Scene: largeScene,
		SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.6", UpdatedAt: time.Now().UTC(),
	}
	operationID := uuid.New()
	outgoing := whiteboardcore.OutgoingMessage{Data: whiteboardRealtimePatchData{BaseSequence: 10, ClientBaseSequence: 8}}
	messages := whiteboardRealtimePatchAckMessages(&domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: 11}, outgoing, 8, &operationID)
	if len(messages) != 2 || messages[0].Event != whiteboardcore.EventAck || messages[1].Event != whiteboardcore.EventSyncRequired {
		t.Fatalf("large canonical ACK was not followed by bounded sync invalidation: %#v", messages)
	}
	data, ok := messages[0].Data.(map[string]any)
	if !ok || data["sync_required"] != true || data["scene"] != nil {
		t.Fatalf("large canonical scene leaked into ACK: %#v", messages[0].Data)
	}
	for _, message := range messages {
		payload, err := json.Marshal(message)
		if err != nil || len(payload) > whiteboardcore.MaxRealtimeMessageBytes {
			t.Fatalf("bounded recovery event exceeded realtime limit: bytes=%d err=%v", len(payload), err)
		}
	}
	if snapshot := whiteboardSceneSnapshotMessage(scene); snapshot.Event != whiteboardcore.EventSyncRequired {
		t.Fatalf("oversized scene.snapshot was not replaced: %#v", snapshot)
	}
	largePatch := whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventScenePatch, Sequence: 12,
		Data: map[string]string{"opaque": strings.Repeat("x", whiteboardcore.MaxRealtimeSnapshotMessageBytes)},
	}
	if bounded := whiteboardRealtimeBroadcastMessage(largePatch); bounded.Event != whiteboardcore.EventSyncRequired || bounded.Sequence != 12 {
		t.Fatalf("oversized fanout patch was not converted to sync invalidation: %#v", bounded)
	}
}

func TestWhiteboardRealtimeOperationErrorCorrelatesThePendingWrite(t *testing.T) {
	t.Parallel()
	server := &Server{}
	operationID := uuid.New()
	client := &whiteboardcore.RealtimeClient{Send: make(chan []byte, 1)}
	server.queueWhiteboardOperationError(client, &operationID, "invalid_whiteboard_payload", "No se pudo aplicar el cambio")
	var message whiteboardcore.OutgoingMessage
	if err := json.Unmarshal(<-client.Send, &message); err != nil {
		t.Fatal(err)
	}
	if message.Event != whiteboardcore.EventError || message.OperationID == nil || *message.OperationID != operationID || message.Code != "invalid_whiteboard_payload" {
		t.Fatalf("operation error lost correlation: %#v", message)
	}
}

func TestWhiteboardOperationReplayFallsBackToCanonicalSync(t *testing.T) {
	t.Parallel()
	server := &Server{}
	largeClient := &whiteboardcore.RealtimeClient{Send: make(chan []byte, 2)}
	largePatch := whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventScenePatch, Sequence: 7,
		Data: map[string]string{"opaque": strings.Repeat("x", whiteboardcore.MaxRealtimeSnapshotMessageBytes)},
	}
	if server.queueWhiteboardReplayOperation(largeClient, largePatch, 11) {
		t.Fatal("replay continued after an oversized operation")
	}
	assertSyncRequiredSequence(t, <-largeClient.Send, 11)

	fullClient := &whiteboardcore.RealtimeClient{Send: make(chan []byte, 1)}
	if !fullClient.Enqueue([]byte(`{"event":"presence.update"}`)) {
		t.Fatal("could not saturate replay queue")
	}
	regularPatch := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventScenePatch, Sequence: 8, Data: map[string]string{"id": "small"}}
	if server.queueWhiteboardReplayOperation(fullClient, regularPatch, 12) {
		t.Fatal("replay continued after queue saturation")
	}
	assertSyncRequiredSequence(t, <-fullClient.Send, 12)

	readyClient := &whiteboardcore.RealtimeClient{Send: make(chan []byte, 1)}
	if !server.queueWhiteboardReplayOperation(readyClient, regularPatch, 12) {
		t.Fatal("bounded replay operation unnecessarily forced a snapshot")
	}
	var replay whiteboardcore.OutgoingMessage
	if err := json.Unmarshal(<-readyClient.Send, &replay); err != nil || replay.Event != whiteboardcore.EventScenePatch {
		t.Fatalf("bounded replay was not queued: %#v %v", replay, err)
	}
}

func TestWhiteboardOperationReplayRequiresAnUnbrokenPatchChain(t *testing.T) {
	t.Parallel()
	operation := func(base, sequence int64, kind string, patch string) *domain.WhiteboardOperation {
		return &domain.WhiteboardOperation{
			BaseSequence:  base,
			Sequence:      sequence,
			OperationKind: kind,
			Patch:         json.RawMessage(patch),
		}
	}
	complete := []*domain.WhiteboardOperation{
		operation(7, 8, "patch", `{"elements":[]}`),
		operation(8, 9, "patch", `{"elements":[]}`),
	}
	if !whiteboardOperationReplayComplete(7, 9, complete) {
		t.Fatal("complete patch chain unnecessarily fell back to a snapshot")
	}
	for name, operations := range map[string][]*domain.WhiteboardOperation{
		"compacted prefix":  {operation(8, 9, "patch", `{"elements":[]}`)},
		"interior gap":      {operation(7, 8, "patch", `{"elements":[]}`), operation(9, 10, "patch", `{"elements":[]}`)},
		"snapshot boundary": {operation(7, 8, "snapshot", `{}`)},
		"missing patch":     {operation(7, 8, "patch", ``)},
		"stale tail":        {operation(7, 8, "patch", `{"elements":[]}`)},
	} {
		if whiteboardOperationReplayComplete(7, 9, operations) {
			t.Fatalf("%s was accepted as a complete replay chain", name)
		}
	}
}

func assertSyncRequiredSequence(t *testing.T, payload []byte, sequence int64) {
	t.Helper()
	var message whiteboardcore.OutgoingMessage
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	if message.Event != whiteboardcore.EventSyncRequired || message.Sequence != sequence {
		t.Fatalf("expected canonical sync.required at %d, got %#v", sequence, message)
	}
}
