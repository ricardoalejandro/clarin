package repository

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"time"
)

// offlineTaskAuthority is a module command context, not an offline transport identity.
type offlineTaskAuthority struct{ AccountID, UserID, GrantID uuid.UUID }

// applyOfflineTaskMutationTx is shared by both independently authorized protocols.
// Callers own the grant/selection barrier, idempotency receipt and transactional outbox.
func applyOfflineTaskMutationTx(ctx context.Context, tx pgx.Tx, db *pgxpool.Pool, record offlineTaskAuthority, operation domain.OfflineV3Operation, selection domain.OfflineV3Selection, baseVersion int64, canComplete bool, origin string) (domain.OfflineV3OperationResult, *domain.Task, error) {
	result := domain.OfflineV3OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	// Recover domain/constraint rejections without leaving partial task effects
	// in a transaction whose receipt will subsequently be committed.
	mutation, err := tx.Begin(ctx)
	if err != nil {
		return result, nil, err
	}
	defer mutation.Rollback(ctx)
	tasks := &TaskRepository{db: db}
	var task *domain.Task
	var recurrenceSeed *domain.Task
	switch operation.Action {
	case domain.OfflineV3ActionTasksCreate:
		input, parseErr := parseOfflineV3TaskCreate(operation.Payload)
		if parseErr != nil || operation.BaseVersion != 0 {
			result.ErrorCode = "invalid_task_create"
			break
		}
		statusID, resolveErr := offlineV3TaskStatusTx(ctx, mutation, record.AccountID, selection.ResourceID, domain.TaskStatusCategoryNotStarted)
		if resolveErr != nil {
			err = resolveErr
			break
		}
		task = &domain.Task{ID: operation.ResourceID, AccountID: record.AccountID, CreatedBy: record.UserID, AssignedTo: record.UserID, Title: input.Title, Description: input.Description, ParentTaskID: input.ParentTaskID, StartAt: input.StartAt, DueAt: input.DueAt, DueEndAt: input.DueEndAt, IsAllDay: input.IsAllDay, Priority: input.Priority, Type: domain.TaskTypeReminder, Status: domain.TaskStatusPending, StatusID: &statusID, ListID: &selection.ResourceID, ProgressMode: "manual", Placement: "bottom", CollaboratorsSet: true, MutationActor: &record.UserID, MutationOperationID: &operation.OperationID}
		err = tasks.CreateTx(ctx, mutation, task)
	case domain.OfflineV3ActionTasksComplete:
		if baseVersion < 1 || strings.TrimSpace(string(operation.Payload)) != "{}" {
			result.ErrorCode = "invalid_task_complete"
			break
		}
		task, err = offlineV3LoadTaskTx(ctx, mutation, tasks, record.AccountID, record.UserID, operation.ResourceID)
		if err != nil {
			break
		}
		if task.ListID == nil || *task.ListID != selection.ResourceID {
			result.ErrorCode = "outside_selection"
			break
		}
		if task.ProgramID != nil {
			var migrated bool
			err = mutation.QueryRow(ctx, `SELECT EXISTS(`+getMigratedProgramEventTargetQuery+`)`, record.AccountID, *task.ProgramID).Scan(&migrated)
			if err != nil {
				break
			}
			if migrated {
				result.ErrorCode = "program_migrated"
				break
			}
		}
		access, accessErr := resolveTaskAccessWith(ctx, mutation, record.AccountID, record.UserID, task.ID)
		if accessErr != nil {
			err = accessErr
			break
		}
		if !TaskAccessAllows(access.Access, domain.TaskAccessEdit) {
			result.ErrorCode = "access_revoked"
			break
		}
		if task.Status == domain.TaskStatusCompleted || task.StatusDetail != nil && task.StatusDetail.Category == domain.TaskStatusCategoryDone {
			result.Status = "noop"
			break
		}
		if task.Version != baseVersion {
			result.Status = "conflict"
			result.ErrorCode = "version_conflict"
			break
		}
		statusID, resolveErr := offlineV3TaskStatusTx(ctx, mutation, record.AccountID, selection.ResourceID, domain.TaskStatusCategoryDone)
		if resolveErr != nil {
			err = resolveErr
			break
		}
		seed := *task
		recurrenceSeed = &seed
		now := time.Now().UTC()
		task.StatusID = &statusID
		task.Status = domain.TaskStatusCompleted
		task.CompletedAt = &now
		task.CompletedBy = &record.UserID
		task.Progress = 100
		task.MutationActor = &record.UserID
		task.MutationOperationID = &operation.OperationID
		task.CollaboratorsSet = false
		err = tasks.UpdateTx(ctx, mutation, task)
	}
	if err != nil {
		if rollbackErr := mutation.Rollback(ctx); rollbackErr != nil {
			return result, nil, rollbackErr
		}
		var pgErr *pgconn.PgError
		switch {
		case errors.Is(err, ErrTaskVersionConflict):
			result.Status = "conflict"
			result.ErrorCode = "version_conflict"
		case errors.Is(err, ErrTaskWorkNotFound), errors.Is(err, pgx.ErrNoRows), errors.Is(err, ErrTaskAccessDenied), errors.Is(err, ErrTaskAccessInvalid), errors.Is(err, ErrTaskParentArchived):
			result.ErrorCode = "access_revoked"
		case errors.Is(err, ErrTaskStatusMappingInvalid):
			result.ErrorCode = "workflow_unavailable"
		case errors.As(err, &pgErr) && pgErr.Code == "23505":
			result.ErrorCode = "resource_id_conflict"
		default:
			return result, nil, err
		}
		task = nil
		recurrenceSeed = nil
		if result.Status == "conflict" {
			latest, loadErr := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, operation.ResourceID)
			if loadErr == nil && latest.ListID != nil && *latest.ListID == selection.ResourceID {
				task = latest
			} else if loadErr == nil || errors.Is(loadErr, pgx.ErrNoRows) || errors.Is(loadErr, ErrTaskWorkNotFound) {
				result.Status, result.ErrorCode = "rejected", "outside_selection"
			} else {
				return result, nil, loadErr
			}
		}
	} else if result.ErrorCode != "" || result.Status == "noop" || result.Status == "conflict" {
		if err := mutation.Rollback(ctx); err != nil {
			return result, nil, err
		}
	} else {
		if err := mutation.Commit(ctx); err != nil {
			return result, nil, err
		}
		result.Status = "applied"
	}
	if task != nil && (result.Status == "applied" || result.Status == "noop") {
		canonical, loadErr := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, task.ID)
		if loadErr != nil {
			return result, nil, loadErr
		}
		task = canonical
	}
	if task != nil && (result.Status == "applied" || result.Status == "noop" || result.Status == "conflict") {
		result.ServerVersion = task.Version
		projection := OfflineV3TaskProjection(task)
		access, accessErr := resolveTaskAccessWith(ctx, tx, record.AccountID, record.UserID, task.ID)
		if accessErr != nil {
			return result, nil, accessErr
		}
		projection.CanComplete = canComplete && TaskAccessAllows(access.Access, domain.TaskAccessEdit) && projection.StatusCategory != domain.TaskStatusCategoryDone && projection.StatusCategory != domain.TaskStatusCategoryCancelled
		result.Result, _ = json.Marshal(map[string]any{"task": projection})
	}
	if result.Status == "applied" {
		activity := "created"
		if operation.Action == domain.OfflineV3ActionTasksComplete {
			activity = "completed"
		}
		metadata, _ := json.Marshal(map[string]any{"operation_id": operation.OperationID, "origin": origin, "status_id": task.StatusID})
		if _, err := tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`, record.AccountID, task.ID, record.UserID, activity, metadata); err != nil {
			return result, nil, err
		}
	}
	return result, recurrenceSeed, nil
}
