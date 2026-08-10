package whiteboard

import (
	"encoding/json"
	"errors"
	"testing"
)

func rawElement(t *testing.T, value string) json.RawMessage {
	t.Helper()
	if !json.Valid([]byte(value)) {
		t.Fatalf("invalid fixture: %s", value)
	}
	return json.RawMessage(value)
}

func elementIDs(t *testing.T, elements []json.RawMessage) []string {
	t.Helper()
	ids := make([]string, 0, len(elements))
	for _, raw := range elements {
		var value struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &value); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, value.ID)
	}
	return ids
}

func TestReconcileElementsUsesVersionAndNonceAndPreservesUnknownFields(t *testing.T) {
	canonical := []json.RawMessage{
		rawElement(t, `{"id":"a","index":"a0","version":2,"versionNonce":90,"type":"rectangle","future":{"kept":true}}`),
		rawElement(t, `{"id":"b","index":"b0","version":1,"versionNonce":4,"type":"text"}`),
	}
	remote := []json.RawMessage{
		rawElement(t, `{"id":"a","index":"a0","version":2,"versionNonce":12,"type":"rectangle","future":{"remote":true}}`),
		rawElement(t, `{"id":"b","index":"b0","version":0,"versionNonce":1,"type":"text","text":"stale"}`),
		rawElement(t, `{"id":"c","index":"aa","version":1,"versionNonce":8,"type":"arrow","unknown":"survives"}`),
	}

	merged, err := ReconcileElements(canonical, remote)
	if err != nil {
		t.Fatal(err)
	}
	gotIDs := elementIDs(t, merged)
	wantIDs := []string{"a", "c", "b"}
	for index := range wantIDs {
		if gotIDs[index] != wantIDs[index] {
			t.Fatalf("unexpected order: got %v want %v", gotIDs, wantIDs)
		}
	}
	if string(merged[0]) != string(remote[0]) {
		t.Fatalf("equal version should choose lower nonce without rebuilding JSON: %s", merged[0])
	}
	if string(merged[2]) != string(canonical[1]) {
		t.Fatalf("stale patch replaced canonical element: %s", merged[2])
	}
}

func TestReconcileElementsKeepsDeletedTombstones(t *testing.T) {
	deleted := rawElement(t, `{"id":"gone","index":"a0","version":4,"versionNonce":1,"isDeleted":true,"custom":"value"}`)
	merged, err := ReconcileElements(nil, []json.RawMessage{deleted})
	if err != nil {
		t.Fatal(err)
	}
	if len(merged) != 1 || string(merged[0]) != string(deleted) {
		t.Fatalf("deleted element was not preserved: %s", merged)
	}
}

func TestReconcileElementsMatchesUpstreamOrderingContract(t *testing.T) {
	canonical := []json.RawMessage{
		rawElement(t, `{"id":"z","index":"a0","version":1,"versionNonce":9}`),
		rawElement(t, `{"id":"legacy-local","version":1,"versionNonce":1}`),
	}
	remote := []json.RawMessage{
		rawElement(t, `{"id":"a","index":"a0","version":1,"versionNonce":8}`),
		rawElement(t, `{"id":"legacy-remote","version":1,"versionNonce":2}`),
	}

	merged, err := ReconcileElements(canonical, remote)
	if err != nil {
		t.Fatal(err)
	}
	// v0.18.1 orderByFractionalIndex breaks adjacent equal-index ties by id,
	// while a legacy element without an index is an ordering barrier and keeps
	// the remote-first reconciliation order around it.
	want := []string{"a", "legacy-remote", "z", "legacy-local"}
	got := elementIDs(t, merged)
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("unexpected upstream-compatible order: got %v want %v", got, want)
		}
	}
}

func TestReconcileElementsRejectsDuplicateAndInvalidElements(t *testing.T) {
	duplicate := rawElement(t, `{"id":"a","index":"a0","version":1,"versionNonce":1}`)
	_, err := ReconcileElements([]json.RawMessage{duplicate, duplicate}, nil)
	if !errors.Is(err, ErrDuplicateElementID) {
		t.Fatalf("expected duplicate error, got %v", err)
	}

	_, err = ReconcileElements(nil, []json.RawMessage{rawElement(t, `{"id":"a","version":-1,"versionNonce":1}`)})
	if !errors.Is(err, ErrInvalidSceneElement) {
		t.Fatalf("expected invalid element error, got %v", err)
	}
}
