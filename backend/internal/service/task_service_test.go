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
