package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type offlineTaskSimplePatch struct {
	TitleSet       bool
	Title          string
	DescriptionSet bool
	Description    string
	StartAtSet     bool
	StartAt        *time.Time
	DueAtSet       bool
	DueAt          *time.Time
	DueEndAtSet    bool
	DueEndAt       *time.Time
	IsAllDaySet    bool
	IsAllDay       bool
	PrioritySet    bool
	Priority       string
}

func (s *Server) applyOfflineTaskOperation(ctx context.Context, record *repository.OfflineAuthRecordV2, operation domain.OfflineOperation) (domain.OfflineOperationResult, error) {
	result := domain.OfflineOperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID}
	selection, err := s.repos.Offline.SelectionForOperation(ctx, record, operation.SelectionID)
	if errors.Is(err, pgx.ErrNoRows) || selection == nil || selection.Module != domain.OfflineModuleTasks || selection.ResourceType != domain.OfflineResourceTaskList {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "outside_selection"
		return result, nil
	}
	if err != nil {
		return result, err
	}
	if _, err := s.repos.TaskWork.RequireContainerAccess(ctx, record.AccountID, record.UserID, selection.ResourceID, domain.TaskAccessTargetList, domain.TaskAccessEdit); err != nil {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
		return result, nil
	}
	patch, err := parseOfflineTaskSimplePatch(operation.Patch, operation.OperationType == "task.create")
	if err != nil {
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_patch"
		return result, nil
	}

	switch operation.OperationType {
	case "task.create":
		if operation.ResourceType != domain.OfflineEntityTask || operation.BaseVersion != 0 {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_create_target"
			return result, nil
		}
		if existing, err := s.repos.Task.GetByIDForActor(ctx, operation.ResourceID, record.AccountID, record.UserID); err == nil {
			if existing.ListID != nil && *existing.ListID == selection.ResourceID && offlineTaskMatchesPatch(existing, patch) {
				result.Status, result.ServerVersion = domain.OfflineOperationNoop, existing.Version
				return result, nil
			}
			server, _ := json.Marshal(existing)
			conflictID, conflictErr := s.repos.Offline.CreateConflict(ctx, record, operation, existing.Version, server, offlineTaskPatchPaths(patch))
			if conflictErr != nil {
				return result, conflictErr
			}
			result.Status, result.ServerVersion, result.ConflictID = domain.OfflineOperationConflict, existing.Version, &conflictID
			return result, nil
		} else if !errors.Is(err, repository.ErrTaskWorkNotFound) && !errors.Is(err, pgx.ErrNoRows) {
			return result, err
		}
		status, err := s.repos.TaskWork.ResolveStatus(ctx, record.AccountID, &selection.ResourceID, nil, domain.TaskStatusCategoryNotStarted)
		if err != nil {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "workflow_unavailable"
			return result, nil
		}
		task := &domain.Task{ID: operation.ResourceID, AccountID: record.AccountID, CreatedBy: record.UserID, AssignedTo: record.UserID, Title: patch.Title, Description: patch.Description, Type: domain.TaskTypeReminder, StartAt: patch.StartAt, DueAt: patch.DueAt, DueEndAt: patch.DueEndAt, IsAllDay: patch.IsAllDay, Priority: patch.Priority, Status: domain.TaskStatusPending, StatusID: &status.ID, ListID: &selection.ResourceID, ProgressMode: "manual", Placement: "bottom", CollaboratorsSet: true, MutationActor: &record.UserID, MutationOperationID: &operation.OperationID}
		if task.Priority == "" {
			task.Priority = domain.TaskPriorityMedium
		}
		if err := s.repos.Task.Create(ctx, task); err != nil {
			if errors.Is(err, repository.ErrTaskAccessDenied) || errors.Is(err, repository.ErrTaskWorkNotFound) {
				result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
				return result, nil
			}
			return result, err
		}
		result.Status, result.ServerVersion = domain.OfflineOperationApplied, task.Version
		if result.ServerVersion == 0 {
			result.ServerVersion = 1
		}
		return result, nil

	case "task.update_simple", "task.complete":
		if operation.ResourceType != domain.OfflineEntityTask || operation.BaseVersion < 1 {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "invalid_task_target"
			return result, nil
		}
		task, err := s.repos.Task.GetByIDForActor(ctx, operation.ResourceID, record.AccountID, record.UserID)
		if errors.Is(err, repository.ErrTaskWorkNotFound) || errors.Is(err, pgx.ErrNoRows) || task.ListID == nil || *task.ListID != selection.ResourceID {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "outside_selection"
			return result, nil
		}
		if err != nil {
			return result, err
		}
		if _, err := s.repos.TaskWork.RequireTaskAccess(ctx, record.AccountID, record.UserID, task.ID, domain.TaskAccessEdit); err != nil {
			result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
			return result, nil
		}
		if operation.OperationType == "task.complete" {
			if task.Status == domain.TaskStatusCompleted || (task.StatusDetail != nil && task.StatusDetail.Category == domain.TaskStatusCategoryDone) {
				result.Status, result.ServerVersion = domain.OfflineOperationNoop, task.Version
				return result, nil
			}
			if task.Version != operation.BaseVersion {
				return s.offlineTaskConflict(ctx, record, operation, task, []string{"status"})
			}
			status, err := s.repos.TaskWork.ResolveStatus(ctx, record.AccountID, task.ListID, nil, domain.TaskStatusCategoryDone)
			if err != nil {
				result.Status, result.ErrorCode = domain.OfflineOperationRejected, "done_status_unavailable"
				return result, nil
			}
			now := time.Now().UTC()
			task.StatusID, task.Status, task.CompletedAt, task.CompletedBy, task.Progress = &status.ID, domain.TaskStatusCompleted, &now, &record.UserID, 100
		} else {
			if task.Version != operation.BaseVersion {
				if offlineTaskMatchesPatch(task, patch) {
					result.Status, result.ServerVersion = domain.OfflineOperationNoop, task.Version
					return result, nil
				}
				return s.offlineTaskConflict(ctx, record, operation, task, offlineTaskPatchPaths(patch))
			}
			applyOfflineTaskPatch(task, patch)
		}
		task.MutationActor, task.MutationOperationID = &record.UserID, &operation.OperationID
		task.CollaboratorsSet = false
		if err := s.repos.Task.Update(ctx, task); errors.Is(err, repository.ErrTaskVersionConflict) {
			latest, latestErr := s.repos.Task.GetByIDForActor(ctx, operation.ResourceID, record.AccountID, record.UserID)
			if latestErr != nil {
				return result, latestErr
			}
			return s.offlineTaskConflict(ctx, record, operation, latest, offlineTaskPatchPaths(patch))
		} else if err != nil {
			if errors.Is(err, repository.ErrTaskAccessDenied) || errors.Is(err, repository.ErrTaskWorkNotFound) {
				result.Status, result.ErrorCode = domain.OfflineOperationRejected, "access_revoked"
				return result, nil
			}
			return result, err
		}
		result.Status, result.ServerVersion = domain.OfflineOperationApplied, task.Version
		return result, nil
	default:
		result.Status, result.ErrorCode = domain.OfflineOperationRejected, "operation_not_allowed"
		return result, nil
	}
}

func (s *Server) offlineTaskConflict(ctx context.Context, record *repository.OfflineAuthRecordV2, operation domain.OfflineOperation, task *domain.Task, paths []string) (domain.OfflineOperationResult, error) {
	result := domain.OfflineOperationResult{OperationID: operation.OperationID, ResourceID: operation.ResourceID, Status: domain.OfflineOperationConflict, ServerVersion: task.Version}
	server, _ := json.Marshal(task)
	conflictID, err := s.repos.Offline.CreateConflict(ctx, record, operation, task.Version, server, paths)
	if err != nil {
		return result, err
	}
	result.ConflictID = &conflictID
	return result, nil
}

func parseOfflineTaskSimplePatch(raw json.RawMessage, requireTitle bool) (offlineTaskSimplePatch, error) {
	var patch offlineTaskSimplePatch
	var fields map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return patch, errors.New("invalid task patch")
	}
	allowed := map[string]bool{"title": true, "description": true, "start_at": true, "due_at": true, "due_end_at": true, "is_all_day": true, "priority": true}
	for key := range fields {
		if !allowed[key] {
			return patch, errors.New("unsupported task field")
		}
	}
	if value, ok := fields["title"]; ok {
		patch.TitleSet = true
		if err := json.Unmarshal(value, &patch.Title); err != nil {
			return patch, err
		}
		patch.Title = strings.TrimSpace(patch.Title)
		if patch.Title == "" || len(patch.Title) > 2000 {
			return patch, errors.New("invalid title")
		}
	}
	if requireTitle && !patch.TitleSet {
		return patch, errors.New("title required")
	}
	if value, ok := fields["description"]; ok {
		patch.DescriptionSet = true
		if err := json.Unmarshal(value, &patch.Description); err != nil || len(patch.Description) > 100000 {
			return patch, errors.New("invalid description")
		}
	}
	for key, target := range map[string]struct {
		set  *bool
		date **time.Time
	}{"start_at": {&patch.StartAtSet, &patch.StartAt}, "due_at": {&patch.DueAtSet, &patch.DueAt}, "due_end_at": {&patch.DueEndAtSet, &patch.DueEndAt}} {
		if value, ok := fields[key]; ok {
			*target.set = true
			if string(value) == "null" {
				*target.date = nil
				continue
			}
			var text string
			if err := json.Unmarshal(value, &text); err != nil {
				return patch, errors.New("invalid date")
			}
			parsed, err := time.Parse(time.RFC3339, text)
			if err != nil {
				return patch, errors.New("invalid date")
			}
			*target.date = &parsed
		}
	}
	if value, ok := fields["is_all_day"]; ok {
		patch.IsAllDaySet = true
		if err := json.Unmarshal(value, &patch.IsAllDay); err != nil {
			return patch, err
		}
	}
	if value, ok := fields["priority"]; ok {
		patch.PrioritySet = true
		if err := json.Unmarshal(value, &patch.Priority); err != nil || !validTaskPriority(patch.Priority) {
			return patch, errors.New("invalid priority")
		}
	}
	if patch.StartAt != nil && patch.DueAt != nil && patch.DueAt.Before(*patch.StartAt) {
		return patch, errors.New("due date before start")
	}
	if patch.DueAt != nil && patch.DueEndAt != nil && patch.DueEndAt.Before(*patch.DueAt) {
		return patch, errors.New("due end before due date")
	}
	return patch, nil
}

func applyOfflineTaskPatch(task *domain.Task, patch offlineTaskSimplePatch) {
	if patch.TitleSet {
		task.Title = patch.Title
	}
	if patch.DescriptionSet {
		task.Description = patch.Description
	}
	if patch.StartAtSet {
		task.StartAt = patch.StartAt
	}
	if patch.DueAtSet {
		task.DueAt = patch.DueAt
	}
	if patch.DueEndAtSet {
		task.DueEndAt = patch.DueEndAt
	}
	if patch.IsAllDaySet {
		task.IsAllDay = patch.IsAllDay
	}
	if patch.PrioritySet {
		task.Priority = patch.Priority
	}
}

func offlineTaskMatchesPatch(task *domain.Task, patch offlineTaskSimplePatch) bool {
	if patch.TitleSet && task.Title != patch.Title || patch.DescriptionSet && task.Description != patch.Description || patch.IsAllDaySet && task.IsAllDay != patch.IsAllDay || patch.PrioritySet && task.Priority != patch.Priority {
		return false
	}
	return (!patch.StartAtSet || equalOfflineTimes(task.StartAt, patch.StartAt)) && (!patch.DueAtSet || equalOfflineTimes(task.DueAt, patch.DueAt)) && (!patch.DueEndAtSet || equalOfflineTimes(task.DueEndAt, patch.DueEndAt))
}

func equalOfflineTimes(left, right *time.Time) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.Equal(*right)
}

func offlineTaskPatchPaths(patch offlineTaskSimplePatch) []string {
	paths := make([]string, 0, 7)
	if patch.TitleSet {
		paths = append(paths, "title")
	}
	if patch.DescriptionSet {
		paths = append(paths, "description")
	}
	if patch.StartAtSet {
		paths = append(paths, "start_at")
	}
	if patch.DueAtSet {
		paths = append(paths, "due_at")
	}
	if patch.DueEndAtSet {
		paths = append(paths, "due_end_at")
	}
	if patch.IsAllDaySet {
		paths = append(paths, "is_all_day")
	}
	if patch.PrioritySet {
		paths = append(paths, "priority")
	}
	return paths
}
