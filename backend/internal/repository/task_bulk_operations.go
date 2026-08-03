package repository

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskBulkUpdateInvalid = errors.New("invalid task bulk update")
	ErrTaskBulkTrashInvalid  = errors.New("invalid task bulk trash")
)

type TaskVersionInput struct {
	ID      uuid.UUID
	Version int64
}

type TaskBulkUpdateInput struct {
	Items                    []TaskVersionInput
	Property                 string
	Value                    any
	ActorID                  uuid.UUID
	Operation                uuid.UUID
	ConfirmParticipantGrants bool
}

type TaskBulkMutationResult struct {
	TaskIDs []uuid.UUID
}

// BulkUpdateTasks changes one property for a stable set of top-level tasks.
// Locks are always acquired by UUID so concurrent mass actions cannot deadlock.
func (r *TaskWorkRepository) BulkUpdateTasks(ctx context.Context, accountID uuid.UUID, input TaskBulkUpdateInput) (*TaskBulkMutationResult, error) {
	if len(input.Items) == 0 || len(input.Items) > 500 {
		return nil, ErrTaskBulkUpdateInvalid
	}
	items := append([]TaskVersionInput(nil), input.Items...)
	sort.Slice(items, func(i, j int) bool { return items[i].ID.String() < items[j].ID.String() })
	seen := make(map[uuid.UUID]struct{}, len(items))
	for _, item := range items {
		if item.Version < 1 {
			return nil, ErrTaskBulkUpdateInvalid
		}
		if _, duplicate := seen[item.ID]; duplicate {
			return nil, ErrTaskBulkUpdateInvalid
		}
		seen[item.ID] = struct{}{}
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	currentAssignees := make(map[uuid.UUID]uuid.UUID, len(items))
	for _, item := range items {
		var version int64
		var parentID *uuid.UUID
		var currentAssignee uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT COALESCE(version,1),parent_task_id,assigned_to FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, item.ID).Scan(&version, &parentID, &currentAssignee); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrTaskBulkUpdateInvalid
			}
			return nil, err
		}
		if parentID != nil {
			return nil, ErrTaskBulkUpdateInvalid
		}
		if version != item.Version {
			return nil, ErrTaskVersionConflict
		}
		currentAssignees[item.ID] = currentAssignee
	}
	lockedIDs := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		lockedIDs = append(lockedIDs, item.ID)
	}
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, input.ActorID, lockedIDs, domain.TaskAccessEdit); err != nil {
		return nil, err
	}
	if input.Property == "assigned_to" {
		assignee, ok := input.Value.(uuid.UUID)
		if !ok || assignee == uuid.Nil {
			return nil, ErrTaskBulkUpdateInvalid
		}
		var belongs bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$2)`, accountID, assignee).Scan(&belongs); err != nil {
			return nil, err
		}
		if !belongs {
			return nil, ErrTaskBulkUpdateInvalid
		}
		grantTaskIDs := make([]uuid.UUID, 0, len(items))
		for _, item := range items {
			if currentAssignees[item.ID] == assignee {
				continue
			}
			affected, err := taskParticipantsNeedingGrant(ctx, tx, accountID, uuid.Nil, &item.ID, []uuid.UUID{assignee})
			if err != nil {
				return nil, err
			}
			if len(affected) > 0 {
				grantTaskIDs = append(grantTaskIDs, item.ID)
			}
		}
		if len(grantTaskIDs) > 0 && !input.ConfirmParticipantGrants {
			return nil, &TaskParticipantAccessConfirmationError{AffectedUserIDs: []uuid.UUID{assignee}}
		}
		var operationID *uuid.UUID
		if input.Operation != uuid.Nil {
			operationID = &input.Operation
		}
		for _, rootTaskID := range grantTaskIDs {
			if err := confirmTaskParticipantGrants(ctx, tx, accountID, rootTaskID, input.ActorID, []uuid.UUID{assignee}, operationID); err != nil {
				return nil, err
			}
		}
	}
	for _, item := range items {
		var command string
		var value any = input.Value
		switch input.Property {
		case "priority":
			command = `UPDATE tasks SET priority=$3,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`
		case "type":
			command = `UPDATE tasks SET type=$3,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`
		case "assigned_to":
			_, ok := value.(uuid.UUID)
			if !ok {
				return nil, ErrTaskBulkUpdateInvalid
			}
			command = `UPDATE tasks SET assigned_to=$3,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`
		case "due_at":
			command = `UPDATE tasks SET due_at=$3::timestamptz,overdue_notified_at=NULL,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`
		default:
			return nil, ErrTaskBulkUpdateInvalid
		}
		if _, err := tx.Exec(ctx, command, accountID, item.ID, value); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0, len(input.Items))
	for _, item := range input.Items {
		ids = append(ids, item.ID)
	}
	return &TaskBulkMutationResult{TaskIDs: ids}, nil
}

func (r *TaskWorkRepository) BulkTrashTasks(ctx context.Context, accountID, actorID uuid.UUID, items []TaskVersionInput) (*TaskBulkMutationResult, error) {
	if len(items) == 0 || len(items) > 500 {
		return nil, ErrTaskBulkTrashInvalid
	}
	ordered := append([]TaskVersionInput(nil), items...)
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].ID.String() < ordered[j].ID.String() })
	seen := make(map[uuid.UUID]struct{}, len(ordered))
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	for _, item := range ordered {
		if _, duplicate := seen[item.ID]; duplicate {
			return nil, ErrTaskBulkTrashInvalid
		}
		seen[item.ID] = struct{}{}
		var version int64
		var parentID *uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT COALESCE(version,1),parent_task_id FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, item.ID).Scan(&version, &parentID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrTaskBulkTrashInvalid
			}
			return nil, err
		}
		if parentID != nil {
			return nil, ErrTaskBulkTrashInvalid
		}
		if version != item.Version {
			return nil, ErrTaskVersionConflict
		}
		if _, err := tx.Exec(ctx, `SELECT id FROM tasks WHERE account_id=$1 AND parent_task_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, accountID, item.ID); err != nil {
			return nil, err
		}
	}
	lockedIDs := make([]uuid.UUID, 0, len(ordered))
	for _, item := range ordered {
		lockedIDs = append(lockedIDs, item.ID)
	}
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, lockedIDs, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	now := time.Now()
	ids := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		if _, err := tx.Exec(ctx, `UPDATE tasks SET deleted_at=$3,deleted_by=$4,updated_at=$3,version=version+1 WHERE account_id=$1 AND (id=$2 OR parent_task_id=$2) AND deleted_at IS NULL`, accountID, item.ID, now, actorID); err != nil {
			return nil, err
		}
		ids = append(ids, item.ID)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TaskBulkMutationResult{TaskIDs: ids}, nil
}

type TaskGanttRescheduleInput struct {
	TaskID                 uuid.UUID
	Version                int64
	StartAt                time.Time
	DueAt                  time.Time
	RescheduleDependencies bool
	ActorID                uuid.UUID
}

func (r *TaskWorkRepository) RescheduleTaskChain(ctx context.Context, accountID uuid.UUID, input TaskGanttRescheduleInput) (*TaskBulkMutationResult, error) {
	if input.Version < 1 || input.DueAt.Before(input.StartAt) {
		return nil, ErrTaskBulkUpdateInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	// The account row serializes dependency-graph reads with edge writes. The
	// complete affected set is then authorized and locked before any date moves.
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(new(uuid.UUID)); err != nil {
		return nil, err
	}
	ids := []uuid.UUID{input.TaskID}
	if input.RescheduleDependencies {
		rows, queryErr := tx.Query(ctx, `WITH RECURSIVE chain(id) AS (
			SELECT successor_task_id FROM task_dependencies WHERE account_id=$1 AND predecessor_task_id=$2
			UNION SELECT d.successor_task_id FROM task_dependencies d JOIN chain c ON c.id=d.predecessor_task_id WHERE d.account_id=$1
		) SELECT id FROM chain ORDER BY id`, accountID, input.TaskID)
		if queryErr != nil {
			return nil, queryErr
		}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, input.ActorID, ids, domain.TaskAccessEdit); err != nil {
		return nil, err
	}
	var oldStart *time.Time
	var version int64
	if err := tx.QueryRow(ctx, `SELECT start_at,COALESCE(version,1) FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, input.TaskID).Scan(&oldStart, &version); err != nil {
		return nil, err
	}
	if version != input.Version {
		return nil, ErrTaskVersionConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks SET start_at=$3,due_at=$4,overdue_notified_at=NULL,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`, accountID, input.TaskID, input.StartAt, input.DueAt); err != nil {
		return nil, err
	}
	if input.RescheduleDependencies && oldStart != nil {
		delta := input.StartAt.Sub(*oldStart)
		for _, id := range ids[1:] {
			if _, err := tx.Exec(ctx, `UPDATE tasks SET start_at=CASE WHEN start_at IS NULL THEN NULL ELSE start_at+$3::interval END,due_at=CASE WHEN due_at IS NULL THEN NULL ELSE due_at+$3::interval END,overdue_notified_at=NULL,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND id=$2`, accountID, id, delta.String()); err != nil {
				return nil, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TaskBulkMutationResult{TaskIDs: ids}, nil
}
