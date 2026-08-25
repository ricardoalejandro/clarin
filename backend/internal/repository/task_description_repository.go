package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// TaskDescriptionState is the narrow canonical state needed to reconcile an
// autosaved description. It intentionally excludes hierarchy and participant
// data, which are actor-specific and unrelated to this property mutation.
type TaskDescriptionState struct {
	Description string    `json:"description"`
	Version     int64     `json:"version"`
	UpdatedAt   time.Time `json:"updated_at"`
	Changed     bool      `json:"-"`
}

type taskDescriptionDecision int

const (
	taskDescriptionNoop taskDescriptionDecision = iota
	taskDescriptionConflict
	taskDescriptionWrite
)

func decideTaskDescriptionUpdate(currentDescription string, currentVersion int64, requestedDescription string, expectedVersion int64) taskDescriptionDecision {
	// Content equality wins over a stale version. This makes a retry after an
	// uncertain network outcome idempotent without creating activity or events.
	if currentDescription == requestedDescription {
		return taskDescriptionNoop
	}
	if currentVersion != expectedVersion {
		return taskDescriptionConflict
	}
	return taskDescriptionWrite
}

// UpdateTaskDescription performs the complete property mutation in one
// account-scoped transaction: it reauthorizes the actor, locks the task,
// checks the optimistic version, updates only description/version/timestamps,
// and writes exactly one activity row for a real content change.
func (r *TaskWorkRepository) UpdateTaskDescription(
	ctx context.Context,
	accountID, actorID, taskID uuid.UUID,
	description string,
	expectedVersion int64,
	operationID uuid.UUID,
) (*TaskDescriptionState, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	state := &TaskDescriptionState{}
	if err := tx.QueryRow(ctx, `SELECT COALESCE(task.description,''),COALESCE(task.version,1),COALESCE(task.updated_at,task.created_at,NOW())
		FROM tasks task
		JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
		WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NULL AND root.deleted_at IS NULL
		FOR UPDATE OF root,task`, accountID, taskID).Scan(&state.Description, &state.Version, &state.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}

	accessContext, err := resolveTaskAccessWith(ctx, tx, accountID, actorID, taskID)
	if err != nil {
		return nil, err
	}
	if !TaskAccessAllows(accessContext.Access, domain.TaskAccessEdit) {
		if accessContext.Access == nil || !accessContext.Access.CanView {
			return nil, ErrTaskWorkNotFound
		}
		return nil, ErrTaskAccessDenied
	}

	switch decideTaskDescriptionUpdate(state.Description, state.Version, description, expectedVersion) {
	case taskDescriptionNoop:
		return state, nil
	case taskDescriptionConflict:
		return state, ErrTaskVersionConflict
	}

	if err := tx.QueryRow(ctx, `UPDATE tasks
		SET description=$4,updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL AND COALESCE(version,1)=$3
		RETURNING COALESCE(description,''),COALESCE(version,1),updated_at`,
		accountID, taskID, expectedVersion, description).
		Scan(&state.Description, &state.Version, &state.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return state, ErrTaskVersionConflict
		}
		return nil, err
	}

	metadata, err := json.Marshal(map[string]any{
		"version":      state.Version,
		"operation_id": operationID.String(),
	})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
		VALUES($1,$2,$3,'description_updated',$4::jsonb)`, accountID, taskID, actorID, metadata); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	state.Changed = true
	return state, nil
}
