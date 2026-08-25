package whiteboard

import (
	"encoding/json"
	"testing"
)

func TestMaterializeScenePatchPreservesUnknownsAndSanitizesState(t *testing.T) {
	canonical := json.RawMessage(`{
		"type":"excalidraw","version":2,"futureRoot":{"enabled":true},
		"elements":[{"id":"a","index":"a0","version":1,"versionNonce":9,"type":"rectangle","future":"keep"}],
		"appState":{"viewBackgroundColor":"#fff","scrollX":400},"files":{}
	}`)
	remote := []json.RawMessage{
		json.RawMessage(`{"id":"a","index":"a0","version":2,"versionNonce":8,"type":"rectangle","future":"remote"}`),
	}
	materialized, hash, err := MaterializeScenePatch(canonical, remote, json.RawMessage(`{"gridSize":20,"scrollY":900}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(hash) != 64 {
		t.Fatalf("unexpected SHA-256: %q", hash)
	}
	var scene map[string]json.RawMessage
	if err := json.Unmarshal(materialized, &scene); err != nil {
		t.Fatal(err)
	}
	if string(scene["futureRoot"]) != `{"enabled":true}` {
		t.Fatalf("unknown root field lost: %s", scene["futureRoot"])
	}
	var elements []map[string]any
	if err := json.Unmarshal(scene["elements"], &elements); err != nil {
		t.Fatal(err)
	}
	if elements[0]["future"] != "remote" {
		t.Fatalf("unknown element field lost: %#v", elements[0])
	}
	var state map[string]any
	if err := json.Unmarshal(scene["appState"], &state); err != nil {
		t.Fatal(err)
	}
	if state["viewBackgroundColor"] != "#fff" || state["gridSize"] != float64(20) {
		t.Fatalf("document state did not merge: %#v", state)
	}
	if _, exists := state["scrollX"]; exists {
		t.Fatalf("canonical transient state survived: %#v", state)
	}
	if _, exists := state["scrollY"]; exists {
		t.Fatalf("patched transient state survived: %#v", state)
	}
}

func TestMaterializeScenePatchInitializesEmptyDocument(t *testing.T) {
	remote := []json.RawMessage{json.RawMessage(`{"id":"new","index":"a0","version":1,"versionNonce":1,"type":"text"}`)}
	materialized, _, err := MaterializeScenePatch(json.RawMessage(`{}`), remote, nil)
	if err != nil {
		t.Fatal(err)
	}
	var scene struct {
		Type     string            `json:"type"`
		Version  int               `json:"version"`
		Source   string            `json:"source"`
		Elements []json.RawMessage `json:"elements"`
	}
	if err := json.Unmarshal(materialized, &scene); err != nil {
		t.Fatal(err)
	}
	if scene.Type != "excalidraw" || scene.Version != 2 || scene.Source != "clarin" || len(scene.Elements) != 1 {
		t.Fatalf("unexpected initialized scene: %#v", scene)
	}
}

func TestMaterializeScenePatchPreservesFreedrawPressureContract(t *testing.T) {
	canonical := json.RawMessage(`{
		"type":"excalidraw","version":2,
		"elements":[
			{"id":"freedraw-legacy","index":"a0","version":1,"versionNonce":10,"type":"freedraw","points":[[0,0],[4,2]],"pressures":[],"simulatePressure":true},
			{"id":"freedraw-pressure","index":"a1","version":1,"versionNonce":20,"type":"freedraw","points":[[0,0],[10,5]],"pressures":[0.2,0.8],"simulatePressure":false,"strokeOptions":{"variability":"constant","streamline":0.5}}
		],
		"appState":{"viewBackgroundColor":"#fff"},"files":{}
	}`)
	remote := []json.RawMessage{json.RawMessage(`{"id":"freedraw-pressure","index":"a1","version":2,"versionNonce":21,"type":"freedraw","points":[[0,0],[10,5]],"pressures":[0.2,0.8],"simulatePressure":false,"strokeOptions":{"variability":"variable","streamline":0.5}}`)}

	materialized, _, err := MaterializeScenePatch(
		canonical,
		remote,
		json.RawMessage(`{"currentItemStrokeVariability":"variable"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	var scene map[string]json.RawMessage
	if err := json.Unmarshal(materialized, &scene); err != nil {
		t.Fatal(err)
	}
	var elements []map[string]json.RawMessage
	if err := json.Unmarshal(scene["elements"], &elements); err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]map[string]json.RawMessage, len(elements))
	for _, element := range elements {
		var id string
		if err := json.Unmarshal(element["id"], &id); err != nil {
			t.Fatal(err)
		}
		byID[id] = element
	}
	if _, exists := byID["freedraw-legacy"]["strokeOptions"]; exists {
		t.Fatalf("backend rewrote the untouched legacy freedraw: %s", byID["freedraw-legacy"])
	}
	pressure := byID["freedraw-pressure"]
	if string(pressure["strokeOptions"]) != `{"variability":"variable","streamline":0.5}` {
		t.Fatalf("stroke options were lost or rebuilt: %s", pressure["strokeOptions"])
	}
	if string(pressure["points"]) != `[[0,0],[10,5]]` || string(pressure["pressures"]) != `[0.2,0.8]` || string(pressure["simulatePressure"]) != `false` {
		t.Fatalf("freedraw samples changed during materialization: %s", pressure)
	}
	var appState map[string]json.RawMessage
	if err := json.Unmarshal(scene["appState"], &appState); err != nil {
		t.Fatal(err)
	}
	if _, exists := appState["currentItemStrokeVariability"]; exists {
		t.Fatalf("per-user pressure preference leaked into canonical app state: %s", scene["appState"])
	}
}

func TestReferencedFileIDsUsesOnlyLiveElements(t *testing.T) {
	t.Parallel()
	ids, err := ReferencedFileIDs(json.RawMessage(`{
		"elements":[
			{"id":"a","fileId":"file-b","version":1,"versionNonce":1},
			{"id":"b","fileId":"file-a","version":1,"versionNonce":1},
			{"id":"c","fileId":"file-b","version":1,"versionNonce":1},
			{"id":"d","fileId":"deleted","isDeleted":true,"version":2,"versionNonce":2}
		]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != "file-a" || ids[1] != "file-b" {
		t.Fatalf("unexpected file references: %#v", ids)
	}
}
