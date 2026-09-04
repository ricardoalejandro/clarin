package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCurrentTaskMyWorkClockUsesLimaCalendarDay(t *testing.T) {
	clock := CurrentTaskMyWorkClock(time.Date(2026, 9, 2, 3, 30, 0, 0, time.UTC))
	if clock.BusinessDate != "2026-09-01" {
		t.Fatalf("business date = %s, want 2026-09-01", clock.BusinessDate)
	}
	if got := clock.ResetAt.UTC(); !got.Equal(time.Date(2026, 9, 2, 5, 0, 0, 0, time.UTC)) {
		t.Fatalf("reset at = %s", got)
	}
}

func TestReorderTaskMyWorkPositionsKeepsOnePersonalOrder(t *testing.T) {
	a, b, c := uuid.New(), uuid.New(), uuid.New()
	current := []taskMyWorkPosition{{ID: a, Position: 1024}, {ID: b, Position: 2048}, {ID: c, Position: 3072}}
	desired, changed, err := reorderTaskMyWorkPositions(current, c, &a)
	if err != nil || !changed {
		t.Fatalf("reorder failed: changed=%v err=%v", changed, err)
	}
	if desired[0].ID != c || desired[1].ID != a || desired[2].ID != b {
		t.Fatalf("unexpected order: %v", []uuid.UUID{desired[0].ID, desired[1].ID, desired[2].ID})
	}
	position, normalize := taskMyWorkMovedPosition(desired, 0)
	// The first legacy position leaves no positive 1024 gap, so normalization
	// is required instead of manufacturing a duplicate/non-positive value.
	if !normalize || position != 0 {
		t.Fatalf("expected normalization, got position %d normalize=%v", position, normalize)
	}
	unchanged, changed, err := reorderTaskMyWorkPositions(current, b, &c)
	if err != nil || changed || unchanged[1].ID != b {
		t.Fatalf("no-op reorder changed canonical order: changed=%v err=%v", changed, err)
	}
}

func TestTaskMyWorkSuggestionOrderUsesReasonThenSharedPriority(t *testing.T) {
	due := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	items := []taskMyWorkCandidate{
		{ID: uuid.MustParse("00000000-0000-0000-0000-000000000004"), ReasonRank: 2, PriorityRank: 0},
		{ID: uuid.MustParse("00000000-0000-0000-0000-000000000003"), ReasonRank: 0, PriorityRank: 2},
		{ID: uuid.MustParse("00000000-0000-0000-0000-000000000002"), ReasonRank: 0, PriorityRank: 0},
		{ID: uuid.MustParse("00000000-0000-0000-0000-000000000001"), ReasonRank: 0, PriorityRank: 0, DueAt: &due},
	}
	sortTaskMyWorkSuggestionsForTest(items)
	want := []string{
		"00000000-0000-0000-0000-000000000001",
		"00000000-0000-0000-0000-000000000002",
		"00000000-0000-0000-0000-000000000003",
		"00000000-0000-0000-0000-000000000004",
	}
	for index := range want {
		if items[index].ID.String() != want[index] {
			t.Fatalf("position %d = %s, want %s", index, items[index].ID, want[index])
		}
	}
}
