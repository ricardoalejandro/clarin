package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func normalizeTaskEnvironmentPage(limit int) int {
	if limit < 1 || limit > 200 {
		return 50
	}
	return limit
}

func (r *TaskWorkRepository) ListEnvironmentFolders(ctx context.Context, accountID, userID, environmentID uuid.UUID, limit int, cursor *TaskStructurePageCursor, search string) ([]*domain.TaskFolder, *TaskStructurePageCursor, error) {
	_, err := r.RequireActiveEnvironmentAccess(ctx, accountID, userID, environmentID, domain.TaskAccessView)
	if err != nil {
		return nil, nil, err
	}
	limit = normalizeTaskEnvironmentPage(limit)
	search = strings.TrimSpace(search)
	cursorSortOrder, cursorID := taskStructureCursorValues(cursor)
	rows, err := r.db.Query(ctx, `SELECT folder.id,folder.account_id,folder.environment_id,folder.workflow_id,
		COALESCE(folder.workflow_inherited,TRUE),folder.name,folder.description,folder.color,folder.icon,folder.sort_order,
		folder.created_by,folder.archived_at,folder.access_mode,folder.access_revision,folder.created_at,folder.updated_at,
		(`+taskActorFolderAccessRankSQL("folder", "$3")+`) AS access_rank,
		(`+taskActorFolderCanManageSQL("folder", "$3")+`) AS can_manage_access,
		COALESCE(counts.task_count,0),COALESCE(counts.open_count,0),COALESCE(counts.done_count,0),COALESCE(counts.cancelled_count,0)
		FROM task_folders folder
		LEFT JOIN LATERAL (SELECT COUNT(*)::int AS task_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END) NOT IN ('done','cancelled'))::int AS open_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='done')::int AS done_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='cancelled')::int AS cancelled_count
			FROM task_lists list_item
			JOIN tasks task ON task.account_id=list_item.account_id AND task.list_id=list_item.id
			LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
			WHERE list_item.account_id=folder.account_id AND list_item.folder_id=folder.id AND list_item.archived_at IS NULL
			  AND task.parent_task_id IS NULL AND task.deleted_at IS NULL
			  AND `+taskActorCanViewSQL("task", "list_item", "$3")+`
		) counts ON TRUE
		WHERE folder.account_id=$1 AND folder.environment_id=$2 AND folder.archived_at IS NULL
		  AND (`+taskActorFolderAccessRankSQL("folder", "$3")+`) >= 1
		  AND ($4::text='' OR folder.name ILIKE '%' || $4 || '%' OR folder.description ILIKE '%' || $4 || '%')
		  AND ($5::int IS NULL OR (folder.sort_order,folder.id) > ($5,$6))
		ORDER BY folder.sort_order,folder.id LIMIT $7`, accountID, environmentID, userID, search, cursorSortOrder, cursorID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskFolder, 0, limit+1)
	for rows.Next() {
		item := &domain.TaskFolder{Lists: []*domain.TaskList{}}
		var accessRank int
		var canManageAccess bool
		if err := rows.Scan(&item.ID, &item.AccountID, &item.EnvironmentID, &item.WorkflowID, &item.WorkflowInherited,
			&item.Name, &item.Description, &item.Color, &item.Icon, &item.SortOrder, &item.CreatedBy, &item.ArchivedAt,
			&item.AccessMode, &item.AccessRevision, &item.CreatedAt, &item.UpdatedAt, &accessRank, &canManageAccess,
			&item.TaskCount, &item.OpenTaskCount, &item.CompletedTaskCount,
			&item.CancelledTaskCount); err != nil {
			return nil, nil, err
		}
		item.SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(accessRank), canManageAccess, "folder_policy"))
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *TaskStructurePageCursor
	if len(items) > limit {
		boundary := items[limit-1]
		next = &TaskStructurePageCursor{SortOrder: boundary.SortOrder, ID: boundary.ID}
		items = items[:limit]
	}
	return items, next, nil
}

func (r *TaskWorkRepository) ListEnvironmentLists(ctx context.Context, accountID, userID, environmentID uuid.UUID, folderID *uuid.UUID, all bool, limit int, cursor *TaskStructurePageCursor, search string) ([]*domain.TaskList, *TaskStructurePageCursor, error) {
	_, err := r.RequireActiveEnvironmentAccess(ctx, accountID, userID, environmentID, domain.TaskAccessView)
	if err != nil {
		return nil, nil, err
	}
	limit = normalizeTaskEnvironmentPage(limit)
	search = strings.TrimSpace(search)
	cursorSortOrder, cursorID := taskStructureCursorValues(cursor)
	rows, err := r.db.Query(ctx, `SELECT list_item.id,list_item.account_id,list_item.environment_id,list_item.folder_id,list_item.workflow_id,
		COALESCE(list_item.workflow_inherited,TRUE),COALESCE(list_item.is_default,FALSE),list_item.name,
		COALESCE(list_item.description,''),list_item.color,COALESCE(list_item.icon,CASE WHEN list_item.is_default THEN 'inbox' ELSE 'list' END),
		list_item.sort_order,list_item.created_by,list_item.archived_at,list_item.access_mode,list_item.access_revision,list_item.created_at,list_item.updated_at,
		(`+taskActorListAccessRankSQL("list_item", "$3")+`) AS access_rank,
		(`+taskActorListCanManageSQL("list_item", "$3")+`) AS can_manage_access,
		COALESCE(counts.task_count,0),COALESCE(counts.open_count,0),COALESCE(counts.done_count,0),COALESCE(counts.cancelled_count,0)
		FROM task_lists list_item
		LEFT JOIN LATERAL (SELECT COUNT(*)::int AS task_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END) NOT IN ('done','cancelled'))::int AS open_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='done')::int AS done_count,
			COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='cancelled')::int AS cancelled_count
			FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
			WHERE task.account_id=list_item.account_id AND task.list_id=list_item.id AND task.parent_task_id IS NULL
			  AND task.deleted_at IS NULL AND `+taskActorCanViewSQL("task", "list_item", "$3")+`
		) counts ON TRUE
		WHERE list_item.account_id=$1 AND list_item.environment_id=$2 AND list_item.archived_at IS NULL
		  AND (`+taskActorListAccessRankSQL("list_item", "$3")+`) >= 1
		  AND ($4::boolean OR (($5::uuid IS NULL AND list_item.folder_id IS NULL) OR list_item.folder_id=$5))
		  AND ($6::text='' OR list_item.name ILIKE '%' || $6 || '%' OR list_item.description ILIKE '%' || $6 || '%')
		  AND ($7::int IS NULL OR (list_item.sort_order,list_item.id) > ($7,$8))
		ORDER BY list_item.sort_order,list_item.id LIMIT $9`, accountID, environmentID, userID, all, folderID, search, cursorSortOrder, cursorID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskList, 0, limit+1)
	for rows.Next() {
		item := &domain.TaskList{}
		var accessRank int
		var canManageAccess bool
		if err := rows.Scan(&item.ID, &item.AccountID, &item.EnvironmentID, &item.FolderID, &item.WorkflowID,
			&item.WorkflowInherited, &item.IsDefault, &item.Name, &item.Description, &item.Color, &item.Icon, &item.SortOrder,
			&item.CreatedBy, &item.ArchivedAt, &item.AccessMode, &item.AccessRevision, &item.CreatedAt, &item.UpdatedAt,
			&accessRank, &canManageAccess, &item.TaskCount, &item.OpenTaskCount,
			&item.CompletedTaskCount, &item.CancelledTaskCount); err != nil {
			return nil, nil, err
		}
		item.SetEffectiveAccess(buildTaskEffectiveAccess(taskAccessLevelFromRank(accessRank), canManageAccess, "list_policy"))
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *TaskStructurePageCursor
	if len(items) > limit {
		boundary := items[limit-1]
		next = &TaskStructurePageCursor{SortOrder: boundary.SortOrder, ID: boundary.ID}
		items = items[:limit]
	}
	return items, next, nil
}
