package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func taskOpenCategorySQL(taskAlias, statusAlias string) string {
	return `COALESCE(` + statusAlias + `.category,CASE ` + taskAlias + `.status
		WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END) NOT IN ('done','cancelled')`
}

func requireEnvironmentAccessIncludingArchiveTx(ctx context.Context, tx pgx.Tx, accountID, actorID, environmentID uuid.UUID, required string, allowTrash bool) error {
	var deleted bool
	if err := tx.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM task_environments
		WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, environmentID).Scan(&deleted); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if deleted && !allowTrash {
		return ErrTaskWorkNotFound
	}
	access, _, err := resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, environmentID)
	if err != nil {
		return err
	}
	if !TaskAccessAllows(access, required) {
		if access == nil || !access.CanView {
			return ErrTaskWorkNotFound
		}
		return ErrTaskAccessDenied
	}
	return nil
}

// ListArchiveHierarchyForActor returns only historical structure for an active
// Entorno, or the complete non-Trash structure when the Entorno itself is
// archived. Active folders may be returned as breadcrumb containers when they
// own individually archived lists.
func (r *TaskWorkRepository) ListArchiveHierarchyForActor(ctx context.Context, accountID, actorID, environmentID uuid.UUID) ([]*domain.TaskFolder, []*domain.TaskList, error) {
	var environmentArchived bool
	err := r.db.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM task_environments environment
		WHERE environment.account_id=$1 AND environment.id=$2 AND environment.deleted_at IS NULL
		  AND (`+environmentActorAccessRankSQL("environment", "$3")+`)>=1`, accountID, environmentID, actorID).Scan(&environmentArchived)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, nil, err
	}

	folderRows, err := r.db.Query(ctx, `SELECT folder.id,folder.account_id,folder.environment_id,folder.workflow_id,
		COALESCE(folder.workflow_inherited,TRUE),folder.name,folder.description,folder.color,folder.icon,folder.sort_order,
		folder.created_by,folder.archived_at,folder.deleted_at,folder.deleted_by,folder.access_mode,folder.access_revision,
		folder.created_at,folder.updated_at,
		(`+taskActorFolderAccessRankSQL("folder", "$3")+`) AS access_rank,
		(`+taskActorFolderCanManageSQL("folder", "$3")+`) AS can_manage_access
		FROM task_folders folder
		WHERE folder.account_id=$1 AND folder.environment_id=$2 AND folder.deleted_at IS NULL
		  AND ($4::boolean OR folder.archived_at IS NOT NULL OR EXISTS(
			SELECT 1 FROM task_lists archived_list WHERE archived_list.account_id=folder.account_id
			  AND archived_list.folder_id=folder.id AND archived_list.archived_at IS NOT NULL AND archived_list.deleted_at IS NULL))
		  AND (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1
		ORDER BY folder.sort_order,folder.id`, accountID, environmentID, actorID, environmentArchived)
	if err != nil {
		return nil, nil, err
	}
	folders := make([]*domain.TaskFolder, 0)
	byID := make(map[uuid.UUID]*domain.TaskFolder)
	for folderRows.Next() {
		item := &domain.TaskFolder{Lists: []*domain.TaskList{}}
		var rank int
		var manage bool
		if err := folderRows.Scan(&item.ID, &item.AccountID, &item.EnvironmentID, &item.WorkflowID, &item.WorkflowInherited,
			&item.Name, &item.Description, &item.Color, &item.Icon, &item.SortOrder, &item.CreatedBy,
			&item.ArchivedAt, &item.DeletedAt, &item.DeletedBy, &item.AccessMode, &item.AccessRevision,
			&item.CreatedAt, &item.UpdatedAt, &rank, &manage); err != nil {
			folderRows.Close()
			return nil, nil, err
		}
		item.SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(rank), manage, "folder_policy"))
		item.SetLifecycle()
		folders = append(folders, item)
		byID[item.ID] = item
	}
	if err := folderRows.Err(); err != nil {
		folderRows.Close()
		return nil, nil, err
	}
	folderRows.Close()

	listRows, err := r.db.Query(ctx, `SELECT list_item.id,list_item.account_id,list_item.environment_id,list_item.folder_id,list_item.workflow_id,
		COALESCE(list_item.workflow_inherited,TRUE),COALESCE(list_item.is_default,FALSE),list_item.name,
		COALESCE(list_item.description,''),list_item.color,COALESCE(list_item.icon,CASE WHEN list_item.is_default THEN 'inbox' ELSE 'list' END),
		list_item.sort_order,list_item.created_by,list_item.archived_at,COALESCE(list_item.archived_with_folder,FALSE),
		list_item.deleted_at,list_item.deleted_by,COALESCE(list_item.deleted_with_folder,FALSE),list_item.access_mode,list_item.access_revision,
		list_item.created_at,list_item.updated_at,
		(`+taskActorListAccessRankSQL("list_item", "$3")+`) AS access_rank,
		(`+taskActorListCanManageSQL("list_item", "$3")+`) AS can_manage_access,
		COALESCE(counts.task_count,0),COALESCE(counts.open_count,0),COALESCE(counts.done_count,0),COALESCE(counts.cancelled_count,0)
		FROM task_lists list_item
		LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
		LEFT JOIN LATERAL (SELECT COUNT(*)::int AS task_count,
			COUNT(*) FILTER (WHERE `+taskOpenCategorySQL("task", "status")+`)::int AS open_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' ELSE '' END)='done')::int AS done_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'cancelled' THEN 'cancelled' ELSE '' END)='cancelled')::int AS cancelled_count
			FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
			WHERE task.account_id=list_item.account_id AND task.list_id=list_item.id AND task.parent_task_id IS NULL
			  AND task.deleted_at IS NULL AND `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$3")+`
		) counts ON TRUE
		WHERE list_item.account_id=$1 AND list_item.environment_id=$2 AND list_item.deleted_at IS NULL
		  AND ($4::boolean OR list_item.archived_at IS NOT NULL OR folder.archived_at IS NOT NULL)
		  AND (folder.id IS NULL OR folder.deleted_at IS NULL)
		  AND (`+taskActorListAccessRankSQL("list_item", "$3")+`)>=1
		ORDER BY list_item.sort_order,list_item.id`, accountID, environmentID, actorID, environmentArchived)
	if err != nil {
		return nil, nil, err
	}
	defer listRows.Close()
	roots := make([]*domain.TaskList, 0)
	for listRows.Next() {
		item := &domain.TaskList{}
		var rank int
		var manage bool
		if err := listRows.Scan(&item.ID, &item.AccountID, &item.EnvironmentID, &item.FolderID, &item.WorkflowID,
			&item.WorkflowInherited, &item.IsDefault, &item.Name, &item.Description, &item.Color, &item.Icon,
			&item.SortOrder, &item.CreatedBy, &item.ArchivedAt, &item.ArchivedWithFolder,
			&item.DeletedAt, &item.DeletedBy, &item.DeletedWithFolder, &item.AccessMode, &item.AccessRevision,
			&item.CreatedAt, &item.UpdatedAt, &rank, &manage, &item.TaskCount, &item.OpenTaskCount,
			&item.CompletedTaskCount, &item.CancelledTaskCount); err != nil {
			return nil, nil, err
		}
		item.SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(rank), manage, "list_policy"))
		item.SetLifecycle()
		if item.FolderID != nil && byID[*item.FolderID] != nil {
			folder := byID[*item.FolderID]
			folder.Lists = append(folder.Lists, item)
			addTaskListCountsToFolder(folder, item)
		} else {
			roots = append(roots, item)
		}
	}
	return folders, roots, listRows.Err()
}

func (r *TaskWorkRepository) ArchiveList(ctx context.Context, accountID, actorID, listID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var environmentID uuid.UUID
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT environment_id,is_default FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, accountID, listID).Scan(&environmentID, &isDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if isDefault {
		return ErrDefaultTaskList
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return err
	}
	var open int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL AND `+taskOpenCategorySQL("task", "status"), accountID, listID).Scan(&open); err != nil {
		return err
	}
	if open > 0 {
		return ErrTaskContainerNotEmpty
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),archived_with_folder=FALSE,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, listID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UnarchiveList(ctx context.Context, accountID, actorID, listID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var environmentID uuid.UUID
	var folderID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id,folder_id FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, accountID, listID).Scan(&environmentID, &folderID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return err
	}
	if folderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT archived_at IS NULL AND deleted_at IS NULL FROM task_folders
			WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, *folderID).Scan(&active); err != nil || !active {
			return ErrTaskParentArchived
		}
	}
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_lists
		WHERE account_id=$1 AND environment_id=$2 AND folder_id IS NOT DISTINCT FROM $3::uuid
		  AND archived_at IS NULL AND deleted_at IS NULL`, accountID, environmentID, folderID).Scan(&next); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NULL,archived_with_folder=FALSE,sort_order=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, listID, next); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) ArchiveFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id FROM task_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var open int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND list_item.folder_id=$2 AND task.deleted_at IS NULL AND list_item.deleted_at IS NULL
		  AND `+taskOpenCategorySQL("task", "status"), accountID, folderID).Scan(&open); err != nil {
		return err
	}
	if open > 0 {
		return ErrTaskContainerNotEmpty
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, folderID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),archived_with_folder=TRUE,updated_at=NOW()
		WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UnarchiveFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id FROM task_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_folders
		WHERE account_id=$1 AND environment_id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, environmentID).Scan(&next); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NULL,sort_order=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, folderID, next); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH ordered AS (
		SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,created_at,id) AS position FROM task_lists
		WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NOT NULL AND archived_with_folder AND deleted_at IS NULL
	) UPDATE task_lists list_item SET archived_at=NULL,archived_with_folder=FALSE,
		sort_order=ordered.position*1024,updated_at=NOW()
	FROM ordered WHERE list_item.account_id=$1 AND list_item.id=ordered.id`, accountID, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
