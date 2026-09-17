package api

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestOfflineWhiteboardPatchRejectsUnknownControlFields(t *testing.T) {
	raw := []byte(`{"scene":{"type":"excalidraw","version":2,"elements":[],"appState":{},"files":{}},"share_with_account":true}`)
	var patch offlineWhiteboardScenePatch
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&patch); err == nil {
		t.Fatal("offline whiteboard patch accepted a sharing mutation")
	}
}
