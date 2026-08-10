package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestWhiteboardSnapshotRoundTripIsPrivateAndDeterministic(t *testing.T) {
	t.Parallel()
	accountID, boardID, operationID := uuid.New(), uuid.New(), uuid.New()
	scene := json.RawMessage(`{"type":"excalidraw","elements":[{"id":"one","type":"rectangle","version":1,"versionNonce":2}],"appState":{},"files":{}}`)
	validatedScene, err := ValidateWhiteboardScene(scene)
	if err != nil {
		t.Fatal(err)
	}
	first, err := PrepareWhiteboardSnapshot(accountID, boardID, operationID, scene)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PrepareWhiteboardSnapshot(accountID, boardID, operationID, scene)
	if err != nil {
		t.Fatal(err)
	}
	if first.ContentHash != second.ContentHash || string(first.CompressedBytes) != string(second.CompressedBytes) {
		t.Fatal("gzip snapshot is not deterministic")
	}
	if !storage.IsPrivateObjectKey(first.ObjectKey) || !strings.HasPrefix(first.ObjectKey, accountID.String()+"/_private/whiteboards/"+boardID.String()+"/revisions/") {
		t.Fatalf("snapshot escaped private account namespace: %s", first.ObjectKey)
	}
	restored, err := DecodeWhiteboardSnapshot(first.CompressedBytes, first.ContentHash)
	if err != nil {
		t.Fatal(err)
	}
	if string(restored) != string(validatedScene) {
		t.Fatalf("snapshot round trip changed scene: %s", restored)
	}
	if _, err := DecodeWhiteboardSnapshot(first.CompressedBytes, strings.Repeat("0", 64)); err == nil {
		t.Fatal("snapshot hash mismatch was accepted")
	}
}

func TestWhiteboardPayloadAndCursorValidation(t *testing.T) {
	t.Parallel()
	if _, err := ValidateWhiteboardScene(json.RawMessage(`[]`)); err == nil {
		t.Fatal("array scene was accepted")
	}
	if _, err := ValidateWhiteboardLibrary(json.RawMessage(`{"items":[]}`)); err == nil {
		t.Fatal("library without libraryItems was accepted")
	}
	name, err := NormalizeWhiteboardName("  Mapa   anual  ", 20)
	if err != nil || name != "Mapa anual" {
		t.Fatalf("unexpected name normalization: %q %v", name, err)
	}
	id := uuid.New()
	updatedAt := time.Date(2026, 8, 9, 12, 30, 0, 0, time.UTC)
	cursor := EncodeWhiteboardBoardCursor(updatedAt, id)
	decodedTime, decodedID, err := DecodeWhiteboardBoardCursor(cursor)
	if err != nil || decodedTime == nil || decodedID == nil || !decodedTime.Equal(updatedAt) || *decodedID != id {
		t.Fatalf("cursor did not round trip: %v %v %v", decodedTime, decodedID, err)
	}
	if _, _, err := DecodeWhiteboardBoardCursor("not-a-cursor"); err == nil {
		t.Fatal("invalid cursor was accepted")
	}
}

func TestValidateWhiteboardLibrarySanitizesElementsAndRejectsEgress(t *testing.T) {
	t.Parallel()
	valid := json.RawMessage(`{
		"type":"excalidrawlib","version":2,"future":{"keep":true},
		"libraryItems":[{"id":"item","elements":[{"id":"rect","type":"rectangle","version":1,"versionNonce":2,"link":"https://clarin.local/help","future":7}]}]
	}`)
	clean, err := ValidateWhiteboardLibrary(valid)
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(clean, &envelope) != nil || string(envelope["source"]) != `"clarin"` {
		t.Fatalf("library source was not localized: %s", clean)
	}
	if _, ok := envelope["future"]; !ok {
		t.Fatal("unknown library property was discarded")
	}
	for name, payload := range map[string]json.RawMessage{
		"embeddable":         json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"elements":[{"id":"e","type":"embeddable","version":1,"versionNonce":1,"link":"https://example.com"}]}]}`),
		"script link":        json.RawMessage(`{"type":"excalidrawlib","libraryItems":[[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"javascript:alert(1)"}]]}`),
		"embedded file":      json.RawMessage(`{"type":"excalidrawlib","libraryItems":[],"files":{"f":{"dataURL":"data:image/png;base64,AA=="}}}`),
		"remote file source": json.RawMessage(`{"type":"excalidrawlib","libraryItems":[],"files":{"f":{"url":"https://example.invalid/image.png"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateWhiteboardLibrary(payload); err == nil {
				t.Fatal("unsafe library was accepted")
			}
		})
	}
}

func TestStableWhiteboardIDIsAccountScopedAndRetryable(t *testing.T) {
	t.Parallel()
	accountA, accountB, operationID := uuid.New(), uuid.New(), uuid.New()
	first, err := StableWhiteboardID(accountA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := StableWhiteboardID(accountA, operationID)
	if err != nil {
		t.Fatal(err)
	}
	otherAccount, err := StableWhiteboardID(accountB, operationID)
	if err != nil {
		t.Fatal(err)
	}
	if first != retry {
		t.Fatal("same create operation produced a second board ID")
	}
	if first == otherAccount {
		t.Fatal("create operation escaped its account namespace")
	}
	if _, err := StableWhiteboardID(uuid.Nil, operationID); err == nil {
		t.Fatal("nil account was accepted")
	}
}

func TestValidateWhiteboardSceneRejectsEgressAndStripsEphemeralState(t *testing.T) {
	t.Parallel()
	for name, scene := range map[string]json.RawMessage{
		"embedded binary": json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"dataURL":"data:image/png;base64,AA=="}}}`),
		"remote image":    json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"url":"https://example.com/a.png"}}}`),
		"legacy iframe":   json.RawMessage(`{"type":"excalidraw","elements":[{"id":"e","type":"iframe","version":1,"versionNonce":1,"customData":{"generationData":{"html":"<script>alert(1)</script>"}}}],"files":{}}`),
		"script link":     json.RawMessage(`{"type":"excalidraw","elements":[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"javascript:alert(1)"}],"files":{}}`),
		"nested URL":      json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"future":{"preview":"https://example.com/a.png"}}}}`),
		"nested bytes":    json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"f":{"future":{"encoded_bytes":[1,2,3]}}}}`),
		"invalid file ID": json.RawMessage(`{"type":"excalidraw","elements":[],"files":{"../../outside":{"id":"../../outside","mimeType":"image/png"}}}`),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ValidateWhiteboardScene(scene); err == nil {
				t.Fatal("unsafe scene was accepted")
			}
		})
	}

	validated, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","futureRoot":{"keep":true},
		"elements":[{"id":"e","type":"text","version":1,"versionNonce":1,"link":"mailto:help@example.com","future":7}],
		"appState":{"viewBackgroundColor":"#fff","scrollX":900,"collaborators":{"x":{}}},"files":{}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(validated, &document); err != nil {
		t.Fatal(err)
	}
	if _, ok := document["futureRoot"]; !ok {
		t.Fatal("unknown root property was discarded")
	}
	var appState map[string]json.RawMessage
	if err := json.Unmarshal(document["appState"], &appState); err != nil {
		t.Fatal(err)
	}
	if _, ok := appState["scrollX"]; ok {
		t.Fatal("ephemeral viewport state was persisted")
	}
	if _, ok := appState["collaborators"]; ok {
		t.Fatal("ephemeral collaborator state was persisted")
	}
	if _, ok := appState["viewBackgroundColor"]; !ok {
		t.Fatal("document background state was discarded")
	}

	inertEmbed, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[{
			"id":"legacy-embed","type":"embeddable","version":1,"versionNonce":1,
			"link":"https://example.com/explicit-only","customData":{"future":{"keep":true}}
		}],"appState":{},"files":{}
	}`))
	if err != nil {
		t.Fatalf("inert legacy embed was not preserved: %v", err)
	}
	if !strings.Contains(string(inertEmbed), `"type":"embeddable"`) ||
		!strings.Contains(string(inertEmbed), `"keep":true`) {
		t.Fatalf("inert legacy embed lost forward-compatible data: %s", inertEmbed)
	}
	if _, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[{
			"id":"bad-embed","type":"embeddable","version":1,"versionNonce":1,
			"link":"javascript:alert(1)"
		}],"appState":{},"files":{}
	}`)); err == nil {
		t.Fatal("inert embed accepted an unsafe link")
	}

	metadataScene, err := ValidateWhiteboardScene(json.RawMessage(`{
		"type":"excalidraw","elements":[],"appState":{},
		"files":{"f":{"id":"f","mimeType":"image/png","created":123,"future":{"colorProfile":"p3"}}}
	}`))
	if err != nil || !strings.Contains(string(metadataScene), `"colorProfile":"p3"`) {
		t.Fatalf("safe forward-compatible file metadata was not preserved: %s (%v)", metadataScene, err)
	}
}
