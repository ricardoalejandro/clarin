package api

import (
	"encoding/json"
	"fmt"
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

func TestParseTaskOperationID(t *testing.T) {
	if value, err := parseTaskOperationID(""); err != nil || value != nil {
		t.Fatalf("empty operation id must remain optional: %v, %#v", err, value)
	}
	want := uuid.New()
	got, err := parseTaskOperationID("  " + want.String() + "  ")
	if err != nil || got == nil || *got != want {
		t.Fatalf("valid operation id changed: %v, %#v", err, got)
	}
	if _, err := parseTaskOperationID("not-a-uuid"); err == nil {
		t.Fatal("malformed operation id was accepted")
	}
}

func TestTaskCreateResponseCarriesOptionalOperationID(t *testing.T) {
	task := &domain.Task{ID: uuid.New(), AccountID: uuid.New(), Version: 1}
	operationID := uuid.New()
	response := taskCreateResponse(task, &operationID)
	if response["task"] != task || response["operation_id"] != operationID.String() {
		t.Fatalf("create response lost its canonical identity: %#v", response)
	}
	if _, exists := taskCreateResponse(task, nil)["operation_id"]; exists {
		t.Fatal("response fabricated an omitted operation id")
	}
}

func TestGanttRequiresExplicitSchedule(t *testing.T) {
	start := time.Date(2026, 7, 29, 9, 0, 0, 0, time.UTC)
	due := start.Add(2 * time.Hour)
	if taskIsScheduledForGantt(&domain.Task{StartAt: nil, DueAt: &due}) {
		t.Fatal("an undated task must not enter Gantt critical-path calculations")
	}
	if duration := taskDurationMinutes(&domain.Task{}); duration != 0 {
		t.Fatalf("undated task received invented duration: %v", duration)
	}
	if !taskIsScheduledForGantt(&domain.Task{StartAt: &start, DueAt: &due}) {
		t.Fatal("an explicitly scheduled task was excluded from Gantt")
	}
}

func TestInvalidTaskQueryDateFilter(t *testing.T) {
	if key := invalidTaskQueryDateFilter(map[string]string{"created_to": "29/07/2026"}); key != "created_to" {
		t.Fatalf("unexpected invalid date key: %q", key)
	}
	if key := invalidTaskQueryDateFilter(map[string]string{"created_from": "2026-07-29", "completed_to": "2026-07-29T23:59:59-05:00"}); key != "" {
		t.Fatalf("valid task dates were rejected: %q", key)
	}
}

func TestValidTaskSavedViewMode(t *testing.T) {
	for _, mode := range []string{"list", "board", "calendar", "gantt", "summary"} {
		if !validTaskSavedViewMode(mode) {
			t.Fatalf("valid saved view mode %q was rejected", mode)
		}
	}
	if validTaskSavedViewMode("brain") {
		t.Fatal("unsupported saved view mode was accepted")
	}
}

func TestNormalizeCollapsedTaskStatusIDsAcceptsSyntheticAndUUID(t *testing.T) {
	id := uuid.New()
	values, ids, err := normalizeCollapsedTaskStatusIDs([]string{"category:active", id.String(), "category:active"})
	if err != nil || len(values) != 2 || values[0] != "category:active" || values[1] != id.String() || len(ids) != 1 || ids[0] != id {
		t.Fatalf("unexpected collapsed status normalization: values=%v ids=%v err=%v", values, ids, err)
	}
	for _, invalid := range [][]string{{"category:overdue"}, {"not-a-status"}} {
		if _, _, err := normalizeCollapsedTaskStatusIDs(invalid); err == nil {
			t.Fatalf("invalid collapsed status accepted: %v", invalid)
		}
	}
}

func TestParseTaskCommentPageBounds(t *testing.T) {
	limit, offset, err := parseTaskCommentPage("100", "25")
	if err != nil || limit != 100 || offset != 25 {
		t.Fatalf("valid comment page rejected: limit=%d offset=%d err=%v", limit, offset, err)
	}
	for _, values := range [][2]string{{"0", "0"}, {"101", "0"}, {"10", "-1"}, {"bad", "0"}} {
		if _, _, err := parseTaskCommentPage(values[0], values[1]); err == nil {
			t.Fatalf("invalid comment page accepted: %v", values)
		}
	}
}

func TestParseTaskListPageRejectsUnsafeBounds(t *testing.T) {
	limit, offset, err := parseTaskListPage("500", "12")
	if err != nil || limit != 200 || offset != 12 {
		t.Fatalf("task page was not safely clamped: limit=%d offset=%d err=%v", limit, offset, err)
	}
	for _, values := range [][2]string{{"0", "0"}, {"-1", "0"}, {"50", "-1"}, {"bad", "0"}} {
		if _, _, err := parseTaskListPage(values[0], values[1]); err == nil {
			t.Fatalf("unsafe task page accepted: %v", values)
		}
	}
}

func TestTaskParentRequestComparisonKeepsHierarchyImmutable(t *testing.T) {
	parent, same, other := uuid.New(), uuid.Nil, uuid.New()
	same = parent
	if !taskRequestUUIDPointersEqual(nil, nil) || !taskRequestUUIDPointersEqual(&parent, &same) {
		t.Fatal("unchanged parent relationship was rejected")
	}
	if taskRequestUUIDPointersEqual(&parent, nil) || taskRequestUUIDPointersEqual(nil, &parent) || taskRequestUUIDPointersEqual(&parent, &other) {
		t.Fatal("a hierarchy-changing parent value was accepted")
	}
}

func TestTaskDeleteTombstoneAdvancesVersion(t *testing.T) {
	actor := uuid.New()
	task := &domain.Task{ID: uuid.New(), Version: 7}
	tombstone := taskDeleteTombstone(task, actor)
	if tombstone == task || tombstone.Version != 8 || tombstone.DeletedAt == nil || tombstone.DeletedBy == nil || *tombstone.DeletedBy != actor {
		t.Fatalf("invalid delete tombstone: %#v", tombstone)
	}
	if task.Version != 7 || task.DeletedAt != nil {
		t.Fatal("delete tombstone mutated the pre-delete task")
	}
}

func TestTrimTaskCommentPageKeepsLatestCommentsChronologically(t *testing.T) {
	base := time.Date(2026, time.July, 29, 8, 0, 0, 0, time.UTC)
	// This is the shape returned after SQL selected comments 102..2 in DESC
	// order and the repository reversed that bounded page to 2..102.
	selected := make([]*domain.TaskComment, 0, 101)
	for sequence := 2; sequence <= 102; sequence++ {
		createdAt := base.Add(time.Duration(sequence) * time.Minute)
		selected = append(selected, &domain.TaskComment{ID: uuid.New(), Body: fmt.Sprintf("comment-%d", sequence), CreatedAt: createdAt})
	}
	page, hasMore := trimTaskCommentPage(selected, 100)
	if !hasMore || len(page) != 100 || page[0].Body != "comment-3" || page[99].Body != "comment-102" {
		t.Fatalf("newest page was trimmed incorrectly: has_more=%v len=%d first=%q last=%q", hasMore, len(page), page[0].Body, page[len(page)-1].Body)
	}
	if !page[0].CreatedAt.Equal(base.Add(3*time.Minute)) || !page[99].CreatedAt.Equal(base.Add(102*time.Minute)) {
		t.Fatal("comment timestamps lost chronological order")
	}

	older := []*domain.TaskComment{
		{ID: uuid.New(), Body: "comment-1", CreatedAt: base.Add(time.Minute)},
		{ID: uuid.New(), Body: "comment-2", CreatedAt: base.Add(2 * time.Minute)},
	}
	olderPage, olderHasMore := trimTaskCommentPage(older, 100)
	if olderHasMore || len(olderPage) != 2 || olderPage[0].Body != "comment-1" || olderPage[1].Body != "comment-2" {
		t.Fatalf("oldest page changed unexpectedly: %#v", olderPage)
	}
}

func TestTaskCommentRealtimeDoesNotBroadcastViewerPermissions(t *testing.T) {
	comment := &domain.TaskComment{ID: uuid.New(), Body: "Canonical", CanEdit: true, CanDelete: true}
	realtime := taskCommentForRealtime(comment)
	if realtime == comment || realtime.CanEdit || realtime.CanDelete || realtime.ID != comment.ID || realtime.Body != comment.Body {
		t.Fatalf("unsafe realtime comment projection: %#v", realtime)
	}
	if !comment.CanEdit || !comment.CanDelete {
		t.Fatal("realtime projection mutated the API response")
	}
}

func TestValidateTaskSavedViewFiltersRejectsMalformedShape(t *testing.T) {
	server := &Server{}
	valid := json.RawMessage(`{"status_ids":[],"priorities":["high"],"due":"today","has_comments":true}`)
	if err := server.validateTaskSavedViewFilters(nil, uuid.Nil, valid); err != nil {
		t.Fatalf("valid saved filters were rejected: %v", err)
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"status_ids":"not-an-array"}`),
		json.RawMessage(`{"priorities":["impossible"]}`),
		json.RawMessage(`{"due":"someday"}`),
		json.RawMessage(`{"unknown_filter":true}`),
	} {
		if err := server.validateTaskSavedViewFilters(nil, uuid.Nil, raw); err == nil {
			t.Fatalf("malformed saved filters were accepted: %s", raw)
		}
	}
}
