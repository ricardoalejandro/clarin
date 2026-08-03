package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNextRecurringDue(t *testing.T) {
	friday := time.Date(2026, time.July, 31, 9, 30, 0, 0, time.UTC)
	tests := []struct {
		rule string
		want time.Time
		ok   bool
	}{
		{"daily", time.Date(2026, time.August, 1, 9, 30, 0, 0, time.UTC), true},
		{"weekdays", time.Date(2026, time.August, 3, 9, 30, 0, 0, time.UTC), true},
		{"weekly", time.Date(2026, time.August, 7, 9, 30, 0, 0, time.UTC), true},
		{"monthly", time.Date(2026, time.August, 31, 9, 30, 0, 0, time.UTC), true},
		{"unsupported", friday, false},
	}
	for _, test := range tests {
		got, ok := nextRecurringDue(friday, test.rule)
		if ok != test.ok || !got.Equal(test.want) {
			t.Fatalf("rule %s: got %s,%v; want %s,%v", test.rule, got, ok, test.want, test.ok)
		}
	}
}

func TestTaskReminderScheduleChanged(t *testing.T) {
	due := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	minutes := 15
	owner := uuid.New()
	before := &domain.Task{AssignedTo: owner, DueAt: &due, ReminderMinutes: &minutes, Title: "Antes"}
	after := *before
	after.Title = "Sólo cambió el título"
	if taskReminderScheduleChanged(before, &after) {
		t.Fatal("an unrelated title edit would recreate an already delivered reminder")
	}
	newDue := due.Add(time.Hour)
	after.DueAt = &newDue
	if !taskReminderScheduleChanged(before, &after) {
		t.Fatal("a due-date change must recreate the reminder schedule")
	}
	terminal := after
	terminal.Status = domain.TaskStatusCompleted
	if !taskReminderScheduleChanged(&after, &terminal) {
		t.Fatal("completing a task must remove its pending reminder")
	}
	if taskCanScheduleReminder(&terminal) {
		t.Fatal("a completed task must never schedule a reminder")
	}
	terminal.Status = domain.TaskStatusCancelled
	if taskCanScheduleReminder(&terminal) {
		t.Fatal("a cancelled task must never schedule a reminder")
	}
	activeStatus := &domain.TaskStatus{Category: domain.TaskStatusCategoryActive}
	terminal.StatusDetail = activeStatus
	if !taskCanScheduleReminder(&terminal) {
		t.Fatal("canonical workflow category must permit a reopened active task reminder")
	}
}

func TestIntersectTaskNotificationTargetsDropsRevokedParticipants(t *testing.T) {
	owner, collaborator, revoked, unrelated := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	got := intersectTaskNotificationTargets(
		[]uuid.UUID{owner, collaborator, revoked, collaborator},
		[]uuid.UUID{unrelated, collaborator, owner},
	)
	if len(got) != 2 || got[0] != owner || got[1] != collaborator {
		t.Fatalf("notification targets=%v, want only visible owner and collaborator", got)
	}
	if got := intersectTaskNotificationTargets([]uuid.UUID{revoked}, []uuid.UUID{owner}); len(got) != 0 {
		t.Fatalf("revoked participant received reminder targets=%v", got)
	}
}

func TestAuthorizedTaskEventRecipientsExcludeUnrelatedAccountUser(t *testing.T) {
	viewerBefore, viewerAfter, unrelated := uuid.New(), uuid.New(), uuid.New()
	got := authorizedTaskEventRecipients(
		[]uuid.UUID{viewerBefore, viewerBefore},
		[]uuid.UUID{viewerAfter},
	)
	if len(got) != 2 || got[0] != viewerBefore || got[1] != viewerAfter {
		t.Fatalf("authorized task recipients=%v", got)
	}
	for _, recipient := range got {
		if recipient == unrelated {
			t.Fatalf("unrelated account user received task event: %s", unrelated)
		}
	}
}

func TestTaskACLRealtimePayloadRequiresActorScopedReload(t *testing.T) {
	taskID := uuid.New()
	privateListID := uuid.New()
	payload := map[string]interface{}{
		"action":           "updated",
		"task":             &domain.Task{ID: taskID, ListID: &privateListID},
		"hierarchy_counts": &domain.TaskHierarchyCounts{Lists: []domain.TaskListCountSnapshot{{ID: privateListID, TaskCount: 4}}},
		"operation_id":     uuid.NewString(),
	}
	got := taskACLRealtimePayload(taskID, payload)
	if got["task_id"] != taskID.String() || got["action"] != "updated" || got["operation_id"] != payload["operation_id"] {
		t.Fatalf("minimal task event lost reconciliation identity: %#v", got)
	}
	if _, exists := got["task"]; exists {
		t.Fatalf("direct share event leaked canonical task breadcrumb: %#v", got)
	}
	if _, exists := got["hierarchy_counts"]; exists {
		t.Fatalf("direct share event leaked private hierarchy counts: %#v", got)
	}
}

func TestAssignTaskCollaboratorsKeepsCanonicalUsers(t *testing.T) {
	withUsers, empty := uuid.New(), uuid.New()
	userID := uuid.New()
	tasks := []*domain.Task{{ID: withUsers}, {ID: empty}}
	assignTaskCollaborators(tasks, map[uuid.UUID][]*domain.TaskCollaborator{
		withUsers: {{UserID: userID, DisplayName: "Ada"}},
	})
	if len(tasks[0].Collaborators) != 1 || tasks[0].Collaborators[0].UserID != userID {
		t.Fatalf("canonical collaborators were not attached: %#v", tasks[0].Collaborators)
	}
	if tasks[1].Collaborators == nil || len(tasks[1].Collaborators) != 0 {
		t.Fatalf("empty collaborator list must be explicit: %#v", tasks[1].Collaborators)
	}
}

func TestTaskSubtasksUpdatedPayloadCarriesCanonicalParent(t *testing.T) {
	parent := &domain.Task{ID: uuid.New(), SubtaskCount: 4, SubtaskDone: 2}
	payload := taskSubtasksUpdatedPayload(parent)
	if payload["action"] != "subtasks_updated" || payload["task_id"] != parent.ID.String() {
		t.Fatalf("unexpected realtime routing payload: %#v", payload)
	}
	if payload["task"] != parent {
		t.Fatalf("canonical parent is missing from realtime payload: %#v", payload)
	}
}

func TestTaskCreatedEventPayloadCarriesOperationID(t *testing.T) {
	task := &domain.Task{ID: uuid.New(), AccountID: uuid.New(), Version: 1}
	operationID := uuid.New()
	payload := taskCreatedEventPayload(task, &operationID)
	if payload["action"] != "created" || payload["task"] != task || payload["operation_id"] != operationID.String() {
		t.Fatalf("HTTP/WebSocket creation identity was not preserved: %#v", payload)
	}
	withoutOperation := taskCreatedEventPayload(task, nil)
	if _, exists := withoutOperation["operation_id"]; exists {
		t.Fatalf("optional operation id was fabricated: %#v", withoutOperation)
	}
}

func TestTaskHierarchyCountsChangedOnlyForTopLevelCountDimensions(t *testing.T) {
	firstList, secondList := uuid.New(), uuid.New()
	active := &domain.Task{ListID: &firstList, Status: domain.TaskStatusPending}
	titleOnly := *active
	if taskHierarchyCountsChanged(active, &titleOnly) {
		t.Fatal("an unrelated task edit requested a hierarchy count snapshot")
	}
	stillOpen := *active
	stillOpen.StatusDetail = &domain.TaskStatus{Category: domain.TaskStatusCategoryActive}
	if taskHierarchyCountsChanged(active, &stillOpen) {
		t.Fatal("moving between open categories requested a hierarchy count snapshot")
	}

	moved := *active
	moved.ListID = &secondList
	if !taskHierarchyCountsChanged(active, &moved) {
		t.Fatal("a list transfer did not request a hierarchy count snapshot")
	}

	completed := *active
	completed.Status = domain.TaskStatusCompleted
	if !taskHierarchyCountsChanged(active, &completed) {
		t.Fatal("a closed-category transition did not request a hierarchy count snapshot")
	}

	childID := uuid.New()
	child := *active
	child.ParentTaskID = &childID
	if !taskHierarchyCountsChanged(active, &child) {
		t.Fatal("converting a top-level task into a child did not request hierarchy counts")
	}
	if !taskHierarchyCountsChanged(&child, active) {
		t.Fatal("promoting a child to the top level did not request hierarchy counts")
	}
	childClosed := child
	childClosed.Status = domain.TaskStatusCompleted
	if taskHierarchyCountsChanged(&child, &childClosed) {
		t.Fatal("a child status transition requested top-level hierarchy counts")
	}
}
