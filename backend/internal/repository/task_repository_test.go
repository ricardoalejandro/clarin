package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTaskFilterValuesDeduplicatesAndTrims(t *testing.T) {
	values := taskFilterValues(" high,urgent, high ,,medium ")
	if len(values) != 3 || values[0] != "high" || values[1] != "urgent" || values[2] != "medium" {
		t.Fatalf("unexpected normalized values: %#v", values)
	}
}

func TestTaskFilterUUIDsIgnoresMalformedValues(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	values := taskFilterUUIDs(first.String() + ",invalid," + second.String())
	if len(values) != 2 || values[0] != first || values[1] != second {
		t.Fatalf("unexpected UUID filter values: %#v", values)
	}
}

func TestNormalizeTaskDateFilterMakesDateOnlyEndInclusive(t *testing.T) {
	value, operator := normalizeTaskDateFilter("completed_to", "2026-07-29", "<=")
	if operator != "<" || value != "2026-07-30T00:00:00-05:00" {
		t.Fatalf("unexpected inclusive end normalization: operator=%s value=%s", operator, value)
	}
	from, fromOperator := normalizeTaskDateFilter("created_from", "2026-07-29", ">=")
	if fromOperator != ">=" || from != "2026-07-29T00:00:00-05:00" {
		t.Fatalf("unexpected start normalization: operator=%s value=%s", fromOperator, from)
	}
	legacyTo, legacyOperator := normalizeTaskDateFilter("to", "2026-07-29", "<=")
	if legacyOperator != "<" || legacyTo != "2026-07-30T00:00:00-05:00" {
		t.Fatalf("unexpected legacy end normalization: operator=%s value=%s", legacyOperator, legacyTo)
	}
}

func TestTaskUUIDPointersEqual(t *testing.T) {
	id, same, other := uuid.New(), uuid.Nil, uuid.New()
	same = id
	if !taskUUIDPointersEqual(nil, nil) || !taskUUIDPointersEqual(&id, &same) || taskUUIDPointersEqual(&id, nil) || taskUUIDPointersEqual(&id, &other) {
		t.Fatal("task UUID pointer equality did not preserve nullable scope semantics")
	}
}

func TestNextTaskCreateSortOrderPreservesGapsWithoutRewriting(t *testing.T) {
	if got := nextTaskCreateSortOrder(0, 0, 0, "top"); got != 1024 {
		t.Fatalf("first task order = %d, want 1024", got)
	}
	if got := nextTaskCreateSortOrder(3, 1024, 3072, "top"); got != 0 {
		t.Fatalf("top task order = %d, want 0", got)
	}
	if got := nextTaskCreateSortOrder(3, 0, 3072, "TOP"); got != -1024 {
		t.Fatalf("repeated top task order = %d, want -1024", got)
	}
	if got := nextTaskCreateSortOrder(3, -1024, 3072, "bottom"); got != 4096 {
		t.Fatalf("bottom task order = %d, want 4096", got)
	}
}

func TestTaskUUIDSetIsExactForStatusReorder(t *testing.T) {
	first, second, foreign := uuid.New(), uuid.New(), uuid.New()
	if !taskUUIDSetIsExact([]uuid.UUID{first, second}, []uuid.UUID{second, first}) {
		t.Fatal("exact reordered status set was rejected")
	}
	if taskUUIDSetIsExact([]uuid.UUID{first, second}, []uuid.UUID{first, first}) {
		t.Fatal("duplicate status set was accepted")
	}
	if taskUUIDSetIsExact([]uuid.UUID{first, second}, []uuid.UUID{first, foreign}) {
		t.Fatal("cross-workflow status set was accepted")
	}
}

func TestTaskMoveAnchorMatchesWorkflowCategoryNotConcreteStatus(t *testing.T) {
	workflow, otherWorkflow := uuid.New(), uuid.New()
	active, done := "active", "done"
	if !taskMoveStatusMatches(&workflow, &active, workflow, active) {
		t.Fatal("same-workflow status in the same synthetic category was rejected")
	}
	if taskMoveStatusMatches(&workflow, &done, workflow, active) {
		t.Fatal("cross-category anchor was accepted")
	}
	if taskMoveStatusMatches(&otherWorkflow, &active, workflow, active) {
		t.Fatal("cross-workflow anchor was accepted")
	}
}

func TestTaskWorkflowStatusesRequireOneInitialDefault(t *testing.T) {
	valid := []*domain.TaskStatus{
		{Category: domain.TaskStatusCategoryNotStarted, IsDefault: true},
		{Category: domain.TaskStatusCategoryActive},
		{Category: domain.TaskStatusCategoryDone},
	}
	if !taskWorkflowStatusesValid(valid) {
		t.Fatal("valid workflow status contract was rejected")
	}
	for _, invalid := range [][]*domain.TaskStatus{
		{{Category: domain.TaskStatusCategoryNotStarted}, {Category: domain.TaskStatusCategoryDone}},
		{{Category: domain.TaskStatusCategoryActive, IsDefault: true}, {Category: domain.TaskStatusCategoryDone}},
		{{Category: domain.TaskStatusCategoryNotStarted, IsDefault: true}, {Category: domain.TaskStatusCategoryNotStarted, IsDefault: true}, {Category: domain.TaskStatusCategoryDone}},
	} {
		if taskWorkflowStatusesValid(invalid) {
			t.Fatalf("invalid workflow status contract was accepted: %#v", invalid)
		}
	}
}
