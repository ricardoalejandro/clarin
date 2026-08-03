package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestTaskStatsSQLSeparatesActorFromAssignee(t *testing.T) {
	query := taskStatsSQL()
	for _, fragment := range []string{"t.account_id=$1", "direct_grant.user_id=$2", "environment_grant.user_id=$2", "t.assigned_to=$3", "JOIN task_lists tl"} {
		if !strings.Contains(query, fragment) {
			t.Errorf("stats SQL missing %q: %s", fragment, query)
		}
	}
}

func TestTaskDependencyPresenceDoesNotRevealHiddenRelation(t *testing.T) {
	t.Parallel()
	predicate := taskDependencyPresencePredicate("$2")
	for _, invariant := range []string{
		"JOIN tasks related_task",
		"related_task.deleted_at IS NULL",
		"JOIN task_lists related_list",
		"direct_grant.user_id=$2",
		"environment_grant.user_id=$2",
	} {
		if !strings.Contains(predicate, invariant) {
			t.Fatalf("dependency presence leaked a hidden relation; missing %q: %s", invariant, predicate)
		}
	}
}

func TestGetTaskByIDForActorFiltersBeforeHydration(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_repository.go")
	for _, invariant := range []string{
		"func (r *TaskRepository) GetByIDForActor",
		"t.deleted_at IS NULL",
		"taskActorCanViewSQL(\"t\", \"tl\", \"$3\")",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("actor task lookup lost SQL visibility invariant %q", invariant)
		}
	}
}

func TestTaskCreateAndUpdateLockEnvironmentDuringACLRecheck(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_repository.go")
	for _, invariant := range []string{
		"AND archived_at IS NULL FOR SHARE",
		"id=ANY($2::uuid[]) AND archived_at IS NULL ORDER BY id FOR SHARE",
		"resolveEnvironmentAccessWith(ctx, tx, t.AccountID, *t.MutationActor, environmentID)",
		"resolveTaskAccessWith(ctx, tx, t.AccountID, *t.MutationActor, t.ID)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task write lost transactional environment ACL invariant %q", invariant)
		}
	}
}

func TestTaskCursorFromTaskMirrorsCollectionOrder(t *testing.T) {
	dueAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	id := uuid.New()
	cursor := TaskCursorFromTask(&domain.Task{ID: id, Status: domain.TaskStatusCompleted, SortOrder: 4096, DueAt: &dueAt})
	if cursor == nil || cursor.StatusRank != 2 || cursor.SortOrder != 4096 || cursor.ID != id || cursor.DueAt == nil || !cursor.DueAt.Equal(dueAt) {
		t.Fatalf("task cursor does not mirror task ordering: %#v", cursor)
	}
	if rank := taskStatusPageRank("legacy-unknown"); rank != 4 {
		t.Fatalf("unknown statuses must sort last, got rank %d", rank)
	}
}

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

func TestTaskFiltersExcludeClosedUnlessStatusIsExplicit(t *testing.T) {
	statusID := uuid.New().String()
	tests := []struct {
		name    string
		filters map[string]string
		want    bool
	}{
		{name: "legacy caller keeps closed", filters: map[string]string{}, want: false},
		{name: "explicit include", filters: map[string]string{"include_closed": "TrUe"}, want: false},
		{name: "explicit exclude", filters: map[string]string{"include_closed": "false"}, want: true},
		{name: "status id wins", filters: map[string]string{"status_ids": statusID, "include_closed": "false"}, want: false},
		{name: "legacy status wins", filters: map[string]string{"status": "completed"}, want: false},
		{name: "blank status does not win", filters: map[string]string{"status_ids": "  "}, want: true},
		{name: "trash keeps closed history", filters: map[string]string{"deleted": "true"}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := taskFiltersExcludeClosed(test.filters); got != test.want {
				t.Fatalf("taskFiltersExcludeClosed()=%v, want %v", got, test.want)
			}
		})
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
