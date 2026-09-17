package transport

import (
	"slices"
	"testing"
	"time"
)

func TestAttemptStatusPreservesLastSuccessfulReconciliation(t *testing.T) {
	grantID := "55555555-5555-4555-8555-555555555555"
	lastSuccess := time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC)
	attempted := lastSuccess.Add(time.Hour)
	runner := &Runner{
		status:   map[string]GrantStatus{grantID: {State: "idle", Reachability: "reachable", LastSuccessAt: lastSuccess}},
		inFlight: make(map[string]struct{}),
	}

	previous, started := runner.beginAttempt(grantID, attempted)
	if !started || !previous.Equal(lastSuccess) {
		t.Fatalf("attempt lost prior success: started=%v previous=%v", started, previous)
	}
	if duplicatePrevious, duplicateStarted := runner.beginAttempt(grantID, attempted); duplicateStarted || !duplicatePrevious.IsZero() {
		t.Fatalf("same grant synchronized concurrently: started=%v previous=%v", duplicateStarted, duplicatePrevious)
	}
	runner.failed(grantID, attempted, previous, "server_unreachable", true)
	runner.endAttempt(grantID)
	status := runner.Status(grantID)
	if !status.LastSuccessAt.Equal(lastSuccess) || status.State != "waiting_network" || !status.Retryable {
		t.Fatalf("failed attempt overwrote canonical last success: %#v", status)
	}
}

func TestPeriodicBatchIsBoundedAndRotatesFairly(t *testing.T) {
	runner := &Runner{}
	grants := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j"}
	first := runner.nextBatch(grants, 8)
	second := runner.nextBatch(grants, 8)
	if !slices.Equal(first, []string{"a", "b", "c", "d", "e", "f", "g", "h"}) {
		t.Fatalf("first bounded batch = %#v", first)
	}
	if !slices.Equal(second, []string{"i", "j", "a", "b", "c", "d", "e", "f"}) {
		t.Fatalf("round-robin batch = %#v", second)
	}
}

func TestTriggerTargetsOnlyTheUnlockedGrant(t *testing.T) {
	runner := &Runner{trigger: make(chan string, 1)}
	runner.Trigger("55555555-5555-4555-8555-555555555555")
	select {
	case grantID := <-runner.trigger:
		if grantID != "55555555-5555-4555-8555-555555555555" {
			t.Fatalf("trigger targeted another grant: %q", grantID)
		}
	default:
		t.Fatal("grant trigger was discarded")
	}
}
