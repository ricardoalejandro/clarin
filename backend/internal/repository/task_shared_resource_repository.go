package repository

import (
	"context"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type TaskSharedResourceCursor struct {
	Type string
	Name string
	ID   uuid.UUID
}

func (r *TaskWorkRepository) ListDirectSharedResources(ctx context.Context, accountID, userID, environmentID uuid.UUID, limit int, cursor *TaskSharedResourceCursor) ([]*domain.TaskSharedResource, *TaskSharedResourceCursor, error) {
	if _, err := r.RequireActiveEnvironmentAccess(ctx, accountID, userID, environmentID, domain.TaskAccessView); err != nil {
		return nil, nil, err
	}
	if limit < 1 || limit > 200 {
		limit = 50
	}
	var cursorType, cursorName *string
	var cursorID *uuid.UUID
	if cursor != nil {
		cursorType, cursorName, cursorID = &cursor.Type, &cursor.Name, &cursor.ID
	}
	rows, err := r.db.Query(ctx, `WITH shared AS (
		SELECT 'folder'::text AS resource_type,folder.id,folder.environment_id,folder.name,folder.color,folder.icon,
			folder.access_mode,(`+taskActorFolderAccessRankSQL("folder", "$2")+`) AS access_rank
		FROM task_folders folder
		JOIN task_folder_access_grants direct_grant ON direct_grant.account_id=folder.account_id AND direct_grant.folder_id=folder.id AND direct_grant.user_id=$2 AND direct_grant.access_level<>'none'
		WHERE folder.account_id=$1 AND folder.environment_id=$3 AND folder.archived_at IS NULL
		  AND (`+taskActorFolderAccessRankSQL("folder", "$2")+`) >= 1
		UNION ALL
		SELECT 'list'::text,list_item.id,list_item.environment_id,list_item.name,list_item.color,list_item.icon,
			list_item.access_mode,(`+taskActorListAccessRankSQL("list_item", "$2")+`) AS access_rank
		FROM task_lists list_item
		JOIN task_list_access_grants direct_grant ON direct_grant.account_id=list_item.account_id AND direct_grant.list_id=list_item.id AND direct_grant.user_id=$2 AND direct_grant.access_level<>'none'
		WHERE list_item.account_id=$1 AND list_item.environment_id=$3 AND list_item.archived_at IS NULL
		  AND (`+taskActorListAccessRankSQL("list_item", "$2")+`) >= 1
		UNION ALL
		SELECT 'task'::text,task.id,list_item.environment_id,task.title,''::varchar,'check-square'::text,
			COALESCE(task.access_mode,'inherit'),(`+taskActorAccessRankSQL("task", "list_item", "$2")+`) AS access_rank
		FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		JOIN task_access_grants direct_grant ON direct_grant.account_id=task.account_id AND direct_grant.task_id=task.id AND direct_grant.user_id=$2 AND direct_grant.access_level<>'none'
		WHERE task.account_id=$1 AND list_item.environment_id=$3 AND task.parent_task_id IS NULL AND task.deleted_at IS NULL
		  AND (`+taskActorAccessRankSQL("task", "list_item", "$2")+`) >= 1
	)
	SELECT resource_type,id,environment_id,name,color,icon,access_mode,access_rank
	FROM shared
	WHERE ($4::text IS NULL OR (resource_type,LOWER(name),id) > ($4,LOWER($5),$6))
	ORDER BY resource_type,LOWER(name),id LIMIT $7`, accountID, userID, environmentID, cursorType, cursorName, cursorID, limit+1)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskSharedResource, 0, limit+1)
	for rows.Next() {
		item := &domain.TaskSharedResource{}
		var rank int
		if err := rows.Scan(&item.Type, &item.ID, &item.EnvironmentID, &item.Name, &item.Color, &item.Icon, &item.AccessMode, &rank); err != nil {
			return nil, nil, err
		}
		item.Name = strings.TrimSpace(item.Name)
		item.EffectiveAccessLevel = taskAccessLevelFromRank(rank)
		item.Capabilities = buildTaskEffectiveAccess(item.EffectiveAccessLevel, false, item.Type+"_grant")
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *TaskSharedResourceCursor
	if len(items) > limit {
		boundary := items[limit-1]
		next = &TaskSharedResourceCursor{Type: boundary.Type, Name: boundary.Name, ID: boundary.ID}
		items = items[:limit]
	}
	return items, next, nil
}
