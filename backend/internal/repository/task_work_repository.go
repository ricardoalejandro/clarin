package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskWorkNotFound             = errors.New("task work item not found")
	ErrTaskDependencyCycle          = errors.New("task dependency would create a cycle")
	ErrTaskStatusInUse              = errors.New("task status is in use")
	ErrTaskWorkflowInvalid          = errors.New("task workflow requires initial and completed statuses")
	ErrTaskVersionConflict          = errors.New("task was updated concurrently")
	ErrTaskOrderInvalid             = errors.New("task order does not represent one complete scope")
	ErrTaskSavedViewNameConflict    = errors.New("task saved view name already exists")
	ErrTaskSavedViewDefaultConflict = errors.New("task saved view default changed concurrently")
	ErrTaskCollaboratorInvalid      = errors.New("task collaborator does not belong to account")
	ErrTaskStatusMappingInvalid     = errors.New("task statuses cannot be mapped to target workflow")
	ErrTaskStatusOrderInvalid       = errors.New("task status order does not match workflow statuses")
	ErrTaskContainerNotEmpty        = errors.New("task folder or list contains active tasks")
	ErrTaskParentArchived           = errors.New("task parent must be restored first")
)

type TaskMoveResult struct {
	ListID   uuid.UUID
	StatusID uuid.UUID
	TaskIDs  []uuid.UUID
	Version  int64
}

func taskMoveStatusMatches(workflowID *uuid.UUID, category *string, targetWorkflowID uuid.UUID, targetCategory string) bool {
	return workflowID != nil && category != nil && *workflowID == targetWorkflowID && *category == targetCategory
}

func taskSavedViewWriteError(err error) error {
	if err == nil {
		return nil
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		if pgErr.ConstraintName == "uq_task_saved_views_default" {
			return ErrTaskSavedViewDefaultConflict
		}
		return ErrTaskSavedViewNameConflict
	}
	return err
}

type TaskWorkRepository struct {
	db *pgxpool.Pool
}

func (r *TaskWorkRepository) UserBelongsToAccount(ctx context.Context, accountID, userID uuid.UUID) (bool, error) {
	var ok bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$2)`, accountID, userID).Scan(&ok)
	return ok, err
}

func (r *TaskWorkRepository) TaskBelongsToAccount(ctx context.Context, accountID, taskID uuid.UUID) (bool, error) {
	var ok bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL)`, accountID, taskID).Scan(&ok)
	return ok, err
}

func (r *TaskWorkRepository) EnsureDefaultList(ctx context.Context, accountID, userID uuid.UUID) (*uuid.UUID, error) {
	if _, err := r.db.Exec(ctx, `
		INSERT INTO task_lists(account_id,workflow_id,workflow_inherited,is_default,name,description,color,sort_order,created_by)
		SELECT $1,w.id,TRUE,TRUE,'Bandeja general','Tareas sin una lista específica','#10b981',0,$2
		FROM task_workflows w
		WHERE w.account_id=$1 AND w.is_default
		ON CONFLICT (account_id) WHERE is_default AND archived_at IS NULL DO NOTHING
	`, accountID, userID); err != nil {
		return nil, err
	}
	var id uuid.UUID
	if err := r.db.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND is_default AND archived_at IS NULL LIMIT 1`, accountID).Scan(&id); err != nil {
		return nil, err
	}
	return &id, nil
}

func (r *TaskWorkRepository) ListFolders(ctx context.Context, accountID uuid.UUID) ([]*domain.TaskFolder, []*domain.TaskList, error) {
	rows, err := r.db.Query(ctx, `
		SELECT f.id,f.account_id,f.workflow_id,f.name,f.description,f.color,f.sort_order,f.created_by,
			f.archived_at,f.created_at,f.updated_at,
			COUNT(t.id) FILTER (WHERE t.deleted_at IS NULL)
		FROM task_folders f
		LEFT JOIN task_lists l ON l.account_id=f.account_id AND l.folder_id=f.id AND l.archived_at IS NULL
		LEFT JOIN tasks t ON t.account_id=f.account_id AND t.list_id=l.id AND t.parent_task_id IS NULL
		WHERE f.account_id=$1 AND f.archived_at IS NULL
		GROUP BY f.id
		ORDER BY f.sort_order,f.created_at
	`, accountID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	folders := []*domain.TaskFolder{}
	byID := map[uuid.UUID]*domain.TaskFolder{}
	for rows.Next() {
		folder := &domain.TaskFolder{}
		if err := rows.Scan(&folder.ID, &folder.AccountID, &folder.WorkflowID, &folder.Name, &folder.Description,
			&folder.Color, &folder.SortOrder, &folder.CreatedBy, &folder.ArchivedAt, &folder.CreatedAt,
			&folder.UpdatedAt, &folder.TaskCount); err != nil {
			return nil, nil, err
		}
		folder.Lists = []*domain.TaskList{}
		folders = append(folders, folder)
		byID[folder.ID] = folder
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	lists, err := (&TaskRepository{db: r.db}).GetListsByAccount(ctx, accountID)
	if err != nil {
		return nil, nil, err
	}
	root := []*domain.TaskList{}
	for _, list := range lists {
		if list.FolderID == nil {
			root = append(root, list)
			continue
		}
		if folder := byID[*list.FolderID]; folder != nil {
			folder.Lists = append(folder.Lists, list)
		}
	}
	return folders, root, nil
}

func (r *TaskWorkRepository) CreateFolder(ctx context.Context, folder *domain.TaskFolder) error {
	folder.ID = uuid.New()
	folder.CreatedAt = time.Now()
	folder.UpdatedAt = folder.CreatedAt
	if folder.WorkflowID == nil {
		var workflowID uuid.UUID
		if err := r.db.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND is_default LIMIT 1`, folder.AccountID).Scan(&workflowID); err != nil {
			return err
		}
		folder.WorkflowID = &workflowID
	} else {
		var valid bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, folder.AccountID, folder.WorkflowID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrTaskWorkNotFound
		}
	}
	if folder.Color == "" {
		folder.Color = "#10b981"
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO task_folders(id,account_id,workflow_id,name,description,color,sort_order,created_by,created_at,updated_at)
		SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sort_order)+1,0),$7,$8,$8
		FROM task_folders WHERE account_id=$2
		RETURNING sort_order
	`, folder.ID, folder.AccountID, folder.WorkflowID, folder.Name, folder.Description, folder.Color,
		folder.CreatedBy, folder.CreatedAt).Scan(&folder.SortOrder)
}

func (r *TaskWorkRepository) UpdateFolder(ctx context.Context, accountID, folderID uuid.UUID, name, description, color *string, workflowID *uuid.UUID, workflowProvided bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	resolvedWorkflowID := workflowID
	if workflowProvided && resolvedWorkflowID == nil {
		var defaultWorkflowID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND is_default`, accountID).Scan(&defaultWorkflowID); err != nil {
			return err
		}
		resolvedWorkflowID = &defaultWorkflowID
	}
	if resolvedWorkflowID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, accountID, resolvedWorkflowID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrTaskWorkNotFound
		}
	}
	command, err := tx.Exec(ctx, `
		UPDATE task_folders SET
			name=COALESCE($3::text,name), description=COALESCE($4::text,description),
			color=COALESCE($5::text,color), workflow_id=CASE WHEN $7::boolean THEN $6::uuid ELSE workflow_id END, updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
	`, accountID, folderID, name, description, color, resolvedWorkflowID, workflowProvided)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if workflowProvided {
		listRows, err := tx.Query(ctx, `SELECT id FROM task_lists
			WHERE account_id=$1 AND folder_id=$2 AND workflow_inherited=TRUE
			ORDER BY id FOR UPDATE`, accountID, folderID)
		if err != nil {
			return err
		}
		listIDs := make([]uuid.UUID, 0)
		for listRows.Next() {
			var listID uuid.UUID
			if err := listRows.Scan(&listID); err != nil {
				listRows.Close()
				return err
			}
			listIDs = append(listIDs, listID)
		}
		if err := listRows.Err(); err != nil {
			listRows.Close()
			return err
		}
		listRows.Close()
		if _, err := tx.Exec(ctx, `UPDATE task_lists SET workflow_id=$3,updated_at=NOW()
			WHERE account_id=$1 AND folder_id=$2 AND workflow_inherited=TRUE`, accountID, folderID, resolvedWorkflowID); err != nil {
			return err
		}
		if err := remapListTaskStatuses(ctx, tx, accountID, listIDs, *resolvedWorkflowID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func remapListTaskStatuses(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, listIDs []uuid.UUID, targetWorkflowID uuid.UUID) error {
	if len(listIDs) == 0 {
		return nil
	}
	if err := lockTaskWorkflowStatuses(ctx, tx, accountID, targetWorkflowID); err != nil {
		return err
	}
	categorySQL := `COALESCE(current_status.category,CASE task.status
		WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)`
	var missing bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM tasks task
		LEFT JOIN task_statuses current_status ON current_status.account_id=task.account_id AND current_status.id=task.status_id
		WHERE task.account_id=$1 AND task.list_id=ANY($2::uuid[])
		  AND NOT EXISTS(
			SELECT 1 FROM task_statuses target
			WHERE target.account_id=task.account_id AND target.workflow_id=$3
			  AND target.category=`+categorySQL+`
		  )
	)`, accountID, listIDs, targetWorkflowID).Scan(&missing); err != nil {
		return err
	}
	if missing {
		return ErrTaskStatusMappingInvalid
	}
	_, err := tx.Exec(ctx, `WITH scoped AS (
		SELECT task.id,`+categorySQL+` AS category
		FROM tasks task
		LEFT JOIN task_statuses current_status ON current_status.account_id=task.account_id AND current_status.id=task.status_id
		WHERE task.account_id=$1 AND task.list_id=ANY($2::uuid[])
	), mapped AS (
		SELECT scoped.id,target.id AS status_id,target.category
		FROM scoped
		JOIN LATERAL (
			SELECT candidate.id,candidate.category FROM task_statuses candidate
			WHERE candidate.account_id=$1 AND candidate.workflow_id=$3 AND candidate.category=scoped.category
			ORDER BY candidate.is_default DESC,candidate.sort_order,candidate.id LIMIT 1
		) target ON TRUE
	)
	UPDATE tasks task SET
		status_id=mapped.status_id,
		status=CASE mapped.category WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'pending' END,
		progress=CASE WHEN mapped.category='done' THEN 100 ELSE task.progress END,
		completed_at=CASE WHEN mapped.category='done' THEN COALESCE(task.completed_at,NOW()) ELSE NULL END,
		completed_by=CASE WHEN mapped.category='done' THEN task.completed_by ELSE NULL END,
		overdue_notified_at=NULL,updated_at=NOW(),version=COALESCE(task.version,1)+1
	FROM mapped WHERE task.account_id=$1 AND task.id=mapped.id AND task.status_id IS DISTINCT FROM mapped.status_id`,
		accountID, listIDs, targetWorkflowID)
	return err
}

// lockTaskWorkflowStatuses protects category-based validation and remapping
// from a concurrent status edit or deletion between the validation query and
// the UPDATE that consumes its result. FOR SHARE conflicts with category
// updates; FOR KEY SHARE would not.
func lockTaskWorkflowStatuses(ctx context.Context, tx pgx.Tx, accountID, workflowID uuid.UUID) error {
	rows, err := tx.Query(ctx, `SELECT id FROM task_statuses
		WHERE account_id=$1 AND workflow_id=$2 ORDER BY id FOR SHARE`, accountID, workflowID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var statusID uuid.UUID
		if err := rows.Scan(&statusID); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return nil
}

func (r *TaskWorkRepository) ArchiveFolder(ctx context.Context, accountID, folderID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT id FROM task_folders WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, folderID).Scan(new(uuid.UUID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	listRows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return err
	}
	for listRows.Next() {
		var lockedListID uuid.UUID
		if err := listRows.Scan(&lockedListID); err != nil {
			listRows.Close()
			return err
		}
	}
	if err := listRows.Err(); err != nil {
		listRows.Close()
		return err
	}
	listRows.Close()
	var activeTasks int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists list
		ON list.account_id=task.account_id AND list.id=task.list_id
		WHERE task.account_id=$1 AND list.folder_id=$2 AND task.deleted_at IS NULL`, accountID, folderID).Scan(&activeTasks); err != nil {
		return err
	}
	if activeTasks > 0 {
		return ErrTaskContainerNotEmpty
	}
	command, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, folderID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET folder_id=NULL,workflow_inherited=TRUE,updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND is_default AND archived_at IS NULL`, accountID, folderID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND NOT is_default AND archived_at IS NULL`, accountID, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateListLocation(ctx context.Context, accountID, listID uuid.UUID, folderID *uuid.UUID, folderProvided bool, workflowID *uuid.UUID, inherited *bool, description, name, color *string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var observedFolderID *uuid.UUID
	var observedWorkflowID uuid.UUID
	var observedInherited, observedDefault bool
	if err := tx.QueryRow(ctx, `SELECT folder_id,workflow_id,workflow_inherited,is_default FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, listID).
		Scan(&observedFolderID, &observedWorkflowID, &observedInherited, &observedDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	finalFolderID := observedFolderID
	if folderProvided {
		if observedDefault && folderID != nil {
			return ErrDefaultTaskList
		}
		finalFolderID = folderID
	}
	folderIDs := make([]uuid.UUID, 0, 2)
	seenFolders := make(map[uuid.UUID]struct{}, 2)
	for _, candidate := range []*uuid.UUID{observedFolderID, finalFolderID} {
		if candidate == nil {
			continue
		}
		if _, duplicate := seenFolders[*candidate]; duplicate {
			continue
		}
		seenFolders[*candidate] = struct{}{}
		folderIDs = append(folderIDs, *candidate)
	}
	folderWorkflows := make(map[uuid.UUID]uuid.UUID, len(folderIDs))
	if len(folderIDs) > 0 {
		folderRows, err := tx.Query(ctx, `SELECT id,workflow_id,archived_at FROM task_folders
			WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, folderIDs)
		if err != nil {
			return err
		}
		for folderRows.Next() {
			var id, folderWorkflow uuid.UUID
			var archivedAt *time.Time
			if err := folderRows.Scan(&id, &folderWorkflow, &archivedAt); err != nil {
				folderRows.Close()
				return err
			}
			if archivedAt != nil {
				folderRows.Close()
				return ErrTaskWorkNotFound
			}
			folderWorkflows[id] = folderWorkflow
		}
		if err := folderRows.Err(); err != nil {
			folderRows.Close()
			return err
		}
		folderRows.Close()
		if len(folderWorkflows) != len(folderIDs) {
			return ErrTaskWorkNotFound
		}
	}
	var currentFolderID *uuid.UUID
	var currentWorkflowID uuid.UUID
	var currentInherited, isDefault bool
	if err := tx.QueryRow(ctx, `SELECT folder_id,workflow_id,workflow_inherited,is_default FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, listID).
		Scan(&currentFolderID, &currentWorkflowID, &currentInherited, &isDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if !taskUUIDPointersEqual(observedFolderID, currentFolderID) || observedWorkflowID != currentWorkflowID ||
		observedInherited != currentInherited || observedDefault != isDefault {
		return ErrTaskVersionConflict
	}
	var folderWorkflowID *uuid.UUID
	if finalFolderID != nil {
		id := folderWorkflows[*finalFolderID]
		folderWorkflowID = &id
	}
	finalInherited := currentInherited
	if inherited != nil {
		finalInherited = *inherited
	}
	finalWorkflowID := currentWorkflowID
	if workflowID != nil {
		finalWorkflowID = *workflowID
	}
	if finalInherited {
		if folderWorkflowID != nil {
			finalWorkflowID = *folderWorkflowID
		} else if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND is_default`, accountID).Scan(&finalWorkflowID); err != nil {
			return err
		}
	}
	var workflowValid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, accountID, finalWorkflowID).Scan(&workflowValid); err != nil {
		return err
	}
	if !workflowValid {
		return ErrTaskWorkNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET folder_id=$3,workflow_id=$4,
		workflow_inherited=$5,description=COALESCE($6::text,description),
		name=COALESCE($7::text,name),color=COALESCE($8::text,color),updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, listID, finalFolderID, finalWorkflowID, finalInherited, description, name, color); err != nil {
		return err
	}
	if finalWorkflowID != currentWorkflowID {
		if err := remapListTaskStatuses(ctx, tx, accountID, []uuid.UUID{listID}, finalWorkflowID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ListWorkflows(ctx context.Context, accountID uuid.UUID) ([]*domain.TaskWorkflow, error) {
	rows, err := r.db.Query(ctx, `
		SELECT w.id,w.account_id,w.name,w.is_default,w.created_by,w.created_at,w.updated_at,
			s.id,s.name,s.color,s.category,s.sort_order,s.is_default,s.created_at,s.updated_at
		FROM task_workflows w
		LEFT JOIN task_statuses s ON s.account_id=w.account_id AND s.workflow_id=w.id
		WHERE w.account_id=$1
		ORDER BY w.is_default DESC,w.name,s.sort_order,s.created_at
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	workflows := []*domain.TaskWorkflow{}
	byID := map[uuid.UUID]*domain.TaskWorkflow{}
	for rows.Next() {
		var workflowID, workflowAccountID uuid.UUID
		var name string
		var isDefault bool
		var createdBy *uuid.UUID
		var createdAt, updatedAt time.Time
		var statusID *uuid.UUID
		var statusName, color, category *string
		var sortOrder *int
		var statusDefault *bool
		var statusCreatedAt, statusUpdatedAt *time.Time
		if err := rows.Scan(&workflowID, &workflowAccountID, &name, &isDefault, &createdBy, &createdAt, &updatedAt,
			&statusID, &statusName, &color, &category, &sortOrder, &statusDefault, &statusCreatedAt, &statusUpdatedAt); err != nil {
			return nil, err
		}
		workflow := byID[workflowID]
		if workflow == nil {
			workflow = &domain.TaskWorkflow{ID: workflowID, AccountID: workflowAccountID, Name: name,
				IsDefault: isDefault, CreatedBy: createdBy, CreatedAt: createdAt, UpdatedAt: updatedAt,
				Statuses: []*domain.TaskStatus{}}
			workflows = append(workflows, workflow)
			byID[workflowID] = workflow
		}
		if statusID != nil {
			workflow.Statuses = append(workflow.Statuses, &domain.TaskStatus{ID: *statusID, AccountID: workflowAccountID,
				WorkflowID: workflowID, Name: *statusName, Color: *color, Category: *category,
				SortOrder: *sortOrder, IsDefault: *statusDefault, CreatedAt: *statusCreatedAt, UpdatedAt: *statusUpdatedAt})
		}
	}
	return workflows, rows.Err()
}

func (r *TaskWorkRepository) CreateWorkflow(ctx context.Context, workflow *domain.TaskWorkflow, statuses []*domain.TaskStatus) error {
	if !taskWorkflowStatusesValid(statuses) {
		return ErrTaskWorkflowInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	workflow.ID = uuid.New()
	workflow.CreatedAt = time.Now()
	workflow.UpdatedAt = workflow.CreatedAt
	if _, err := tx.Exec(ctx, `INSERT INTO task_workflows(id,account_id,name,is_default,created_by,created_at,updated_at)
		VALUES($1,$2,$3,FALSE,$4,$5,$5)`, workflow.ID, workflow.AccountID, workflow.Name, workflow.CreatedBy, workflow.CreatedAt); err != nil {
		return err
	}
	for i, status := range statuses {
		status.ID = uuid.New()
		status.AccountID = workflow.AccountID
		status.WorkflowID = workflow.ID
		status.SortOrder = i
		status.CreatedAt = workflow.CreatedAt
		status.UpdatedAt = workflow.CreatedAt
		if _, err := tx.Exec(ctx, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default,created_at,updated_at)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`, status.ID, status.AccountID, status.WorkflowID,
			status.Name, status.Color, status.Category, status.SortOrder, status.IsDefault, status.CreatedAt); err != nil {
			return err
		}
	}
	workflow.Statuses = statuses
	return tx.Commit(ctx)
}

func taskWorkflowStatusesValid(statuses []*domain.TaskStatus) bool {
	defaultCount, initialCount, doneCount := 0, 0, 0
	for _, status := range statuses {
		if status == nil {
			return false
		}
		if status.Category == domain.TaskStatusCategoryNotStarted {
			initialCount++
		}
		if status.Category == domain.TaskStatusCategoryDone {
			doneCount++
		}
		if status.IsDefault {
			defaultCount++
			if status.Category != domain.TaskStatusCategoryNotStarted {
				return false
			}
		}
	}
	return initialCount > 0 && doneCount > 0 && defaultCount == 1
}

func (r *TaskWorkRepository) CreateStatus(ctx context.Context, status *domain.TaskStatus) error {
	if status.IsDefault && status.Category != domain.TaskStatusCategoryNotStarted {
		return ErrTaskWorkflowInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, status.AccountID, status.WorkflowID).Scan(new(uuid.UUID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	status.ID = uuid.New()
	status.CreatedAt = time.Now()
	status.UpdatedAt = status.CreatedAt
	if status.IsDefault {
		if _, err := tx.Exec(ctx, `UPDATE task_statuses SET is_default=FALSE,updated_at=NOW() WHERE account_id=$1 AND workflow_id=$2`, status.AccountID, status.WorkflowID); err != nil {
			return err
		}
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default,created_at,updated_at)
		SELECT $1,$2,$3,$4,$5,$6,COALESCE(MAX(sort_order)+1,0),$7,$8,$8
		FROM task_statuses WHERE account_id=$2 AND workflow_id=$3
		RETURNING sort_order
	`, status.ID, status.AccountID, status.WorkflowID, status.Name, status.Color, status.Category,
		status.IsDefault, status.CreatedAt).Scan(&status.SortOrder); err != nil {
		return err
	}
	if !status.IsDefault {
		var adoptedID *uuid.UUID
		if err := tx.QueryRow(ctx, `WITH candidate AS (
			SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category='not_started'
			ORDER BY sort_order,created_at,id LIMIT 1
		), adopted AS (
			UPDATE task_statuses status SET is_default=TRUE,updated_at=NOW()
			FROM candidate WHERE status.id=candidate.id
			  AND NOT EXISTS(SELECT 1 FROM task_statuses current_default WHERE current_default.workflow_id=$2 AND current_default.is_default)
			RETURNING status.id
		) SELECT id FROM adopted UNION ALL SELECT NULL::uuid WHERE NOT EXISTS(SELECT 1 FROM adopted) LIMIT 1`,
			status.AccountID, status.WorkflowID).Scan(&adoptedID); err != nil {
			return err
		}
		status.IsDefault = adoptedID != nil && *adoptedID == status.ID
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateStatus(ctx context.Context, accountID, statusID uuid.UUID, name, color, category *string, sortOrder *int) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var observedWorkflowID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT workflow_id FROM task_statuses WHERE account_id=$1 AND id=$2`, accountID, statusID).Scan(&observedWorkflowID); err != nil {
		return ErrTaskWorkNotFound
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, observedWorkflowID).Scan(new(uuid.UUID)); err != nil {
		return ErrTaskWorkNotFound
	}
	var workflowID uuid.UUID
	var oldCategory string
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT workflow_id,category,is_default FROM task_statuses WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, statusID).Scan(&workflowID, &oldCategory, &isDefault); err != nil {
		return ErrTaskWorkNotFound
	}
	if category != nil && *category != oldCategory {
		if isDefault {
			return ErrTaskWorkflowInvalid
		}
		var tasksUsingStatus int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND status_id=$2`, accountID, statusID).Scan(&tasksUsingStatus); err != nil {
			return err
		}
		if tasksUsingStatus > 0 {
			return ErrTaskStatusInUse
		}
	}
	if category != nil && *category != oldCategory && (oldCategory == domain.TaskStatusCategoryNotStarted || oldCategory == domain.TaskStatusCategoryDone) {
		var alternatives int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category=$3 AND id<>$4`, accountID, workflowID, oldCategory, statusID).Scan(&alternatives); err != nil {
			return err
		}
		if alternatives == 0 {
			return ErrTaskWorkflowInvalid
		}
	}
	command, err := tx.Exec(ctx, `UPDATE task_statuses SET
		name=COALESCE($3::text,name),color=COALESCE($4::text,color),category=COALESCE($5::text,category),
		sort_order=COALESCE($6::int,sort_order),updated_at=NOW() WHERE account_id=$1 AND id=$2`,
		accountID, statusID, name, color, category, sortOrder)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func taskUUIDSetIsExact(expected, provided []uuid.UUID) bool {
	if len(expected) != len(provided) || len(expected) == 0 {
		return false
	}
	seen := make(map[uuid.UUID]struct{}, len(provided))
	for _, id := range provided {
		if _, duplicate := seen[id]; duplicate {
			return false
		}
		seen[id] = struct{}{}
	}
	for _, id := range expected {
		if _, exists := seen[id]; !exists {
			return false
		}
	}
	return true
}

func (r *TaskWorkRepository) ReorderStatuses(ctx context.Context, accountID, workflowID uuid.UUID, statusIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, workflowID).Scan(new(uuid.UUID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 ORDER BY id FOR UPDATE`, accountID, workflowID)
	if err != nil {
		return err
	}
	existing := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		existing = append(existing, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if !taskUUIDSetIsExact(existing, statusIDs) {
		return ErrTaskStatusOrderInvalid
	}
	if _, err := tx.Exec(ctx, `UPDATE task_statuses status SET
		sort_order=(ordered.position-1)::int,updated_at=NOW()
		FROM unnest($3::uuid[]) WITH ORDINALITY AS ordered(id,position)
		WHERE status.account_id=$1 AND status.workflow_id=$2 AND status.id=ordered.id`, accountID, workflowID, statusIDs); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) DeleteStatus(ctx context.Context, accountID, statusID uuid.UUID, replacementID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var workflowID uuid.UUID
	// Observe the workflow first, then freeze it. Holding the workflow prevents
	// a concurrent list creation from introducing a new list after the complete
	// list lock set below has been selected.
	if err := tx.QueryRow(ctx, `SELECT workflow_id FROM task_statuses WHERE account_id=$1 AND id=$2`, accountID, statusID).Scan(&workflowID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, workflowID).Scan(new(uuid.UUID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	listRows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 ORDER BY id FOR UPDATE`, accountID)
	if err != nil {
		return err
	}
	for listRows.Next() {
		var listID uuid.UUID
		if err := listRows.Scan(&listID); err != nil {
			listRows.Close()
			return err
		}
	}
	if err := listRows.Err(); err != nil {
		listRows.Close()
		return err
	}
	listRows.Close()

	affectedRows, err := tx.Query(ctx, `SELECT id FROM tasks
		WHERE account_id=$1 AND status_id=$2 ORDER BY id FOR UPDATE`, accountID, statusID)
	if err != nil {
		return err
	}
	affectedCount := 0
	for affectedRows.Next() {
		var taskID uuid.UUID
		if err := affectedRows.Scan(&taskID); err != nil {
			affectedRows.Close()
			return err
		}
		affectedCount++
	}
	if err := affectedRows.Err(); err != nil {
		affectedRows.Close()
		return err
	}
	affectedRows.Close()

	type lockedStatusInfo struct {
		category  string
		isDefault bool
	}
	statusRows, err := tx.Query(ctx, `SELECT id,category,is_default FROM task_statuses
		WHERE account_id=$1 AND workflow_id=$2 ORDER BY id FOR UPDATE`, accountID, workflowID)
	if err != nil {
		return err
	}
	lockedStatuses := make(map[uuid.UUID]lockedStatusInfo)
	for statusRows.Next() {
		var id uuid.UUID
		var status lockedStatusInfo
		if err := statusRows.Scan(&id, &status.category, &status.isDefault); err != nil {
			statusRows.Close()
			return err
		}
		lockedStatuses[id] = status
	}
	if err := statusRows.Err(); err != nil {
		statusRows.Close()
		return err
	}
	statusRows.Close()
	sourceStatus, sourceExists := lockedStatuses[statusID]
	if !sourceExists {
		return ErrTaskWorkNotFound
	}
	if sourceStatus.isDefault {
		return ErrTaskWorkflowInvalid
	}
	category := sourceStatus.category
	if category == domain.TaskStatusCategoryNotStarted || category == domain.TaskStatusCategoryDone {
		alternatives := 0
		for id, candidate := range lockedStatuses {
			if id != statusID && candidate.category == category {
				alternatives++
			}
		}
		if alternatives == 0 {
			return ErrTaskWorkflowInvalid
		}
	}
	if affectedCount > 0 && replacementID == nil {
		return ErrTaskStatusInUse
	}
	if replacementID != nil {
		replacement, replacementExists := lockedStatuses[*replacementID]
		if *replacementID == statusID || !replacementExists || replacement.category != category {
			return ErrTaskStatusInUse
		}
		if _, err := tx.Exec(ctx, `UPDATE tasks t SET status_id=$3,
			status=CASE replacement.category WHEN 'done' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'pending' END,
			progress=CASE WHEN replacement.category='done' THEN 100 ELSE t.progress END,
			completed_at=CASE WHEN replacement.category='done' THEN COALESCE(t.completed_at,NOW()) ELSE NULL END,
			completed_by=CASE WHEN replacement.category='done' THEN t.completed_by ELSE NULL END,
			updated_at=NOW(),version=version+1
			FROM task_statuses replacement
			WHERE t.account_id=$1 AND t.status_id=$2 AND replacement.account_id=$1 AND replacement.id=$3`, accountID, statusID, replacementID); err != nil {
			return err
		}
	}
	command, err := tx.Exec(ctx, `DELETE FROM task_statuses WHERE account_id=$1 AND id=$2`, accountID, statusID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ResolveStatus(ctx context.Context, accountID uuid.UUID, listID *uuid.UUID, statusID *uuid.UUID, category string) (*domain.TaskStatus, error) {
	status := &domain.TaskStatus{}
	if statusID != nil {
		err := r.db.QueryRow(ctx, `SELECT id,account_id,workflow_id,name,color,category,sort_order,is_default,created_at,updated_at
			FROM task_statuses WHERE account_id=$1 AND id=$2`, accountID, statusID).Scan(&status.ID, &status.AccountID,
			&status.WorkflowID, &status.Name, &status.Color, &status.Category, &status.SortOrder, &status.IsDefault,
			&status.CreatedAt, &status.UpdatedAt)
		if err != nil {
			return nil, err
		}
		if listID != nil {
			var valid bool
			if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_lists l WHERE l.account_id=$1 AND l.id=$2 AND l.workflow_id=$3)`, accountID, listID, status.WorkflowID).Scan(&valid); err != nil || !valid {
				if err != nil {
					return nil, err
				}
				return nil, ErrTaskWorkNotFound
			}
		} else {
			var valid bool
			if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2 AND is_default)`, accountID, status.WorkflowID).Scan(&valid); err != nil || !valid {
				if err != nil {
					return nil, err
				}
				return nil, ErrTaskWorkNotFound
			}
		}
		return status, nil
	}
	if category == "" {
		category = domain.TaskStatusCategoryNotStarted
	}
	query := `
		SELECT s.id,s.account_id,s.workflow_id,s.name,s.color,s.category,s.sort_order,s.is_default,s.created_at,s.updated_at
		FROM task_statuses s JOIN task_workflows w ON w.id=s.workflow_id AND w.account_id=s.account_id
		WHERE s.account_id=$1 AND s.category=$2 AND w.is_default
		ORDER BY s.is_default DESC,s.sort_order LIMIT 1`
	args := []any{accountID, category}
	if listID != nil {
		query = `SELECT s.id,s.account_id,s.workflow_id,s.name,s.color,s.category,s.sort_order,s.is_default,s.created_at,s.updated_at
			FROM task_lists l JOIN task_statuses s ON s.workflow_id=l.workflow_id AND s.account_id=l.account_id
			WHERE l.account_id=$1 AND l.id=$2 AND s.category=$3 ORDER BY s.is_default DESC,s.sort_order LIMIT 1`
		args = []any{accountID, *listID, category}
	}
	err := r.db.QueryRow(ctx, query, args...).Scan(&status.ID, &status.AccountID, &status.WorkflowID, &status.Name,
		&status.Color, &status.Category, &status.SortOrder, &status.IsDefault, &status.CreatedAt, &status.UpdatedAt)
	return status, err
}

// MoveTask atomically changes a task status and its manual position. Manual
// order is scoped to the whole list (or to the parent for child tasks), not to
// an individual status, so switching board columns never creates ambiguous
// duplicate positions.
func (r *TaskWorkRepository) MoveTask(ctx context.Context, accountID, taskID, statusID uuid.UUID, beforeTaskID *uuid.UUID, actorID uuid.UUID, expectedVersion int64, operationID string) (*TaskMoveResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var listID *uuid.UUID
	var parentTaskID, previousStatusID *uuid.UUID
	var currentVersion int64
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id,status_id,COALESCE(version,1)
		FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, taskID).
		Scan(&listID, &parentTaskID, &previousStatusID, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if listID == nil || parentTaskID != nil {
		return nil, ErrTaskWorkNotFound
	}

	var workflowID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT COALESCE(list.workflow_id,folder.workflow_id,default_workflow.id)
		FROM task_lists list
		LEFT JOIN task_folders folder ON folder.account_id=list.account_id AND folder.id=list.folder_id AND folder.archived_at IS NULL
		LEFT JOIN task_workflows default_workflow ON default_workflow.account_id=list.account_id AND default_workflow.is_default
		WHERE list.account_id=$1 AND list.id=$2 AND list.archived_at IS NULL FOR UPDATE OF list`, accountID, *listID).Scan(&workflowID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	type orderedTask struct {
		id        uuid.UUID
		statusID  *uuid.UUID
		sortOrder int
		version   int64
	}
	rows, err := tx.Query(ctx, `SELECT task.id,task.status_id,task.sort_order,COALESCE(task.version,1)
		FROM tasks task
		WHERE task.account_id=$1 AND task.list_id=$2
		  AND task.parent_task_id IS NOT DISTINCT FROM $3::uuid AND task.deleted_at IS NULL
		ORDER BY task.sort_order,task.id FOR UPDATE OF task`, accountID, *listID, parentTaskID)
	if err != nil {
		return nil, err
	}
	ordered := make([]orderedTask, 0)
	foundMovedTask := false
	for rows.Next() {
		item := orderedTask{}
		if err := rows.Scan(&item.id, &item.statusID, &item.sortOrder, &item.version); err != nil {
			rows.Close()
			return nil, err
		}
		if item.id == taskID {
			foundMovedTask = true
			currentVersion = item.version
			previousStatusID = item.statusID
			continue
		}
		ordered = append(ordered, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if !foundMovedTask {
		return nil, ErrTaskWorkNotFound
	}
	if expectedVersion != currentVersion {
		return nil, ErrTaskVersionConflict
	}
	type lockedTaskStatus struct {
		workflowID uuid.UUID
		category   string
	}
	statusIDs := []uuid.UUID{statusID}
	seenStatusIDs := map[uuid.UUID]struct{}{statusID: {}}
	if previousStatusID != nil {
		if _, seen := seenStatusIDs[*previousStatusID]; !seen {
			seenStatusIDs[*previousStatusID] = struct{}{}
			statusIDs = append(statusIDs, *previousStatusID)
		}
	}
	for _, item := range ordered {
		if item.statusID == nil {
			continue
		}
		if _, seen := seenStatusIDs[*item.statusID]; seen {
			continue
		}
		seenStatusIDs[*item.statusID] = struct{}{}
		statusIDs = append(statusIDs, *item.statusID)
	}
	statusRows, err := tx.Query(ctx, `SELECT id,workflow_id,category FROM task_statuses
		WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, accountID, statusIDs)
	if err != nil {
		return nil, err
	}
	lockedStatuses := make(map[uuid.UUID]lockedTaskStatus, len(statusIDs))
	for statusRows.Next() {
		var id uuid.UUID
		var status lockedTaskStatus
		if err := statusRows.Scan(&id, &status.workflowID, &status.category); err != nil {
			statusRows.Close()
			return nil, err
		}
		lockedStatuses[id] = status
	}
	if err := statusRows.Err(); err != nil {
		statusRows.Close()
		return nil, err
	}
	statusRows.Close()
	targetStatus, targetExists := lockedStatuses[statusID]
	if !targetExists || targetStatus.workflowID != workflowID {
		return nil, ErrTaskWorkNotFound
	}
	targetCategory := targetStatus.category
	previousCategory := ""
	if previousStatusID != nil {
		if previousStatus, exists := lockedStatuses[*previousStatusID]; exists {
			previousCategory = previousStatus.category
		}
	}
	matchesTarget := func(item orderedTask) bool {
		if item.statusID == nil {
			return false
		}
		itemStatus, exists := lockedStatuses[*item.statusID]
		if !exists {
			return false
		}
		return taskMoveStatusMatches(&itemStatus.workflowID, &itemStatus.category, workflowID, targetCategory)
	}

	insertAt := len(ordered)
	if beforeTaskID != nil {
		insertAt = -1
		for index, item := range ordered {
			if item.id == *beforeTaskID && matchesTarget(item) {
				insertAt = index
				break
			}
		}
		if insertAt < 0 {
			return nil, ErrTaskWorkNotFound
		}
	} else {
		// A synthetic board column groups statuses by category, so append after
		// the last task in that category while preserving the task's concrete
		// status. Workflow matching rejects stale/cross-workflow anchors.
		lastTarget := -1
		for index, item := range ordered {
			if matchesTarget(item) {
				lastTarget = index
			}
		}
		if lastTarget >= 0 {
			insertAt = lastTarget + 1
		}
	}
	var nextOrder int
	renormalize := false
	var previousOrder, followingOrder *int
	if insertAt > 0 {
		value := ordered[insertAt-1].sortOrder
		previousOrder = &value
	}
	if insertAt < len(ordered) {
		value := ordered[insertAt].sortOrder
		followingOrder = &value
	}
	switch {
	case previousOrder == nil && followingOrder == nil:
		nextOrder = 1024
	case previousOrder == nil && *followingOrder > 1:
		nextOrder = *followingOrder / 2
	case followingOrder == nil && *previousOrder <= 2_000_000_000-1024:
		nextOrder = *previousOrder + 1024
	case previousOrder != nil && followingOrder != nil && *followingOrder-*previousOrder > 1:
		nextOrder = *previousOrder + (*followingOrder-*previousOrder)/2
	default:
		renormalize = true
	}
	ordered = append(ordered, orderedTask{})
	copy(ordered[insertAt+1:], ordered[insertAt:])
	ordered[insertAt] = orderedTask{id: taskID, statusID: &statusID, sortOrder: nextOrder}
	orderedIDs := make([]uuid.UUID, 0, len(ordered))
	for _, item := range ordered {
		orderedIDs = append(orderedIDs, item.id)
	}
	if renormalize {
		if _, err := tx.Exec(ctx, `UPDATE tasks task SET sort_order=(ordered.position::int * 1024)
			FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(id,position)
			WHERE task.account_id=$1 AND task.id=ordered.id`, accountID, orderedIDs); err != nil {
			return nil, err
		}
		nextOrder = (insertAt + 1) * 1024
	}

	legacyStatus := domain.TaskStatusPending
	if targetCategory == domain.TaskStatusCategoryDone {
		legacyStatus = domain.TaskStatusCompleted
	} else if targetCategory == domain.TaskStatusCategoryCancelled {
		legacyStatus = domain.TaskStatusCancelled
	}
	var nextVersion int64
	command := tx.QueryRow(ctx, `UPDATE tasks SET status_id=$3,status=$4,sort_order=$5,
		progress=CASE WHEN $6::text='done' THEN 100 WHEN $7::boolean AND progress=100 THEN 0 ELSE progress END,
		completed_at=CASE WHEN $6::text='done' THEN COALESCE(completed_at,NOW()) ELSE NULL END,
		completed_by=CASE WHEN $6::text='done' THEN COALESCE(completed_by,$8::uuid) ELSE NULL END,
		overdue_notified_at=NULL,updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE account_id=$1 AND id=$2 AND COALESCE(version,1)=$9
		RETURNING version`, accountID, taskID, statusID, legacyStatus, nextOrder, targetCategory,
		previousCategory == domain.TaskStatusCategoryDone, actorID, expectedVersion)
	if err := command.Scan(&nextVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskVersionConflict
		}
		return nil, err
	}
	metadata, err := json.Marshal(map[string]any{
		"from_status_id": previousStatusID,
		"to_status_id":   statusID,
		"before_task_id": beforeTaskID,
		"operation_id":   operationID,
	})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
		VALUES($1,$2,$3,'moved',$4::jsonb)`, accountID, taskID, actorID, metadata); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &TaskMoveResult{ListID: *listID, StatusID: statusID, TaskIDs: orderedIDs, Version: nextVersion}, nil
}

func (r *TaskWorkRepository) SavedViewScopeExists(ctx context.Context, accountID uuid.UUID, scopeType string, scopeID *uuid.UUID) (bool, error) {
	if scopeType == "all" {
		return scopeID == nil, nil
	}
	if scopeID == nil {
		return false, nil
	}
	table := "task_lists"
	if scopeType == "folder" {
		table = "task_folders"
	} else if scopeType != "list" {
		return false, nil
	}
	var exists bool
	err := r.db.QueryRow(ctx, fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, table), accountID, *scopeID).Scan(&exists)
	return exists, err
}

func (r *TaskWorkRepository) ListSavedViews(ctx context.Context, accountID, userID uuid.UUID) ([]*domain.TaskSavedView, error) {
	rows, err := r.db.Query(ctx, `SELECT id,account_id,user_id,name,scope_type,scope_id,view_mode,filters,
		collapsed_status_ids,is_default,created_at,updated_at
		FROM task_saved_views WHERE account_id=$1 AND user_id=$2
		ORDER BY is_default DESC,updated_at DESC,name`, accountID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	views := make([]*domain.TaskSavedView, 0)
	for rows.Next() {
		view := &domain.TaskSavedView{}
		if err := rows.Scan(&view.ID, &view.AccountID, &view.UserID, &view.Name, &view.ScopeType, &view.ScopeID,
			&view.ViewMode, &view.Filters, &view.CollapsedStatusIDs, &view.IsDefault, &view.CreatedAt, &view.UpdatedAt); err != nil {
			return nil, err
		}
		views = append(views, view)
	}
	return views, rows.Err()
}

func (r *TaskWorkRepository) GetSavedView(ctx context.Context, accountID, userID, viewID uuid.UUID) (*domain.TaskSavedView, error) {
	view := &domain.TaskSavedView{}
	err := r.db.QueryRow(ctx, `SELECT id,account_id,user_id,name,scope_type,scope_id,view_mode,filters,
		collapsed_status_ids,is_default,created_at,updated_at
		FROM task_saved_views WHERE account_id=$1 AND user_id=$2 AND id=$3`, accountID, userID, viewID).
		Scan(&view.ID, &view.AccountID, &view.UserID, &view.Name, &view.ScopeType, &view.ScopeID,
			&view.ViewMode, &view.Filters, &view.CollapsedStatusIDs, &view.IsDefault, &view.CreatedAt, &view.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	return view, err
}

func (r *TaskWorkRepository) CreateSavedView(ctx context.Context, view *domain.TaskSavedView) error {
	view.ID = uuid.New()
	view.CreatedAt = time.Now()
	view.UpdatedAt = view.CreatedAt
	if len(view.Filters) == 0 {
		view.Filters = json.RawMessage(`{}`)
	}
	if view.CollapsedStatusIDs == nil {
		view.CollapsedStatusIDs = []string{}
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if view.IsDefault {
		if _, err := tx.Exec(ctx, `UPDATE task_saved_views SET is_default=FALSE,updated_at=NOW()
			WHERE account_id=$1 AND user_id=$2 AND is_default`, view.AccountID, view.UserID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_saved_views(id,account_id,user_id,name,scope_type,scope_id,
		view_mode,filters,collapsed_status_ids,is_default,created_at,updated_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$11)`, view.ID, view.AccountID, view.UserID,
		view.Name, view.ScopeType, view.ScopeID, view.ViewMode, view.Filters, view.CollapsedStatusIDs,
		view.IsDefault, view.CreatedAt); err != nil {
		return taskSavedViewWriteError(err)
	}
	return taskSavedViewWriteError(tx.Commit(ctx))
}

func (r *TaskWorkRepository) UpdateSavedView(ctx context.Context, view *domain.TaskSavedView) error {
	view.UpdatedAt = time.Now()
	if len(view.Filters) == 0 {
		view.Filters = json.RawMessage(`{}`)
	}
	if view.CollapsedStatusIDs == nil {
		view.CollapsedStatusIDs = []string{}
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return taskSavedViewWriteError(err)
	}
	defer tx.Rollback(ctx)
	if view.IsDefault {
		if _, err := tx.Exec(ctx, `UPDATE task_saved_views SET is_default=FALSE,updated_at=NOW()
			WHERE account_id=$1 AND user_id=$2 AND id<>$3 AND is_default`, view.AccountID, view.UserID, view.ID); err != nil {
			return err
		}
	}
	command, err := tx.Exec(ctx, `UPDATE task_saved_views SET name=$4,scope_type=$5,scope_id=$6,
		view_mode=$7,filters=$8::jsonb,collapsed_status_ids=$9,is_default=$10,updated_at=$11
		WHERE account_id=$1 AND user_id=$2 AND id=$3`, view.AccountID, view.UserID, view.ID, view.Name,
		view.ScopeType, view.ScopeID, view.ViewMode, view.Filters, view.CollapsedStatusIDs, view.IsDefault, view.UpdatedAt)
	if err != nil {
		return taskSavedViewWriteError(err)
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return taskSavedViewWriteError(tx.Commit(ctx))
}

func (r *TaskWorkRepository) DeleteSavedView(ctx context.Context, accountID, userID, viewID uuid.UUID) error {
	command, err := r.db.Exec(ctx, `DELETE FROM task_saved_views WHERE account_id=$1 AND user_id=$2 AND id=$3`, accountID, userID, viewID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
}

func (r *TaskWorkRepository) SetCollaborators(ctx context.Context, accountID, taskID, actorID uuid.UUID, userIDs []uuid.UUID, expectedVersion int64) (int64, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var ownerID uuid.UUID
	var currentVersion int64
	if err := tx.QueryRow(ctx, `SELECT assigned_to,COALESCE(version,1) FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, taskID).Scan(&ownerID, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTaskWorkNotFound
		}
		return 0, err
	}
	if currentVersion != expectedVersion {
		return 0, ErrTaskVersionConflict
	}
	seen := make(map[uuid.UUID]struct{}, len(userIDs))
	cleanIDs := make([]uuid.UUID, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID == ownerID {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		cleanIDs = append(cleanIDs, userID)
	}
	if len(cleanIDs) > 0 {
		var validCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=ANY($2::uuid[])`, accountID, cleanIDs).Scan(&validCount); err != nil {
			return 0, err
		}
		if validCount != len(cleanIDs) {
			return 0, ErrTaskCollaboratorInvalid
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_collaborators WHERE account_id=$1 AND task_id=$2`, accountID, taskID); err != nil {
		return 0, err
	}
	if len(cleanIDs) > 0 {
		if _, err := tx.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by)
			SELECT $1,$2,collaborator_id,$3 FROM unnest($4::uuid[]) AS collaborator_id`, accountID, taskID, actorID, cleanIDs); err != nil {
			return 0, err
		}
	}
	var nextVersion int64
	if err := tx.QueryRow(ctx, `UPDATE tasks SET updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE account_id=$1 AND id=$2 AND COALESCE(version,1)=$3 RETURNING version`, accountID, taskID, expectedVersion).Scan(&nextVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTaskVersionConflict
		}
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return nextVersion, nil
}

func (r *TaskWorkRepository) ListCollaborators(ctx context.Context, accountID, taskID uuid.UUID) ([]*domain.TaskCollaborator, error) {
	byTask, err := r.ListCollaboratorsByTaskIDs(ctx, accountID, []uuid.UUID{taskID})
	if err != nil {
		return nil, err
	}
	items := byTask[taskID]
	if items == nil {
		items = []*domain.TaskCollaborator{}
	}
	return items, nil
}

func (r *TaskWorkRepository) ListCollaboratorsByTaskIDs(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID) (map[uuid.UUID][]*domain.TaskCollaborator, error) {
	result := make(map[uuid.UUID][]*domain.TaskCollaborator, len(taskIDs))
	if len(taskIDs) == 0 {
		return result, nil
	}
	rows, err := r.db.Query(ctx, `SELECT tc.task_id,tc.user_id,COALESCE(u.display_name,u.username,''),u.username,tc.created_at
		FROM task_collaborators tc JOIN users u ON u.id=tc.user_id
		WHERE tc.account_id=$1 AND tc.task_id=ANY($2::uuid[])
		ORDER BY tc.task_id,COALESCE(u.display_name,u.username),tc.user_id`, accountID, taskIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var taskID uuid.UUID
		item := &domain.TaskCollaborator{}
		if err := rows.Scan(&taskID, &item.UserID, &item.DisplayName, &item.Username, &item.CreatedAt); err != nil {
			return nil, err
		}
		result[taskID] = append(result[taskID], item)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) ListChildTasks(ctx context.Context, accountID, parentID uuid.UUID) ([]*domain.Task, error) {
	rows, err := r.db.Query(ctx, `SELECT `+taskSelectFields+` FROM tasks t `+taskJoins+`
		WHERE t.account_id=$1 AND t.parent_task_id=$2 AND t.deleted_at IS NULL ORDER BY t.sort_order,t.created_at`, accountID, parentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.Task{}
	taskRepo := &TaskRepository{db: r.db}
	for rows.Next() {
		task, err := taskRepo.scanTask(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, task)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) ListComments(ctx context.Context, accountID, taskID uuid.UUID, limit, offset int) ([]*domain.TaskComment, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id,c.account_id,c.task_id,c.author_id,COALESCE(u.display_name,u.username,''),c.body,c.edited_at,c.created_at,c.updated_at
		FROM task_comments c JOIN users u ON u.id=c.author_id
		WHERE c.account_id=$1 AND c.task_id=$2 AND c.deleted_at IS NULL
		ORDER BY c.created_at DESC,c.id DESC LIMIT $3 OFFSET $4`, accountID, taskID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskComment{}
	for rows.Next() {
		item := &domain.TaskComment{Mentions: []*domain.TaskCommentMention{}, Attachments: []*domain.TaskAttachment{}}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AuthorID, &item.AuthorName, &item.Body,
			&item.EditedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// The API opens at the newest page, while the activity surface reads in
	// chronological order. Reverse this bounded page after selecting it newest
	// first so comment 101 is visible instead of returning the oldest 100.
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	if err := r.hydrateCommentRelations(ctx, accountID, taskID, result); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *TaskWorkRepository) hydrateCommentRelations(ctx context.Context, accountID, taskID uuid.UUID, comments []*domain.TaskComment) error {
	if len(comments) == 0 {
		return nil
	}
	byID := make(map[uuid.UUID]*domain.TaskComment, len(comments))
	commentIDs := make([]uuid.UUID, 0, len(comments))
	for _, comment := range comments {
		byID[comment.ID] = comment
		commentIDs = append(commentIDs, comment.ID)
	}
	mentionRows, err := r.db.Query(ctx, `SELECT mention.comment_id,u.id,COALESCE(u.display_name,u.username,''),u.username
		FROM task_comment_mentions mention JOIN users u ON u.id=mention.user_id
		WHERE mention.account_id=$1 AND mention.task_id=$2 AND mention.comment_id=ANY($3::uuid[])
		ORDER BY mention.created_at`, accountID, taskID, commentIDs)
	if err != nil {
		return err
	}
	for mentionRows.Next() {
		var commentID uuid.UUID
		mention := &domain.TaskCommentMention{}
		if err := mentionRows.Scan(&commentID, &mention.UserID, &mention.DisplayName, &mention.Username); err != nil {
			mentionRows.Close()
			return err
		}
		if comment := byID[commentID]; comment != nil {
			comment.Mentions = append(comment.Mentions, mention)
		}
	}
	if err := mentionRows.Err(); err != nil {
		mentionRows.Close()
		return err
	}
	mentionRows.Close()

	attachmentRows, err := r.db.Query(ctx, `SELECT relation.comment_id,attachment.id,attachment.account_id,attachment.task_id,attachment.media_asset_id,
		media.filename,media.content_type,media.media_type,media.size_bytes,media.object_key,attachment.uploaded_by,attachment.created_at
		FROM task_comment_attachments relation
		JOIN task_attachments attachment ON attachment.account_id=relation.account_id AND attachment.task_id=relation.task_id AND attachment.id=relation.attachment_id
		JOIN media_assets media ON media.account_id=attachment.account_id AND media.id=attachment.media_asset_id AND media.status='active'
		WHERE relation.account_id=$1 AND relation.task_id=$2 AND relation.comment_id=ANY($3::uuid[])
		ORDER BY relation.created_at`, accountID, taskID, commentIDs)
	if err != nil {
		return err
	}
	defer attachmentRows.Close()
	for attachmentRows.Next() {
		var commentID uuid.UUID
		var key string
		attachment := &domain.TaskAttachment{}
		if err := attachmentRows.Scan(&commentID, &attachment.ID, &attachment.AccountID, &attachment.TaskID, &attachment.MediaAssetID,
			&attachment.Filename, &attachment.ContentType, &attachment.MediaType, &attachment.SizeBytes, &key, &attachment.UploadedBy, &attachment.CreatedAt); err != nil {
			return err
		}
		attachment.URL = "/api/media/file/" + key
		if comment := byID[commentID]; comment != nil {
			comment.Attachments = append(comment.Attachments, attachment)
		}
	}
	return attachmentRows.Err()
}

func (r *TaskWorkRepository) GetComment(ctx context.Context, accountID, taskID, commentID uuid.UUID) (*domain.TaskComment, error) {
	comment := &domain.TaskComment{Mentions: []*domain.TaskCommentMention{}, Attachments: []*domain.TaskAttachment{}}
	err := r.db.QueryRow(ctx, `SELECT c.id,c.account_id,c.task_id,c.author_id,COALESCE(u.display_name,u.username,''),c.body,c.edited_at,c.created_at,c.updated_at
		FROM task_comments c JOIN users u ON u.id=c.author_id
		WHERE c.account_id=$1 AND c.task_id=$2 AND c.id=$3 AND c.deleted_at IS NULL`, accountID, taskID, commentID).
		Scan(&comment.ID, &comment.AccountID, &comment.TaskID, &comment.AuthorID, &comment.AuthorName, &comment.Body,
			&comment.EditedAt, &comment.CreatedAt, &comment.UpdatedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := r.hydrateCommentRelations(ctx, accountID, taskID, []*domain.TaskComment{comment}); err != nil {
		return nil, err
	}
	return comment, nil
}

func (r *TaskWorkRepository) CreateComment(ctx context.Context, comment *domain.TaskComment, mentionIDs, attachmentIDs []uuid.UUID) error {
	comment.ID = uuid.New()
	comment.CreatedAt = time.Now()
	comment.UpdatedAt = comment.CreatedAt
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := tx.QueryRow(ctx, `INSERT INTO task_comments(id,account_id,task_id,author_id,body,created_at,updated_at)
		SELECT $1,$2,$3,$4,$5,$6,$6 WHERE EXISTS(SELECT 1 FROM tasks WHERE account_id=$2 AND id=$3 AND deleted_at IS NULL)
		RETURNING id`, comment.ID, comment.AccountID, comment.TaskID, comment.AuthorID, comment.Body, comment.CreatedAt).Scan(&comment.ID); err != nil {
		return err
	}
	seenMentions := map[uuid.UUID]struct{}{}
	for _, userID := range mentionIDs {
		if userID == comment.AuthorID {
			continue
		}
		if _, exists := seenMentions[userID]; exists {
			continue
		}
		seenMentions[userID] = struct{}{}
		command, err := tx.Exec(ctx, `INSERT INTO task_comment_mentions(account_id,task_id,comment_id,user_id)
			SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$4)`, comment.AccountID, comment.TaskID, comment.ID, userID)
		if err != nil || command.RowsAffected() == 0 {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}
	seenAttachments := map[uuid.UUID]struct{}{}
	for _, attachmentID := range attachmentIDs {
		if _, exists := seenAttachments[attachmentID]; exists {
			continue
		}
		seenAttachments[attachmentID] = struct{}{}
		command, err := tx.Exec(ctx, `INSERT INTO task_comment_attachments(account_id,task_id,comment_id,attachment_id)
			SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND id=$4)`, comment.AccountID, comment.TaskID, comment.ID, attachmentID)
		if err != nil || command.RowsAffected() == 0 {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateComment(ctx context.Context, accountID, taskID, commentID, actorID uuid.UUID, body string, admin bool, mentionIDs, attachmentIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE task_comments SET body=$4,edited_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND task_id=$6 AND id=$2 AND deleted_at IS NULL AND (author_id=$3 OR $5)`, accountID, commentID, actorID, body, admin, taskID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_comment_mentions WHERE account_id=$1 AND task_id=$2 AND comment_id=$3`, accountID, taskID, commentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_comment_attachments WHERE account_id=$1 AND task_id=$2 AND comment_id=$3`, accountID, taskID, commentID); err != nil {
		return err
	}
	seenMentions := map[uuid.UUID]struct{}{}
	for _, userID := range mentionIDs {
		if userID == actorID {
			continue
		}
		if _, exists := seenMentions[userID]; exists {
			continue
		}
		seenMentions[userID] = struct{}{}
		inserted, err := tx.Exec(ctx, `INSERT INTO task_comment_mentions(account_id,task_id,comment_id,user_id)
			SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$4)`, accountID, taskID, commentID, userID)
		if err != nil || inserted.RowsAffected() == 0 {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}
	seenAttachments := map[uuid.UUID]struct{}{}
	for _, attachmentID := range attachmentIDs {
		if _, exists := seenAttachments[attachmentID]; exists {
			continue
		}
		seenAttachments[attachmentID] = struct{}{}
		inserted, err := tx.Exec(ctx, `INSERT INTO task_comment_attachments(account_id,task_id,comment_id,attachment_id)
			SELECT $1,$2,$3,$4 WHERE EXISTS(SELECT 1 FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND id=$4)`, accountID, taskID, commentID, attachmentID)
		if err != nil || inserted.RowsAffected() == 0 {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) DeleteComment(ctx context.Context, accountID, taskID, commentID, actorID uuid.UUID, admin bool) error {
	command, err := r.db.Exec(ctx, `UPDATE task_comments SET deleted_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND task_id=$5 AND id=$2 AND deleted_at IS NULL AND (author_id=$3 OR $4)`, accountID, commentID, actorID, admin, taskID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
}

func (r *TaskWorkRepository) LogActivity(ctx context.Context, accountID, taskID uuid.UUID, actorID *uuid.UUID, action string, metadata any) error {
	payload, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata) VALUES($1,$2,$3,$4,$5)`, accountID, taskID, actorID, action, payload)
	return err
}

func (r *TaskWorkRepository) ListActivity(ctx context.Context, accountID, taskID uuid.UUID, limit int) ([]*domain.TaskActivity, error) {
	rows, err := r.db.Query(ctx, `SELECT a.id,a.account_id,a.task_id,a.actor_id,COALESCE(u.display_name,u.username,''),a.action,a.metadata,a.created_at
		FROM task_activity a LEFT JOIN users u ON u.id=a.actor_id WHERE a.account_id=$1 AND a.task_id=$2
		ORDER BY a.created_at DESC LIMIT $3`, accountID, taskID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskActivity{}
	for rows.Next() {
		item := &domain.TaskActivity{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.ActorID, &item.ActorName, &item.Action, &item.Metadata, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) ListAttachments(ctx context.Context, accountID, taskID uuid.UUID) ([]*domain.TaskAttachment, error) {
	rows, err := r.db.Query(ctx, `SELECT ta.id,ta.account_id,ta.task_id,ta.media_asset_id,ma.filename,ma.content_type,ma.media_type,ma.size_bytes,ma.object_key,ta.uploaded_by,ta.created_at
		FROM task_attachments ta JOIN media_assets ma ON ma.account_id=ta.account_id AND ma.id=ta.media_asset_id AND ma.status='active'
		WHERE ta.account_id=$1 AND ta.task_id=$2 ORDER BY ta.created_at`, accountID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskAttachment{}
	for rows.Next() {
		item := &domain.TaskAttachment{}
		var key string
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.MediaAssetID, &item.Filename, &item.ContentType, &item.MediaType, &item.SizeBytes, &key, &item.UploadedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.URL = "/api/media/file/" + key
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) AddAttachment(ctx context.Context, accountID, taskID, assetID, userID uuid.UUID) (*domain.TaskAttachment, error) {
	item := &domain.TaskAttachment{ID: uuid.New(), AccountID: accountID, TaskID: taskID, MediaAssetID: assetID, UploadedBy: &userID, CreatedAt: time.Now()}
	err := r.db.QueryRow(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,created_at)
		SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM tasks WHERE account_id=$2 AND id=$3 AND deleted_at IS NULL)
		AND EXISTS(SELECT 1 FROM media_assets WHERE account_id=$2 AND id=$4 AND status='active') RETURNING id`, item.ID, accountID, taskID, assetID, userID, item.CreatedAt).Scan(&item.ID)
	if err != nil {
		return nil, err
	}
	items, err := r.ListAttachments(ctx, accountID, taskID)
	if err != nil {
		return nil, err
	}
	for _, candidate := range items {
		if candidate.ID == item.ID {
			return candidate, nil
		}
	}
	return nil, ErrTaskWorkNotFound
}

func (r *TaskWorkRepository) DeleteAttachment(ctx context.Context, accountID, taskID, attachmentID uuid.UUID) error {
	command, err := r.db.Exec(ctx, `DELETE FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND id=$3`, accountID, taskID, attachmentID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
}

func (r *TaskWorkRepository) ListDependencies(ctx context.Context, accountID, taskID uuid.UUID) ([]*domain.TaskDependency, error) {
	rows, err := r.db.Query(ctx, `SELECT d.id,d.account_id,d.predecessor_task_id,d.successor_task_id,d.dependency_type,d.lag_minutes,
		p.title,s.title,d.created_by,d.created_at FROM task_dependencies d
		JOIN tasks p ON p.account_id=d.account_id AND p.id=d.predecessor_task_id
		JOIN tasks s ON s.account_id=d.account_id AND s.id=d.successor_task_id
		WHERE d.account_id=$1 AND (d.predecessor_task_id=$2 OR d.successor_task_id=$2) ORDER BY d.created_at`, accountID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskDependency{}
	for rows.Next() {
		item := &domain.TaskDependency{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.PredecessorTaskID, &item.SuccessorTaskID, &item.DependencyType, &item.LagMinutes, &item.PredecessorTitle, &item.SuccessorTitle, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) AddDependency(ctx context.Context, dependency *domain.TaskDependency) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if dependency.PredecessorTaskID == dependency.SuccessorTaskID {
		return ErrTaskDependencyCycle
	}
	// Cycle validation is a graph-wide invariant. Endpoint locks alone do not
	// serialize concurrent disjoint edges that close one larger cycle, so one
	// account-scoped row lock guards every validation+insert in this graph.
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, dependency.AccountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	// Lock both endpoints in UUID order before inspecting the graph. Inverse
	// concurrent inserts (A→B and B→A) then serialize, so the second transaction
	// observes the first edge and rejects the cycle.
	taskRows, err := tx.Query(ctx, `SELECT id FROM tasks
		WHERE account_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL
		ORDER BY id FOR UPDATE`, dependency.AccountID, []uuid.UUID{dependency.PredecessorTaskID, dependency.SuccessorTaskID})
	if err != nil {
		return err
	}
	validCount := 0
	for taskRows.Next() {
		var taskID uuid.UUID
		if err := taskRows.Scan(&taskID); err != nil {
			taskRows.Close()
			return err
		}
		validCount++
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return err
	}
	taskRows.Close()
	if validCount != 2 {
		return ErrTaskWorkNotFound
	}
	var createsCycle bool
	err = tx.QueryRow(ctx, `WITH RECURSIVE reachable(id) AS (
		SELECT $2::uuid UNION SELECT d.successor_task_id FROM task_dependencies d JOIN reachable r ON d.predecessor_task_id=r.id WHERE d.account_id=$1
	) SELECT EXISTS(SELECT 1 FROM reachable WHERE id=$3)`, dependency.AccountID, dependency.SuccessorTaskID, dependency.PredecessorTaskID).Scan(&createsCycle)
	if err != nil {
		return err
	}
	if createsCycle {
		return ErrTaskDependencyCycle
	}
	dependency.ID = uuid.New()
	dependency.CreatedAt = time.Now()
	if dependency.DependencyType == "" {
		dependency.DependencyType = "finish_to_start"
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_dependencies(id,account_id,predecessor_task_id,successor_task_id,dependency_type,lag_minutes,created_by,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, dependency.ID, dependency.AccountID, dependency.PredecessorTaskID, dependency.SuccessorTaskID, dependency.DependencyType, dependency.LagMinutes, dependency.CreatedBy, dependency.CreatedAt)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) DeleteDependency(ctx context.Context, accountID, taskID, dependencyID uuid.UUID) (*domain.TaskDependency, error) {
	dependency := &domain.TaskDependency{ID: dependencyID, AccountID: accountID}
	err := r.db.QueryRow(ctx, `DELETE FROM task_dependencies
		WHERE account_id=$1 AND id=$2 AND (predecessor_task_id=$3 OR successor_task_id=$3)
		RETURNING predecessor_task_id,successor_task_id`, accountID, dependencyID, taskID).
		Scan(&dependency.PredecessorTaskID, &dependency.SuccessorTaskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, err
	}
	return dependency, nil
}

func (r *TaskWorkRepository) SoftDeleteTask(ctx context.Context, accountID, taskID, userID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var observedListID, observedParentID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, taskID).Scan(&observedListID, &observedParentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if observedListID != nil {
		if err := tx.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, *observedListID).Scan(new(uuid.UUID)); err != nil {
			return err
		}
	} else if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(new(uuid.UUID)); err != nil {
		return err
	}
	var lockedListID, lockedParentID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, taskID).Scan(&lockedListID, &lockedParentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if !taskUUIDPointersEqual(observedListID, lockedListID) || !taskUUIDPointersEqual(observedParentID, lockedParentID) {
		return ErrTaskVersionConflict
	}
	command, err := tx.Exec(ctx, `UPDATE tasks SET deleted_at=NOW(),deleted_by=$3,updated_at=NOW(),version=version+1
		WHERE account_id=$1 AND (id=$2 OR parent_task_id=$2) AND deleted_at IS NULL`, accountID, taskID, userID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_reminders WHERE account_id=$1 AND task_id IN (
		SELECT id FROM tasks WHERE account_id=$1 AND (id=$2 OR parent_task_id=$2)
	)`, accountID, taskID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (r *TaskWorkRepository) RestoreTask(ctx context.Context, accountID, taskID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var listID, parentID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL`, accountID, taskID).Scan(&listID, &parentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if listID == nil {
		return ErrTaskWorkNotFound
	}
	if parentID != nil {
		var parentDeletedAt *time.Time
		if err := tx.QueryRow(ctx, `SELECT deleted_at FROM tasks WHERE account_id=$1 AND id=$2`, accountID, *parentID).Scan(&parentDeletedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskWorkNotFound
			}
			return err
		}
		if parentDeletedAt != nil {
			return ErrTaskParentArchived
		}
	}
	var originalArchivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT archived_at FROM task_lists WHERE account_id=$1 AND id=$2`, accountID, *listID).Scan(&originalArchivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	targetListID := *listID
	if originalArchivedAt != nil {
		if parentID != nil {
			return ErrTaskWorkNotFound
		}
		if err := tx.QueryRow(ctx, `SELECT id FROM task_lists
			WHERE account_id=$1 AND is_default AND archived_at IS NULL`, accountID).Scan(&targetListID); err != nil {
			return err
		}
	}
	lockIDs := []uuid.UUID{*listID}
	if targetListID != *listID {
		lockIDs = append(lockIDs, targetListID)
	}
	listRows, err := tx.Query(ctx, `SELECT id,archived_at FROM task_lists
		WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, lockIDs)
	if err != nil {
		return err
	}
	lockedLists := make(map[uuid.UUID]*time.Time, len(lockIDs))
	for listRows.Next() {
		var id uuid.UUID
		var archivedAt *time.Time
		if err := listRows.Scan(&id, &archivedAt); err != nil {
			listRows.Close()
			return err
		}
		lockedLists[id] = archivedAt
	}
	if err := listRows.Err(); err != nil {
		listRows.Close()
		return err
	}
	listRows.Close()
	if len(lockedLists) != len(lockIDs) || lockedLists[targetListID] != nil {
		return ErrTaskWorkNotFound
	}
	if parentID != nil {
		var parentListID, parentParentID *uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
			WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, *parentID).
			Scan(&parentListID, &parentParentID); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskParentArchived
			}
			return err
		}
		if parentParentID != nil || !taskUUIDPointersEqual(parentListID, listID) {
			return ErrTaskWorkNotFound
		}
	}
	var lockedListID, lockedParentID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT list_id,parent_task_id FROM tasks
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, taskID).Scan(&lockedListID, &lockedParentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if !taskUUIDPointersEqual(listID, lockedListID) || !taskUUIDPointersEqual(parentID, lockedParentID) {
		return ErrTaskVersionConflict
	}
	listChanged := targetListID != *listID
	if listChanged {
		var targetWorkflowID uuid.UUID
		if err := tx.QueryRow(ctx, `SELECT workflow_id FROM task_lists
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, targetListID).Scan(&targetWorkflowID); err != nil {
			return err
		}
		if err := lockTaskWorkflowStatuses(ctx, tx, accountID, targetWorkflowID); err != nil {
			return err
		}
		var missingStatus bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM tasks task
			LEFT JOIN task_statuses current_status ON current_status.account_id=task.account_id AND current_status.id=task.status_id
			JOIN task_lists target_list ON target_list.account_id=task.account_id AND target_list.id=$3
			WHERE task.account_id=$1 AND (task.id=$2 OR task.parent_task_id=$2)
			  AND NOT EXISTS(
				SELECT 1 FROM task_statuses target
				WHERE target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
				  AND target.category=COALESCE(current_status.category,CASE task.status
					WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
			  )
		)`, accountID, taskID, targetListID).Scan(&missingStatus); err != nil {
			return err
		}
		if missingStatus {
			return ErrTaskStatusMappingInvalid
		}
	}
	var nextOrder int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM tasks
		WHERE account_id=$1 AND list_id=$2
		  AND parent_task_id IS NOT DISTINCT FROM $3::uuid AND deleted_at IS NULL`, accountID, targetListID, parentID).Scan(&nextOrder); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE tasks task SET deleted_at=NULL,deleted_by=NULL,list_id=$3,sort_order=$4,
		status_id=CASE WHEN $5::boolean THEN (
			SELECT target.id FROM task_lists target_list
			JOIN task_statuses target ON target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
			LEFT JOIN task_statuses current_status ON current_status.account_id=task.account_id AND current_status.id=task.status_id
			WHERE target_list.account_id=task.account_id AND target_list.id=$3
			  AND target.category=COALESCE(current_status.category,CASE task.status
				WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
			ORDER BY target.is_default DESC,target.sort_order,target.id LIMIT 1
		) ELSE task.status_id END,
		updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NOT NULL`, accountID, taskID, targetListID, nextOrder, listChanged)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if _, err := tx.Exec(ctx, `UPDATE tasks child SET deleted_at=NULL,deleted_by=NULL,list_id=$3,
		status_id=CASE WHEN $4::boolean THEN (
			SELECT target.id FROM task_lists target_list
			JOIN task_statuses target ON target.account_id=target_list.account_id AND target.workflow_id=target_list.workflow_id
			LEFT JOIN task_statuses current_status ON current_status.account_id=child.account_id AND current_status.id=child.status_id
			WHERE target_list.account_id=child.account_id AND target_list.id=$3
			  AND target.category=COALESCE(current_status.category,CASE child.status
				WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)
			ORDER BY target.is_default DESC,target.sort_order,target.id LIMIT 1
		) ELSE child.status_id END,
		updated_at=NOW(),version=COALESCE(version,1)+1
		WHERE child.account_id=$1 AND child.parent_task_id=$2 AND child.deleted_at IS NOT NULL`, accountID, taskID, targetListID, listChanged); err != nil {
		return err
	}
	// Restored children keep their prior relative order, but receive healthy
	// gaps so archived legacy positions cannot reintroduce collisions.
	if _, err := tx.Exec(ctx, `WITH ranked AS (
		SELECT id,(ROW_NUMBER() OVER(ORDER BY sort_order,created_at,id)*1024)::int AS position
		FROM tasks WHERE account_id=$1 AND parent_task_id=$2 AND deleted_at IS NULL
	) UPDATE tasks task SET sort_order=ranked.position FROM ranked WHERE task.id=ranked.id`, accountID, taskID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) Summary(ctx context.Context, accountID uuid.UUID, folderID, listID *uuid.UUID) (map[string]any, error) {
	conditions := []string{"t.account_id=$1", "t.deleted_at IS NULL", "t.parent_task_id IS NULL"}
	args := []any{accountID}
	idx := 2
	if folderID != nil {
		conditions = append(conditions, fmt.Sprintf("l.folder_id=$%d", idx))
		args = append(args, *folderID)
		idx++
	}
	if listID != nil {
		conditions = append(conditions, fmt.Sprintf("t.list_id=$%d", idx))
		args = append(args, *listID)
	}
	where := strings.Join(conditions, " AND ")
	query := fmt.Sprintf(`SELECT COUNT(*),COUNT(*) FILTER(WHERE s.category='done'),COUNT(*) FILTER(WHERE s.category='active'),
		COUNT(*) FILTER(WHERE t.due_at<NOW() AND s.category NOT IN('done','cancelled')),
		COUNT(DISTINCT t.assigned_to),COALESCE(AVG(CASE WHEN s.category='cancelled' THEN NULL ELSE t.progress END),0)
		FROM tasks t LEFT JOIN task_lists l ON l.account_id=t.account_id AND l.id=t.list_id LEFT JOIN task_statuses s ON s.account_id=t.account_id AND s.id=t.status_id WHERE %s`, where)
	var total, done, active, overdue, owners int
	var progress float64
	if err := r.db.QueryRow(ctx, query, args...).Scan(&total, &done, &active, &overdue, &owners, &progress); err != nil {
		return nil, err
	}
	return map[string]any{"total": total, "done": done, "active": active, "overdue": overdue, "owners": owners, "progress": progress}, nil
}

func (r *TaskWorkRepository) GanttDependencies(ctx context.Context, accountID uuid.UUID, taskIDs []uuid.UUID) ([]*domain.TaskDependency, error) {
	if len(taskIDs) == 0 {
		return []*domain.TaskDependency{}, nil
	}
	rows, err := r.db.Query(ctx, `SELECT d.id,d.account_id,d.predecessor_task_id,d.successor_task_id,d.dependency_type,d.lag_minutes,p.title,s.title,d.created_by,d.created_at
		FROM task_dependencies d JOIN tasks p ON p.account_id=d.account_id AND p.id=d.predecessor_task_id JOIN tasks s ON s.account_id=d.account_id AND s.id=d.successor_task_id
		WHERE d.account_id=$1 AND d.predecessor_task_id=ANY($2::uuid[]) AND d.successor_task_id=ANY($2::uuid[])`, accountID, taskIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskDependency{}
	for rows.Next() {
		item := &domain.TaskDependency{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.PredecessorTaskID, &item.SuccessorTaskID, &item.DependencyType, &item.LagMinutes, &item.PredecessorTitle, &item.SuccessorTitle, &item.CreatedBy, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
