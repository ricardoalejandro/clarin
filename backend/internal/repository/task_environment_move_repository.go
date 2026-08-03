package repository

import (
	"context"
	"encoding/json"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrTaskMoveAccessConfirmation = errors.New("task move changes participant access")

type TaskEnvironmentMoveResult struct {
	TaskIDs           []uuid.UUID
	SourceListID      uuid.UUID
	DestinationListID uuid.UUID
}

// MoveTaskToEnvironment is the single atomic cross-environment move. It locks
// the root, its children, both lists and both environments; verifies source
// governance and destination edit access; maps every status by category; and,
// only after explicit confirmation, grants Edit to participants who would
// otherwise lose task visibility.
func (r *TaskWorkRepository) MoveTaskToEnvironment(ctx context.Context, accountID, actorID, taskID, destinationListID uuid.UUID, expectedVersion int64, confirmGrants bool, operationID uuid.UUID) (*TaskEnvironmentMoveResult, []uuid.UUID, error) {
	if expectedVersion < 1 || taskID == uuid.Nil || destinationListID == uuid.Nil {
		return nil, nil, ErrTaskBulkMoveInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)

	var sourceListID uuid.UUID
	var version int64
	var accessMode string
	var programID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT list_id,COALESCE(version,1),COALESCE(access_mode,'inherit'),program_id
		FROM tasks WHERE account_id=$1 AND id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL FOR UPDATE`, accountID, taskID).
		Scan(&sourceListID, &version, &accessMode, &programID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrTaskWorkNotFound
		}
		return nil, nil, err
	}
	if version != expectedVersion {
		return nil, nil, ErrTaskVersionConflict
	}
	if programID != nil {
		return nil, nil, ErrTaskBulkMoveInvalid
	}

	type listContext struct{ environmentID, workflowID uuid.UUID }
	lists := make(map[uuid.UUID]listContext, 2)
	listIDs := []uuid.UUID{sourceListID, destinationListID}
	sort.Slice(listIDs, func(i, j int) bool { return listIDs[i].String() < listIDs[j].String() })
	rows, err := tx.Query(ctx, `SELECT id,environment_id,workflow_id FROM task_lists
		WHERE account_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL ORDER BY id FOR UPDATE`, accountID, listIDs)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var id uuid.UUID
		var item listContext
		if err := rows.Scan(&id, &item.environmentID, &item.workflowID); err != nil {
			rows.Close()
			return nil, nil, err
		}
		lists[id] = item
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	if len(lists) != 2 || lists[sourceListID].environmentID == lists[destinationListID].environmentID {
		return nil, nil, ErrTaskBulkMoveInvalid
	}

	environmentIDs := []uuid.UUID{lists[sourceListID].environmentID, lists[destinationListID].environmentID}
	sort.Slice(environmentIDs, func(i, j int) bool { return environmentIDs[i].String() < environmentIDs[j].String() })
	environmentRows, err := tx.Query(ctx, `SELECT id FROM task_environments
		WHERE account_id=$1 AND id=ANY($2::uuid[]) AND archived_at IS NULL ORDER BY id FOR UPDATE`, accountID, environmentIDs)
	if err != nil {
		return nil, nil, err
	}
	lockedEnvironments := 0
	for environmentRows.Next() {
		var lockedEnvironmentID uuid.UUID
		if err := environmentRows.Scan(&lockedEnvironmentID); err != nil {
			environmentRows.Close()
			return nil, nil, err
		}
		lockedEnvironments++
	}
	if err := environmentRows.Err(); err != nil {
		environmentRows.Close()
		return nil, nil, err
	}
	environmentRows.Close()
	if lockedEnvironments != 2 {
		return nil, nil, ErrTaskWorkNotFound
	}

	sourceAccess, err := resolveTaskAccessWith(ctx, tx, accountID, actorID, taskID)
	if err != nil {
		return nil, nil, err
	}
	if !TaskAccessAllows(sourceAccess.Access, domain.TaskAccessFull) {
		if !sourceAccess.Access.CanView {
			return nil, nil, ErrTaskWorkNotFound
		}
		return nil, nil, ErrTaskAccessDenied
	}
	destinationAccess, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, lists[destinationListID].environmentID)
	if err != nil {
		return nil, nil, err
	}
	if !TaskAccessAllows(destinationAccess, domain.TaskAccessEdit) {
		if !destinationAccess.CanView {
			return nil, nil, ErrTaskWorkNotFound
		}
		return nil, nil, ErrTaskAccessDenied
	}

	type movedTask struct {
		id       uuid.UUID
		category string
	}
	moved := make([]movedTask, 0)
	taskRows, err := tx.Query(ctx, `SELECT task.id,
		COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
		FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND (task.id=$2 OR task.parent_task_id=$2) AND task.deleted_at IS NULL
		ORDER BY task.id FOR UPDATE OF task`, accountID, taskID)
	if err != nil {
		return nil, nil, err
	}
	for taskRows.Next() {
		item := movedTask{}
		if err := taskRows.Scan(&item.id, &item.category); err != nil {
			taskRows.Close()
			return nil, nil, err
		}
		moved = append(moved, item)
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, nil, err
	}
	taskRows.Close()
	if len(moved) == 0 {
		return nil, nil, ErrTaskWorkNotFound
	}

	statusByCategory := make(map[string]uuid.UUID)
	statusRows, err := tx.Query(ctx, `SELECT id,category FROM task_statuses
		WHERE account_id=$1 AND workflow_id=$2 ORDER BY category,is_default DESC,sort_order,id FOR SHARE`,
		accountID, lists[destinationListID].workflowID)
	if err != nil {
		return nil, nil, err
	}
	for statusRows.Next() {
		var id uuid.UUID
		var category string
		if err := statusRows.Scan(&id, &category); err != nil {
			statusRows.Close()
			return nil, nil, err
		}
		if _, exists := statusByCategory[category]; !exists {
			statusByCategory[category] = id
		}
	}
	if err := statusRows.Err(); err != nil {
		statusRows.Close()
		return nil, nil, err
	}
	statusRows.Close()
	for _, item := range moved {
		if statusByCategory[item.category] == uuid.Nil {
			return nil, nil, ErrTaskStatusMappingInvalid
		}
	}
	// Both list rows are already locked. Allocate the root at the durable tail
	// of the destination while preserving each child's order inside its parent.
	// Task creation uses the same list lock, so concurrent creates and moves
	// cannot observe the same MAX(sort_order).
	var destinationSortOrder int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM tasks
		WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL`,
		accountID, destinationListID).Scan(&destinationSortOrder); err != nil {
		return nil, nil, err
	}

	participantRows, err := tx.Query(ctx, `SELECT participant.user_id FROM (
		SELECT assigned_to AS user_id FROM tasks WHERE account_id=$1 AND id=$2
		UNION SELECT collaborator.user_id FROM task_collaborators collaborator
		WHERE collaborator.account_id=$1 AND collaborator.task_id=$2
	) participant WHERE participant.user_id IS NOT NULL ORDER BY participant.user_id`, accountID, taskID)
	if err != nil {
		return nil, nil, err
	}
	participants := make([]uuid.UUID, 0)
	for participantRows.Next() {
		var id uuid.UUID
		if err := participantRows.Scan(&id); err != nil {
			participantRows.Close()
			return nil, nil, err
		}
		participants = append(participants, id)
	}
	if err := participantRows.Err(); err != nil {
		participantRows.Close()
		return nil, nil, err
	}
	participantRows.Close()

	affected := make([]uuid.UUID, 0)
	for _, participantID := range participants {
		environmentAccess, _, resolveErr := resolveEnvironmentAccessWith(ctx, tx, accountID, participantID, lists[destinationListID].environmentID)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		if environmentAccess == nil || !environmentAccess.CanView {
			return nil, nil, ErrTaskAccessInvalid
		}
		var directLevel *string
		if err := tx.QueryRow(ctx, `SELECT access_level FROM task_access_grants
			WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, accountID, taskID, participantID).Scan(&directLevel); err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, err
		}
		hasParticipantAccess := false
		if directLevel != nil {
			hasParticipantAccess = taskAccessRank(*directLevel) >= taskAccessRank(domain.TaskAccessEdit)
		} else if accessMode != "private" {
			participantAccess, _, resolveErr := resolveContainerAccessWith(ctx, tx, accountID, participantID, destinationListID, domain.TaskAccessTargetList)
			if resolveErr != nil {
				return nil, nil, resolveErr
			}
			hasParticipantAccess = participantAccess.CanEdit
		}
		if !hasParticipantAccess {
			affected = append(affected, participantID)
		}
	}
	if len(affected) > 0 && !confirmGrants {
		return nil, affected, ErrTaskMoveAccessConfirmation
	}

	var beforeState []byte
	if len(affected) > 0 {
		beforeState, err = accessStateJSON(ctx, tx, accountID, "task_access_grants", "task_id", taskID, accessMode)
		if err != nil {
			return nil, nil, err
		}
		for _, participantID := range affected {
			if _, err := tx.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,can_manage_access,created_by)
				VALUES($1,$2,$3,'edit',FALSE,$4)
				ON CONFLICT(account_id,task_id,user_id) DO UPDATE SET
					access_level=CASE WHEN task_access_grants.access_level='full' THEN 'full' ELSE 'edit' END,
					can_manage_access=CASE WHEN task_access_grants.access_level='full' THEN task_access_grants.can_manage_access ELSE FALSE END,
					updated_at=NOW()`, accountID, taskID, participantID, actorID); err != nil {
				return nil, nil, err
			}
		}
	}

	for _, item := range moved {
		legacyStatus := domain.TaskStatusPending
		if item.category == domain.TaskStatusCategoryDone {
			legacyStatus = domain.TaskStatusCompleted
		} else if item.category == domain.TaskStatusCategoryCancelled {
			legacyStatus = domain.TaskStatusCancelled
		}
		if _, err := tx.Exec(ctx, `UPDATE tasks SET list_id=$3,status_id=$4,status=$5,
			sort_order=CASE WHEN id=$8 THEN $9 ELSE sort_order END,
			progress=CASE WHEN $6='done' THEN 100 WHEN status='completed' AND progress=100 THEN 0 ELSE progress END,
			completed_at=CASE WHEN $6='done' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
			completed_by=CASE WHEN $6='done' THEN COALESCE(completed_by,$7) ELSE NULL END,
			overdue_notified_at=NULL,updated_at=NOW(),version=COALESCE(version,1)+1
			WHERE account_id=$1 AND id=$2`, accountID, item.id, destinationListID, statusByCategory[item.category], legacyStatus, item.category, actorID, taskID, destinationSortOrder); err != nil {
			return nil, nil, err
		}
	}
	metadata, _ := json.Marshal(map[string]any{"from_list_id": sourceListID, "to_list_id": destinationListID,
		"from_environment_id": lists[sourceListID].environmentID, "to_environment_id": lists[destinationListID].environmentID,
		"operation_id": operationID})
	if _, err := tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
		VALUES($1,$2,$3,'environment_moved',$4::jsonb)`, accountID, taskID, actorID, metadata); err != nil {
		return nil, nil, err
	}
	if len(affected) > 0 {
		var revision int64
		if err := tx.QueryRow(ctx, `UPDATE tasks SET access_revision=COALESCE(access_revision,1)+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND parent_task_id IS NULL RETURNING access_revision`, accountID, taskID).Scan(&revision); err != nil {
			return nil, nil, err
		}
		afterState, err := accessStateJSON(ctx, tx, accountID, "task_access_grants", "task_id", taskID, accessMode)
		if err != nil {
			return nil, nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
			VALUES($1,$2,'task',$3,'environment_move_grants',$4::jsonb,$5::jsonb,$6)`, accountID, actorID, taskID, beforeState, afterState, operationID); err != nil {
			return nil, nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	ids := make([]uuid.UUID, 0, len(moved))
	for _, item := range moved {
		ids = append(ids, item.id)
	}
	return &TaskEnvironmentMoveResult{TaskIDs: ids, SourceListID: sourceListID, DestinationListID: destinationListID}, affected, nil
}
