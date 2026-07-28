package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestComputeCriticalPathUsesLongestDependencyChain(t *testing.T) {
	start := time.Date(2026, time.July, 1, 9, 0, 0, 0, time.UTC)
	aID, bID, cID := uuid.New(), uuid.New(), uuid.New()
	aEnd := start.Add(48 * time.Hour)
	bEnd := start.Add(24 * time.Hour)
	cEnd := start.Add(12 * time.Hour)
	tasks := []*domain.Task{
		{ID: aID, Title: "A", StartAt: &start, DueAt: &aEnd},
		{ID: bID, Title: "B", StartAt: &start, DueAt: &bEnd},
		{ID: cID, Title: "C", StartAt: &start, DueAt: &cEnd},
	}
	dependencies := []*domain.TaskDependency{{PredecessorTaskID: aID, SuccessorTaskID: bID}}
	critical, slack := computeCriticalPath(tasks, dependencies)
	if len(critical) != 2 || critical[0] != aID.String() || critical[1] != bID.String() {
		t.Fatalf("unexpected critical path: %#v", critical)
	}
	if slack[aID.String()] != 0 || slack[bID.String()] != 0 {
		t.Fatalf("critical tasks must have zero slack: %#v", slack)
	}
	if slack[cID.String()] <= 0 {
		t.Fatalf("independent shorter task should have positive slack: %#v", slack)
	}
}
