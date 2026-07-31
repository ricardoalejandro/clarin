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
