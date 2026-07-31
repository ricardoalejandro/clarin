package repository

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestBulkOperationsRejectUnsafeRequestsBeforeOpeningTransaction(t *testing.T) {
	repository := &TaskWorkRepository{}
	accountID := uuid.New()
	if _, err := repository.BulkUpdateTasks(context.Background(), accountID, TaskBulkUpdateInput{}); !errors.Is(err, ErrTaskBulkUpdateInvalid) {
		t.Fatalf("empty bulk update error = %v", err)
	}
	if _, err := repository.BulkTrashTasks(context.Background(), accountID, uuid.New(), nil); !errors.Is(err, ErrTaskBulkTrashInvalid) {
		t.Fatalf("empty bulk trash error = %v", err)
	}
	start := time.Date(2026, 7, 31, 10, 0, 0, 0, time.UTC)
	if _, err := repository.RescheduleTaskChain(context.Background(), accountID, TaskGanttRescheduleInput{
		TaskID: uuid.New(), Version: 1, StartAt: start, DueAt: start.Add(-time.Hour),
	}); !errors.Is(err, ErrTaskBulkUpdateInvalid) {
		t.Fatalf("invalid gantt range error = %v", err)
	}
}
