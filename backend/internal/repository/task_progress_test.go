package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestSynchronizeTaskStatusCategoryPreservesManualProgressWhenReopened(t *testing.T) {
	task := &domain.Task{CreatedBy: uuid.New(), Status: domain.TaskStatusCompleted, Progress: 100, ManualProgress: 42}
	synchronizeTaskStatusCategory(task, domain.TaskStatusCategoryActive)
	if task.Status != domain.TaskStatusPending || task.Progress != 42 || task.CompletedAt != nil {
		t.Fatalf("manual progress was not restored: %#v", task)
	}
}

func TestSynchronizeTaskStatusCategoryMarksDoneWithoutDeleting(t *testing.T) {
	task := &domain.Task{CreatedBy: uuid.New(), Status: domain.TaskStatusPending, Progress: 35, ManualProgress: 35}
	synchronizeTaskStatusCategory(task, domain.TaskStatusCategoryDone)
	if task.Status != domain.TaskStatusCompleted || task.Progress != 100 || task.CompletedAt == nil || task.CompletedBy == nil {
		t.Fatalf("done synchronization incomplete: %#v", task)
	}
	if task.DeletedAt != nil {
		t.Fatal("completing a task must never send it to trash")
	}
}

func TestNormalizeTaskReadProgressShowsDoneAsCompleteWithoutLosingManualValue(t *testing.T) {
	task := &domain.Task{
		Status:         domain.TaskStatusCompleted,
		Progress:       35,
		ManualProgress: 35,
		StatusDetail:   &domain.TaskStatus{Category: domain.TaskStatusCategoryDone},
	}
	normalizeTaskReadProgress(task)
	if task.Progress != 100 {
		t.Fatalf("completed task exposed progress %d instead of 100", task.Progress)
	}
	if task.ManualProgress != 35 {
		t.Fatalf("manual progress was destroyed: %d", task.ManualProgress)
	}

	active := &domain.Task{Status: domain.TaskStatusPending, Progress: 42, ManualProgress: 42, StatusDetail: &domain.TaskStatus{Category: domain.TaskStatusCategoryActive}}
	normalizeTaskReadProgress(active)
	if active.Progress != 42 {
		t.Fatalf("active manual progress changed: %d", active.Progress)
	}
}
