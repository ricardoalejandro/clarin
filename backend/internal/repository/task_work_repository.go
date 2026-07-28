package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskWorkNotFound    = errors.New("task work item not found")
	ErrTaskDependencyCycle = errors.New("task dependency would create a cycle")
	ErrTaskStatusInUse     = errors.New("task status is in use")
	ErrTaskWorkflowInvalid = errors.New("task workflow requires initial and completed statuses")
	ErrTaskVersionConflict = errors.New("task was updated concurrently")
)

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

func (r *TaskWorkRepository) UpdateFolder(ctx context.Context, accountID, folderID uuid.UUID, name, description, color *string, workflowID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if workflowID != nil {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, accountID, workflowID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrTaskWorkNotFound
		}
	}
	command, err := tx.Exec(ctx, `
		UPDATE task_folders SET
			name=COALESCE($3::text,name), description=COALESCE($4::text,description),
			color=COALESCE($5::text,color), workflow_id=COALESCE($6::uuid,workflow_id), updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
	`, accountID, folderID, name, description, color, workflowID)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if workflowID != nil {
		if _, err := tx.Exec(ctx, `UPDATE task_lists SET workflow_id=$3,updated_at=NOW()
			WHERE account_id=$1 AND folder_id=$2 AND workflow_inherited=TRUE`, accountID, folderID, workflowID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ArchiveFolder(ctx context.Context, accountID, folderID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, folderID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NULL`, accountID, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateListLocation(ctx context.Context, accountID, listID uuid.UUID, folderID *uuid.UUID, folderProvided bool, workflowID *uuid.UUID, inherited *bool, description *string) error {
	if folderID != nil {
		var valid bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_folders WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, accountID, folderID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrTaskWorkNotFound
		}
	}
	if workflowID != nil {
		var valid bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, accountID, workflowID).Scan(&valid); err != nil {
			return err
		}
		if !valid {
			return ErrTaskWorkNotFound
		}
	}
	var resolvedWorkflowID *uuid.UUID = workflowID
	if inherited != nil && *inherited && folderID != nil {
		var id uuid.UUID
		if err := r.db.QueryRow(ctx, `SELECT workflow_id FROM task_folders WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`, accountID, folderID).Scan(&id); err != nil {
			return err
		}
		resolvedWorkflowID = &id
	}
	command, err := r.db.Exec(ctx, `
		UPDATE task_lists SET folder_id=CASE WHEN $7::boolean THEN $3::uuid ELSE folder_id END,
			workflow_id=COALESCE($4::uuid,workflow_id),
			workflow_inherited=COALESCE($5::boolean,workflow_inherited),
			description=COALESCE($6::text,description),updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
	`, accountID, listID, folderID, resolvedWorkflowID, inherited, description, folderProvided)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
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

func (r *TaskWorkRepository) CreateStatus(ctx context.Context, status *domain.TaskStatus) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var valid bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_workflows WHERE account_id=$1 AND id=$2)`, status.AccountID, status.WorkflowID).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return ErrTaskWorkNotFound
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
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateStatus(ctx context.Context, accountID, statusID uuid.UUID, name, color, category *string, sortOrder *int) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var workflowID uuid.UUID
	var oldCategory string
	if err := tx.QueryRow(ctx, `SELECT workflow_id,category FROM task_statuses WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, statusID).Scan(&workflowID, &oldCategory); err != nil {
		return ErrTaskWorkNotFound
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

func (r *TaskWorkRepository) DeleteStatus(ctx context.Context, accountID, statusID uuid.UUID, replacementID *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var workflowID uuid.UUID
	var category string
	if err := tx.QueryRow(ctx, `SELECT workflow_id,category FROM task_statuses WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, statusID).Scan(&workflowID, &category); err != nil {
		return ErrTaskWorkNotFound
	}
	if category == domain.TaskStatusCategoryNotStarted || category == domain.TaskStatusCategoryDone {
		var alternatives int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category=$3 AND id<>$4`, accountID, workflowID, category, statusID).Scan(&alternatives); err != nil {
			return err
		}
		if alternatives == 0 {
			return ErrTaskWorkflowInvalid
		}
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND status_id=$2`, accountID, statusID).Scan(&count); err != nil {
		return err
	}
	if count > 0 && replacementID == nil {
		return ErrTaskStatusInUse
	}
	if replacementID != nil {
		if *replacementID == statusID {
			return ErrTaskWorkNotFound
		}
		var compatible bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM task_statuses old_status JOIN task_statuses replacement ON replacement.workflow_id=old_status.workflow_id
			WHERE old_status.account_id=$1 AND old_status.id=$2 AND replacement.id=$3 AND replacement.account_id=$1
		)`, accountID, statusID, replacementID).Scan(&compatible); err != nil || !compatible {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
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

func (r *TaskWorkRepository) SetCollaborators(ctx context.Context, accountID, taskID, actorID uuid.UUID, userIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var taskExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL)`, accountID, taskID).Scan(&taskExists); err != nil || !taskExists {
		if err != nil {
			return err
		}
		return ErrTaskWorkNotFound
	}
	for _, userID := range userIDs {
		var valid bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$1 AND user_id=$2)`, accountID, userID).Scan(&valid); err != nil || !valid {
			if err != nil {
				return err
			}
			return fmt.Errorf("invalid collaborator")
		}
	}
	var ownerID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT assigned_to FROM tasks WHERE account_id=$1 AND id=$2`, accountID, taskID).Scan(&ownerID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_collaborators WHERE account_id=$1 AND task_id=$2`, accountID, taskID); err != nil {
		return err
	}
	seen := make(map[uuid.UUID]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID == ownerID {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		if _, err := tx.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by) VALUES($1,$2,$3,$4)`, accountID, taskID, userID, actorID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ListCollaborators(ctx context.Context, accountID, taskID uuid.UUID) ([]*domain.TaskCollaborator, error) {
	rows, err := r.db.Query(ctx, `SELECT tc.user_id,COALESCE(u.display_name,u.username,''),u.username,tc.created_at
		FROM task_collaborators tc JOIN users u ON u.id=tc.user_id
		WHERE tc.account_id=$1 AND tc.task_id=$2 ORDER BY COALESCE(u.display_name,u.username)`, accountID, taskID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskCollaborator{}
	for rows.Next() {
		item := &domain.TaskCollaborator{}
		if err := rows.Scan(&item.UserID, &item.DisplayName, &item.Username, &item.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
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
		ORDER BY c.created_at LIMIT $3 OFFSET $4`, accountID, taskID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []*domain.TaskComment{}
	for rows.Next() {
		item := &domain.TaskComment{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AuthorID, &item.AuthorName, &item.Body,
			&item.EditedAt, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) CreateComment(ctx context.Context, comment *domain.TaskComment) error {
	comment.ID = uuid.New()
	comment.CreatedAt = time.Now()
	comment.UpdatedAt = comment.CreatedAt
	return r.db.QueryRow(ctx, `INSERT INTO task_comments(id,account_id,task_id,author_id,body,created_at,updated_at)
		SELECT $1,$2,$3,$4,$5,$6,$6 WHERE EXISTS(SELECT 1 FROM tasks WHERE account_id=$2 AND id=$3 AND deleted_at IS NULL)
		RETURNING id`, comment.ID, comment.AccountID, comment.TaskID, comment.AuthorID, comment.Body, comment.CreatedAt).Scan(&comment.ID)
}

func (r *TaskWorkRepository) UpdateComment(ctx context.Context, accountID, taskID, commentID, actorID uuid.UUID, body string, admin bool) error {
	command, err := r.db.Exec(ctx, `UPDATE task_comments SET body=$4,edited_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND task_id=$6 AND id=$2 AND deleted_at IS NULL AND (author_id=$3 OR $5)`, accountID, commentID, actorID, body, admin, taskID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
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
	var validCount int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL`, dependency.AccountID, []uuid.UUID{dependency.PredecessorTaskID, dependency.SuccessorTaskID}).Scan(&validCount); err != nil {
		return err
	}
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

func (r *TaskWorkRepository) DeleteDependency(ctx context.Context, accountID, taskID, dependencyID uuid.UUID) error {
	command, err := r.db.Exec(ctx, `DELETE FROM task_dependencies WHERE account_id=$1 AND id=$2 AND (predecessor_task_id=$3 OR successor_task_id=$3)`, accountID, dependencyID, taskID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
}

func (r *TaskWorkRepository) SoftDeleteTask(ctx context.Context, accountID, taskID, userID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
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
	command, err := r.db.Exec(ctx, `UPDATE tasks SET deleted_at=NULL,deleted_by=NULL,updated_at=NOW(),version=version+1
		WHERE account_id=$1 AND (id=$2 OR parent_task_id=$2) AND deleted_at IS NOT NULL`, accountID, taskID)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
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
