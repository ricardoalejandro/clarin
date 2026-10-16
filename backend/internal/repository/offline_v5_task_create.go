package repository

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type offlineV5TaskCreate struct {
	offlineV3TaskCreate
	StatusID   *uuid.UUID
	AssignedTo *uuid.UUID
	Type       string
	Color      *string
}

func parseOfflineV5TaskCreate(raw json.RawMessage) (offlineV5TaskCreate, error) {
	var result offlineV5TaskCreate
	fields, err := decodeOfflineV5Object(raw, 256<<10)
	if err != nil {
		return result, err
	}
	core := make(map[string]json.RawMessage)
	for key, value := range fields {
		switch key {
		case "status_id", "assigned_to":
			var id uuid.UUID
			if json.Unmarshal(value, &id) != nil || id == uuid.Nil {
				return result, ErrOfflineV3Invalid
			}
			if key == "status_id" {
				result.StatusID = &id
			} else {
				result.AssignedTo = &id
			}
		case "type":
			if json.Unmarshal(value, &result.Type) != nil {
				return result, ErrOfflineV3Invalid
			}
			switch result.Type {
			case domain.TaskTypeCall, domain.TaskTypeWhatsApp, domain.TaskTypeMeeting, domain.TaskTypeReminder:
			default:
				return result, ErrOfflineV3Invalid
			}
		case "color":
			result.Color, err = offlineV5DecodeNullable[string](value)
			if err != nil || result.Color != nil && !offlineV5HexColor(*result.Color) {
				return result, ErrOfflineV3Invalid
			}
		default:
			core[key] = value
		}
	}
	coreRaw, err := json.Marshal(core)
	if err != nil {
		return result, err
	}
	result.offlineV3TaskCreate, err = parseOfflineV3TaskCreate(coreRaw)
	if result.Type == "" {
		result.Type = domain.TaskTypeReminder
	}
	return result, err
}

// V5 extends creation without changing the retired V3/V4 wire contracts. The
// canonical CreateTx still owns participant grants, workflow, parent and order.
func (r *OfflineV5Repository) applyTaskCreateV5Tx(ctx context.Context, tx pgx.Tx, record *OfflineV5AuthRecord, operation domain.OfflineV5Operation, selection domain.OfflineV3Selection) (domain.OfflineV5OperationResult, *domain.Task, error) {
	result := domain.OfflineV5OperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: "rejected"}
	input, err := parseOfflineV5TaskCreate(operation.Payload)
	if err != nil || operation.BaseVersion != 0 {
		result.ErrorCode = "invalid_task_create"
		return result, nil, nil
	}
	owner := record.UserID
	if input.AssignedTo != nil {
		owner = *input.AssignedTo
	}
	if owner != record.UserID {
		allowed, err := offlineV5ManifestHasDependencyTx(ctx, tx, record, operation, "task_user", owner)
		if err != nil {
			return result, nil, err
		}
		if !allowed {
			result.ErrorCode = "outside_selection"
			return result, nil, nil
		}
	}
	statusID := input.StatusID
	if statusID == nil {
		id, err := offlineV3TaskStatusTx(ctx, tx, record.AccountID, selection.ResourceID, domain.TaskStatusCategoryNotStarted)
		if err != nil {
			return result, nil, err
		}
		statusID = &id
	}
	task := &domain.Task{ID: operation.ResourceID, AccountID: record.AccountID, CreatedBy: record.UserID, AssignedTo: owner,
		Title: input.Title, Description: input.Description, ParentTaskID: input.ParentTaskID, StartAt: input.StartAt, DueAt: input.DueAt,
		DueEndAt: input.DueEndAt, IsAllDay: input.IsAllDay, Priority: input.Priority, Type: input.Type, Color: input.Color,
		Status: domain.TaskStatusPending, StatusID: statusID, ListID: &selection.ResourceID, ProgressMode: "manual", Placement: "bottom",
		CollaboratorsSet: true, MutationActor: &record.UserID, MutationOperationID: &operation.OperationID}
	mutation, err := tx.Begin(ctx)
	if err != nil {
		return result, nil, err
	}
	defer mutation.Rollback(ctx)
	tasks := &TaskRepository{db: r.db}
	if err = tasks.CreateTx(ctx, mutation, task); err != nil {
		if rollbackErr := mutation.Rollback(ctx); rollbackErr != nil {
			return result, nil, rollbackErr
		}
		var confirmation *TaskParticipantAccessConfirmationError
		switch {
		case errors.As(err, &confirmation):
			result.ErrorCode = "participant_access_confirmation_required"
		case errors.Is(err, ErrTaskStatusMappingInvalid):
			result.ErrorCode = "workflow_unavailable"
		case errors.Is(err, ErrTaskWorkNotFound), errors.Is(err, ErrTaskAccessDenied), errors.Is(err, ErrTaskAccessInvalid), errors.Is(err, ErrTaskParentArchived), errors.Is(err, pgx.ErrNoRows):
			result.ErrorCode = "access_revoked"
		default:
			return result, nil, err
		}
		return result, nil, nil
	}
	metadata, _ := json.Marshal(map[string]any{"operation_id": operation.OperationID, "origin": "offline_v5", "status_id": task.StatusID})
	if _, err = mutation.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata) VALUES($1,$2,$3,'created',$4::jsonb)`, record.AccountID, task.ID, record.UserID, metadata); err != nil {
		return result, nil, err
	}
	if err = mutation.Commit(ctx); err != nil {
		return result, nil, err
	}
	canonical, err := offlineV3LoadTaskTx(ctx, tx, tasks, record.AccountID, record.UserID, task.ID)
	if err != nil {
		return result, nil, err
	}
	result.Status, result.ServerVersion = "applied", canonical.Version
	result.Result, _ = json.Marshal(map[string]any{"task": OfflineV3TaskProjection(canonical)})
	return result, canonical, nil
}
