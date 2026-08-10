package repository

import (
	"testing"
	"time"
)

func TestWhiteboardTrashEligibilityIsInclusiveAtRetentionBoundary(t *testing.T) {
	archivedAt := time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)
	next, eligible := whiteboardTrashEligibility(archivedAt, 30, archivedAt.Add(30*24*time.Hour))
	if !eligible {
		t.Fatal("board must become eligible exactly at the retention boundary")
	}
	if !next.Equal(time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("unexpected eligibility date: %s", next)
	}
	_, eligible = whiteboardTrashEligibility(archivedAt, 30, archivedAt.Add(30*24*time.Hour-time.Nanosecond))
	if eligible {
		t.Fatal("board must not be eligible before the complete retention period")
	}
}
