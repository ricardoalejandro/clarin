package whiteboard

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
)

const (
	MaxCanonicalSceneBytes = 16 << 20
	MaxCanonicalElements   = 50_000
)

// MaterializeScenePatch applies a validated element patch to the current
// canonical scene without rebuilding unknown document or element properties.
// Per-user editor state is excluded through SanitizePersistedAppState.
func MaterializeScenePatch(canonical json.RawMessage, elements []json.RawMessage, appState json.RawMessage) (json.RawMessage, string, error) {
	if len(canonical) == 0 || bytes.Equal(bytes.TrimSpace(canonical), []byte("null")) {
		canonical = json.RawMessage(`{}`)
	}
	if len(canonical) > MaxCanonicalSceneBytes || !json.Valid(canonical) {
		return nil, "", fmt.Errorf("%w: canonical scene", ErrInvalidRealtimeMessage)
	}

	document := make(map[string]json.RawMessage)
	if err := json.Unmarshal(canonical, &document); err != nil {
		return nil, "", fmt.Errorf("%w: canonical scene", ErrInvalidRealtimeMessage)
	}
	canonicalElements, err := sceneElements(document["elements"])
	if err != nil {
		return nil, "", err
	}
	merged, err := ReconcileElements(canonicalElements, elements)
	if err != nil {
		return nil, "", err
	}
	if len(merged) > MaxCanonicalElements {
		return nil, "", fmt.Errorf("%w: too many elements", ErrInvalidRealtimeMessage)
	}
	encodedElements, err := json.Marshal(merged)
	if err != nil {
		return nil, "", fmt.Errorf("encode elements: %w", err)
	}
	document["elements"] = encodedElements

	cleanPatchState, err := SanitizePersistedAppState(appState)
	if err != nil {
		return nil, "", err
	}
	mergedState, err := mergeAppState(document["appState"], cleanPatchState)
	if err != nil {
		return nil, "", err
	}
	document["appState"] = mergedState
	if _, ok := document["type"]; !ok {
		document["type"] = json.RawMessage(`"excalidraw"`)
	}
	if _, ok := document["version"]; !ok {
		document["version"] = json.RawMessage(`2`)
	}
	if _, ok := document["source"]; !ok {
		document["source"] = json.RawMessage(`"clarin"`)
	}
	if _, ok := document["files"]; !ok {
		document["files"] = json.RawMessage(`{}`)
	}

	materialized, err := json.Marshal(document)
	if err != nil {
		return nil, "", fmt.Errorf("encode scene: %w", err)
	}
	if len(materialized) > MaxCanonicalSceneBytes {
		return nil, "", fmt.Errorf("%w: canonical scene too large", ErrInvalidRealtimeMessage)
	}
	sum := sha256.Sum256(materialized)
	return materialized, hex.EncodeToString(sum[:]), nil
}

func sceneElements(raw json.RawMessage) ([]json.RawMessage, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil {
		return nil, fmt.Errorf("%w: scene elements", ErrInvalidRealtimeMessage)
	}
	if len(elements) > MaxCanonicalElements {
		return nil, fmt.Errorf("%w: too many elements", ErrInvalidRealtimeMessage)
	}
	return elements, nil
}

// ReferencedFileIDs returns the exact durable binary references of live scene
// elements. Clarin stores bytes separately and uses element.fileId as the
// canonical relationship instead of persisting data URLs in scene JSON.
func ReferencedFileIDs(scene json.RawMessage) ([]string, error) {
	if len(scene) == 0 || !json.Valid(scene) {
		return nil, fmt.Errorf("%w: canonical scene", ErrInvalidRealtimeMessage)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(scene, &document); err != nil {
		return nil, fmt.Errorf("%w: canonical scene", ErrInvalidRealtimeMessage)
	}
	elements, err := sceneElements(document["elements"])
	if err != nil {
		return nil, err
	}
	unique := make(map[string]struct{})
	for _, raw := range elements {
		var element struct {
			FileID    *string `json:"fileId"`
			IsDeleted bool    `json:"isDeleted"`
		}
		if err := json.Unmarshal(raw, &element); err != nil {
			return nil, fmt.Errorf("%w: scene element", ErrInvalidRealtimeMessage)
		}
		if element.IsDeleted || element.FileID == nil || *element.FileID == "" {
			continue
		}
		unique[*element.FileID] = struct{}{}
	}
	ids := make([]string, 0, len(unique))
	for fileID := range unique {
		ids = append(ids, fileID)
	}
	sort.Strings(ids)
	return ids, nil
}

func mergeAppState(current, patch json.RawMessage) (json.RawMessage, error) {
	currentClean, err := SanitizePersistedAppState(current)
	if err != nil {
		return nil, err
	}
	var output map[string]json.RawMessage
	if err := json.Unmarshal(currentClean, &output); err != nil {
		return nil, fmt.Errorf("%w: app state", ErrInvalidRealtimeMessage)
	}
	var updates map[string]json.RawMessage
	if err := json.Unmarshal(patch, &updates); err != nil {
		return nil, fmt.Errorf("%w: app state patch", ErrInvalidRealtimeMessage)
	}
	for key, value := range updates {
		output[key] = value
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return nil, fmt.Errorf("encode app state: %w", err)
	}
	return encoded, nil
}
