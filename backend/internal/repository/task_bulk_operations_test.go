package repository

import (
	"context"
	"errors"
	"strings"
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

func TestBulkMutationsReauthorizeInsideTransaction(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_bulk_operations.go")
	for _, invariant := range []string{
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, input.ActorID, lockedIDs, domain.TaskAccessEdit)",
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, lockedIDs, domain.TaskAccessFull)",
		"taskParticipantsNeedingGrant(ctx, tx, accountID, uuid.Nil, &item.ID, []uuid.UUID{assignee})",
		"!input.ConfirmParticipantGrants",
		"confirmTaskParticipantGrants(ctx, tx, accountID, rootTaskID, input.ActorID",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("bulk mutation lost transactional ACL invariant %q", invariant)
		}
	}
}
