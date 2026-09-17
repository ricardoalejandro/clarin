package localstate

import (
	"encoding/json"
	"testing"
)

func TestPruneSnapshotsUsesAuthoritativeInventory(t *testing.T) {
	snapshots := map[string]json.RawMessage{"keep": json.RawMessage(`{"id":1}`), "remove": json.RawMessage(`{"id":2}`)}
	PruneSnapshots(snapshots, []string{"keep"})
	if _, ok := snapshots["remove"]; ok {
		t.Fatal("removed selection survived in the offline cache")
	}
	if _, ok := snapshots["keep"]; !ok {
		t.Fatal("active selection was removed")
	}
}

func TestEstimatedBytesIncludesPayload(t *testing.T) {
	if got := EstimatedBytes(map[string]string{"value": "payload"}); got < int64(len("payload")) {
		t.Fatalf("estimated bytes too small: %d", got)
	}
}

func TestSnapshotHashMatchesExactPayload(t *testing.T) {
	payload := json.RawMessage(`{"id":1,"name":"Clarin"}`)
	if !SnapshotHashMatches(payload, "7992adcc5760726a72af348f719d113636d6bc5c54de151d6431051f6fd062c1") {
		t.Fatal("valid snapshot hash was rejected")
	}
	if SnapshotHashMatches(json.RawMessage(`{"id":2,"name":"Clarin"}`), "7992adcc5760726a72af348f719d113636d6bc5c54de151d6431051f6fd062c1") {
		t.Fatal("tampered snapshot matched the advertised hash")
	}
	if SnapshotHashMatches(payload, "invalid") {
		t.Fatal("invalid snapshot hash was accepted")
	}
}

func TestBoundedPrefixKeepsOutboxOrder(t *testing.T) {
	got := BoundedPrefix([]int{1, 2, 3}, 2)
	if len(got) != 2 || got[0] != 1 || got[1] != 2 {
		t.Fatalf("unexpected bounded prefix: %#v", got)
	}
}

func TestReconcileOutboxTreatsDurableConflictAsTerminal(t *testing.T) {
	type pending struct{ id string }
	outbox := []pending{{id: "keep"}, {id: "applied"}, {id: "conflict"}, {id: "retry"}}
	got := ReconcileOutbox(outbox, []OperationReceipt{
		{OperationID: "applied", Status: "applied"},
		{OperationID: "conflict", Status: "conflict"},
		{OperationID: "retry", Status: "temporary_error"},
	}, func(item pending) string { return item.id })
	if len(got) != 2 || got[0].id != "keep" || got[1].id != "retry" {
		t.Fatalf("unexpected reconciled outbox: %#v", got)
	}
}

func TestMergeBoundedByIDDeduplicatesReceiptsAndKeepsNewestBound(t *testing.T) {
	type receipt struct {
		id      string
		version int
	}
	got := MergeBoundedByID(
		[]receipt{{id: "one", version: 1}, {id: "one", version: 2}, {id: "two", version: 1}},
		[]receipt{{id: "two", version: 2}, {id: "three", version: 1}},
		2,
		func(item receipt) string { return item.id },
	)
	if len(got) != 2 || got[0].id != "two" || got[0].version != 2 || got[1].id != "three" {
		t.Fatalf("unexpected bounded receipt merge: %#v", got)
	}
}

func TestValidUUIDIsStrict(t *testing.T) {
	if !ValidUUID("f56aa6ec-e698-4509-b90f-0cf65ac9b34c") {
		t.Fatal("valid UUID rejected")
	}
	for _, invalid := range []string{"", "f56aa6ec-e698-4509-b90f-0cf65ac9b34z", "f56aa6ece6984509b90f0cf65ac9b34c"} {
		if ValidUUID(invalid) {
			t.Fatalf("invalid UUID accepted: %q", invalid)
		}
	}
}

func TestResolveBootstrapStateFailsClosed(t *testing.T) {
	cases := []struct {
		profiles, keyVersion, accounts int
		valid, pending                 bool
		want                           string
	}{
		{profiles: 0, want: BootstrapUnregistered},
		{profiles: 2, valid: true, keyVersion: 1, accounts: 1, want: BootstrapBlocked},
		{profiles: 1, valid: false, want: BootstrapBlocked},
		{profiles: 1, valid: true, pending: true, keyVersion: 1, accounts: 1, want: BootstrapPending},
		{profiles: 1, valid: true, want: BootstrapPending},
		{profiles: 1, valid: true, keyVersion: 1, accounts: 1, want: BootstrapEnrolled},
	}
	for _, tc := range cases {
		if got := ResolveBootstrapState(tc.profiles, tc.valid, tc.pending, tc.keyVersion, tc.accounts); got != tc.want {
			t.Fatalf("ResolveBootstrapState(%+v)=%q want %q", tc, got, tc.want)
		}
	}
}
