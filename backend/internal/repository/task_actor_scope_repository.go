package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type actorTaskListCounts struct {
	Total, Open, Done, Cancelled int
}

func (r *TaskWorkRepository) accessibleEnvironmentIDs(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) (map[uuid.UUID]*domain.TaskEffectiveAccess, error) {
	query := `SELECT environment.id FROM task_environments environment
		WHERE environment.account_id=$1 AND environment.archived_at IS NULL
		  AND ($3::uuid IS NULL OR environment.id=$3)
		  AND (` + environmentActorAccessRankSQL("environment", "$2") + `) >= 1
		ORDER BY environment.sort_order,environment.id`
	rows, err := r.db.Query(ctx, query, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[uuid.UUID]*domain.TaskEffectiveAccess)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		access, err := r.ResolveEnvironmentAccess(ctx, accountID, userID, id)
		if err != nil {
			return nil, err
		}
		result[id] = access
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) actorVisibleTaskCounts(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) (map[uuid.UUID]actorTaskListCounts, error) {
	rows, err := r.db.Query(ctx, `SELECT list_item.id,
		COUNT(*)::int,
		COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END) NOT IN ('done','cancelled'))::int,
		COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='done')::int,
		COUNT(*) FILTER (WHERE COALESCE(status.category,CASE task.status WHEN 'completed' THEN 'done' WHEN 'cancelled' THEN 'cancelled' ELSE 'not_started' END)='cancelled')::int
		FROM task_lists list_item
		JOIN tasks task ON task.account_id=list_item.account_id AND task.list_id=list_item.id
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE list_item.account_id=$1 AND ($3::uuid IS NULL OR list_item.environment_id=$3)
		  AND task.parent_task_id IS NULL AND task.deleted_at IS NULL
		  AND `+taskActorCanViewSQL("task", "list_item", "$2")+`
		GROUP BY list_item.id`, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(map[uuid.UUID]actorTaskListCounts)
	for rows.Next() {
		var id uuid.UUID
		var counts actorTaskListCounts
		if err := rows.Scan(&id, &counts.Total, &counts.Open, &counts.Done, &counts.Cancelled); err != nil {
			return nil, err
		}
		result[id] = counts
	}
	return result, rows.Err()
}

func (r *TaskWorkRepository) ListFoldersForActor(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) ([]*domain.TaskFolder, []*domain.TaskList, error) {
	allowed, err := r.accessibleEnvironmentIDs(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, nil, err
	}
	if len(allowed) == 0 {
		return []*domain.TaskFolder{}, []*domain.TaskList{}, nil
	}
	folders, roots, err := r.ListFolders(ctx, accountID)
	if err != nil {
		return nil, nil, err
	}
	counts, err := r.actorVisibleTaskCounts(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, nil, err
	}
	allLists := append([]*domain.TaskList{}, roots...)
	for _, folder := range folders {
		allLists = append(allLists, folder.Lists...)
	}
	if err := r.ApplyFolderAccess(ctx, accountID, userID, folders); err != nil {
		return nil, nil, err
	}
	if err := r.ApplyListAccess(ctx, accountID, userID, allLists); err != nil {
		return nil, nil, err
	}
	applyList := func(list *domain.TaskList) bool {
		if allowed[list.EnvironmentID] == nil || list.Permissions == nil || !list.Permissions.CanView {
			return false
		}
		list.TaskCount, list.OpenTaskCount, list.CompletedTaskCount, list.CancelledTaskCount = 0, 0, 0, 0
		if visible := counts[list.ID]; visible.Total > 0 {
			list.TaskCount, list.OpenTaskCount = visible.Total, visible.Open
			list.CompletedTaskCount, list.CancelledTaskCount = visible.Done, visible.Cancelled
		}
		return true
	}
	filteredRoots := make([]*domain.TaskList, 0, len(roots))
	for _, list := range roots {
		if applyList(list) {
			filteredRoots = append(filteredRoots, list)
		}
	}
	filteredFolders := make([]*domain.TaskFolder, 0, len(folders))
	for _, folder := range folders {
		if allowed[folder.EnvironmentID] == nil || folder.Permissions == nil || !folder.Permissions.CanView {
			continue
		}
		folder.TaskCount, folder.OpenTaskCount, folder.CompletedTaskCount, folder.CancelledTaskCount = 0, 0, 0, 0
		filteredLists := make([]*domain.TaskList, 0, len(folder.Lists))
		for _, list := range folder.Lists {
			if applyList(list) {
				filteredLists = append(filteredLists, list)
				addTaskListCountsToFolder(folder, list)
			}
		}
		folder.Lists = filteredLists
		filteredFolders = append(filteredFolders, folder)
	}
	return filteredFolders, filteredRoots, nil
}

func (r *TaskWorkRepository) HierarchyCountsForActor(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) (*domain.TaskHierarchyCounts, error) {
	folders, roots, err := r.ListFoldersForActor(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	snapshot := buildTaskHierarchyCounts(folders, roots)
	if err := r.db.QueryRow(ctx, `SELECT txid_current()::bigint,clock_timestamp()`).Scan(&snapshot.Revision, &snapshot.CapturedAt); err != nil {
		return nil, err
	}
	snapshot.CapturedAt = snapshot.CapturedAt.UTC()
	return snapshot, nil
}

func (r *TaskWorkRepository) ListWorkflowsForActor(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) ([]*domain.TaskWorkflow, error) {
	allowed, err := r.accessibleEnvironmentIDs(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	workflows, err := r.ListWorkflows(ctx, accountID)
	if err != nil {
		return nil, err
	}
	filtered := make([]*domain.TaskWorkflow, 0, len(workflows))
	for _, workflow := range workflows {
		if allowed[workflow.EnvironmentID] != nil {
			filtered = append(filtered, workflow)
		}
	}
	return filtered, nil
}

func (r *TaskWorkRepository) ListsForActor(ctx context.Context, accountID, userID uuid.UUID, environmentID *uuid.UUID) ([]*domain.TaskList, error) {
	folders, roots, err := r.ListFoldersForActor(ctx, accountID, userID, environmentID)
	if err != nil {
		return nil, err
	}
	lists := append([]*domain.TaskList{}, roots...)
	for _, folder := range folders {
		lists = append(lists, folder.Lists...)
	}
	return lists, nil
}
