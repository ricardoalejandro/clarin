package repository

import (
	"context"
	"errors"
	"time"

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

// requireContainerAccessIncludingLifecycleTx resolves the exact Folder/List
// policy without applying active-only predicates. Callers first lock the actor
// membership, then the resource row, and only then invoke this resolver. That
// ordering makes an ACL downgrade or membership removal serialize with the
// lifecycle mutation instead of becoming a time-of-check/time-of-use bypass.
func requireContainerAccessIncludingLifecycleTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID, resourceID uuid.UUID,
	resourceType, required string,
) error {
	var query string
	switch resourceType {
	case domain.TaskAccessTargetFolder:
		query = `SELECT (` + taskActorFolderAccessRankSQL("folder", "$3") + `)
			FROM task_folders folder WHERE folder.account_id=$1 AND folder.id=$2`
	case domain.TaskAccessTargetList:
		query = `SELECT (` + taskActorListAccessRankSQL("list_item", "$3") + `)
			FROM task_lists list_item WHERE list_item.account_id=$1 AND list_item.id=$2`
	default:
		return ErrTaskAccessInvalid
	}
	var rank int
	if err := tx.QueryRow(ctx, query, accountID, resourceID, actorID).Scan(&rank); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if rank < taskAccessRank(required) {
		if rank < taskAccessRank(domain.TaskAccessView) {
			return ErrTaskWorkNotFound
		}
		return ErrTaskAccessDenied
	}
	return nil
}

// requireFolderChildListAccessIncludingLifecycleTx verifies a whole locked
// Folder operation in one set-based query. A specific List grant may lower or
// deny inherited Folder access and must therefore veto operations that mutate
// that List through its parent.
func requireFolderChildListAccessIncludingLifecycleTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	listIDs []uuid.UUID,
	required string,
) error {
	return requireTaskListSetAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listIDs, required, true)
}

func requireTaskListSetAccessIncludingLifecycleTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	listIDs []uuid.UUID,
	required string,
	hideInvisible bool,
) error {
	if len(listIDs) == 0 {
		return nil
	}
	var total, invisible, insufficient int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int,
		COUNT(*) FILTER (WHERE actor_access.access_rank<1)::int,
		COUNT(*) FILTER (WHERE actor_access.access_rank<$4)::int
		FROM task_lists list_item
		CROSS JOIN LATERAL (SELECT (`+taskActorListAccessRankSQL("list_item", "$3")+`) AS access_rank) actor_access
		WHERE list_item.account_id=$1 AND list_item.id=ANY($2::uuid[])`,
		accountID, listIDs, actorID, taskAccessRank(required)).Scan(&total, &invisible, &insufficient); err != nil {
		return err
	}
	if total != len(listIDs) {
		return ErrTaskWorkNotFound
	}
	if invisible > 0 && hideInvisible {
		return ErrTaskWorkNotFound
	}
	if insufficient > 0 {
		return ErrTaskAccessDenied
	}
	return nil
}

func requireTaskFolderSetAccessIncludingLifecycleTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	folderIDs []uuid.UUID,
	required string,
) error {
	if len(folderIDs) == 0 {
		return nil
	}
	var total, insufficient int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)::int,
		COUNT(*) FILTER (WHERE actor_access.access_rank<$4)::int
		FROM task_folders folder
		CROSS JOIN LATERAL (SELECT (`+taskActorFolderAccessRankSQL("folder", "$3")+`) AS access_rank) actor_access
		WHERE folder.account_id=$1 AND folder.id=ANY($2::uuid[])`,
		accountID, folderIDs, actorID, taskAccessRank(required)).Scan(&total, &insufficient); err != nil {
		return err
	}
	if total != len(folderIDs) {
		return ErrTaskWorkNotFound
	}
	if insufficient > 0 {
		return ErrTaskAccessDenied
	}
	return nil
}

type taskEnvironmentLifecycleScope string

const (
	taskEnvironmentLifecycleRetained          taskEnvironmentLifecycleScope = "retained"
	taskEnvironmentLifecycleActive            taskEnvironmentLifecycleScope = "active"
	taskEnvironmentLifecycleDeletedWithParent taskEnvironmentLifecycleScope = "deleted_with_environment"
)

func lockEnvironmentLifecycleDescendantsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, environmentID uuid.UUID,
	scope taskEnvironmentLifecycleScope,
) ([]uuid.UUID, []uuid.UUID, error) {
	folderPredicate, listPredicate := "", ""
	switch scope {
	case taskEnvironmentLifecycleRetained:
		folderPredicate, listPredicate = " AND deleted_at IS NULL", " AND deleted_at IS NULL"
	case taskEnvironmentLifecycleActive:
		folderPredicate, listPredicate = " AND deleted_at IS NULL", " AND deleted_at IS NULL"
	case taskEnvironmentLifecycleDeletedWithParent:
		folderPredicate = " AND deleted_at IS NOT NULL AND deleted_with_environment"
		listPredicate = " AND deleted_at IS NOT NULL AND deleted_with_environment"
	default:
		return nil, nil, ErrTaskAccessInvalid
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_folders
		WHERE account_id=$1 AND environment_id=$2`+folderPredicate+` ORDER BY id FOR UPDATE`, accountID, environmentID)
	if err != nil {
		return nil, nil, err
	}
	folderIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, err
		}
		folderIDs = append(folderIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()

	rows, err = tx.Query(ctx, `SELECT id FROM task_lists
		WHERE account_id=$1 AND environment_id=$2`+listPredicate+` ORDER BY id FOR UPDATE`, accountID, environmentID)
	if err != nil {
		return nil, nil, err
	}
	listIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, nil, err
		}
		listIDs = append(listIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	return folderIDs, listIDs, nil
}

func requireEnvironmentDescendantAccessIncludingLifecycleTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	folderIDs, listIDs []uuid.UUID,
) error {
	if err := requireTaskFolderSetAccessIncludingLifecycleTx(
		ctx, tx, accountID, actorID, folderIDs, domain.TaskAccessFull,
	); err != nil {
		return err
	}
	return requireTaskListSetAccessIncludingLifecycleTx(
		ctx, tx, accountID, actorID, listIDs, domain.TaskAccessFull, false,
	)
}

func revalidateContainerLifecycleAuthorityTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID, resourceID uuid.UUID,
	resourceType string,
	childListIDs []uuid.UUID,
) error {
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return err
	}
	if err := requireContainerAccessIncludingLifecycleTx(
		ctx, tx, accountID, actorID, resourceID, resourceType, domain.TaskAccessFull,
	); err != nil {
		return err
	}
	if resourceType == domain.TaskAccessTargetFolder {
		return requireFolderChildListAccessIncludingLifecycleTx(
			ctx, tx, accountID, actorID, childListIDs, domain.TaskAccessFull,
		)
	}
	return nil
}

func revalidateEnvironmentLifecycleAuthorityTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID, environmentID uuid.UUID,
	allowTrash bool,
	folderIDs, listIDs []uuid.UUID,
) error {
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(
		ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, allowTrash,
	); err != nil {
		return err
	}
	return requireEnvironmentDescendantAccessIncludingLifecycleTx(
		ctx, tx, accountID, actorID, folderIDs, listIDs,
	)
}

// ListArchiveHierarchyForActor returns only historical structure for an active
// Entorno, or the complete non-Trash structure when the Entorno itself is
// archived. Active folders may be returned as breadcrumb containers when they
// own individually archived lists.
func (r *TaskWorkRepository) ListArchiveHierarchyForActor(ctx context.Context, accountID, actorID, environmentID uuid.UUID, includeWhiteboardCounts bool) ([]*domain.TaskFolder, []*domain.TaskList, error) {
	var environmentArchived bool
	err := r.db.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM task_environments environment
		WHERE environment.account_id=$1 AND environment.id=$2 AND environment.deleted_at IS NULL
		  AND `+taskActorAccountMembershipSQL("environment", "$3")+`
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
			(`+taskActorFolderCanManageSQL("folder", "$3")+`) AS can_manage_access,
			CASE WHEN $5::boolean AND ($4::boolean OR folder.archived_at IS NOT NULL)
				THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END
			FROM task_folders folder
			LEFT JOIN LATERAL (
				SELECT COUNT(*)::int AS whiteboard_count
				FROM task_location_views location_view
				JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id
					AND binding.task_view_id=location_view.id
				JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
				WHERE $5::boolean AND location_view.account_id=folder.account_id AND location_view.deleted_at IS NULL AND board.archived_at IS NULL
				  AND location_view.folder_id=folder.id
			) contextual ON TRUE
		WHERE folder.account_id=$1 AND folder.environment_id=$2 AND folder.deleted_at IS NULL
		  AND `+taskActorAccountMembershipSQL("folder", "$3")+`
		  AND ($4::boolean OR folder.archived_at IS NOT NULL OR EXISTS(
			SELECT 1 FROM task_lists archived_list WHERE archived_list.account_id=folder.account_id
			  AND archived_list.folder_id=folder.id AND archived_list.archived_at IS NOT NULL AND archived_list.deleted_at IS NULL))
		  AND (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1
		ORDER BY folder.sort_order,folder.id`, accountID, environmentID, actorID, environmentArchived, includeWhiteboardCounts)
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
			&item.CreatedAt, &item.UpdatedAt, &rank, &manage, &item.WhiteboardCount); err != nil {
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

	listRows, err := r.db.Query(ctx, `SELECT list_item.id,list_item.account_id,list_item.environment_id,
		CASE WHEN folder.id IS NOT NULL AND (`+taskActorFolderAccessRankSQL("folder", "$3")+`)>=1 THEN list_item.folder_id END,
		list_item.workflow_id,
		COALESCE(list_item.workflow_inherited,TRUE),COALESCE(list_item.is_default,FALSE),list_item.name,
		COALESCE(list_item.description,''),list_item.color,COALESCE(list_item.icon,CASE WHEN list_item.is_default THEN 'inbox' ELSE 'list' END),
		list_item.sort_order,list_item.created_by,list_item.archived_at,COALESCE(list_item.archived_with_folder,FALSE),
		list_item.deleted_at,list_item.deleted_by,COALESCE(list_item.deleted_with_folder,FALSE),list_item.access_mode,list_item.access_revision,
		list_item.created_at,list_item.updated_at,
		(`+taskActorListAccessRankSQL("list_item", "$3")+`) AS access_rank,
		(`+taskActorListCanManageSQL("list_item", "$3")+`) AS can_manage_access,
			COALESCE(counts.task_count,0),COALESCE(counts.open_count,0),COALESCE(counts.done_count,0),COALESCE(counts.cancelled_count,0),
			CASE WHEN $5::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END
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
			LEFT JOIN LATERAL (
				SELECT COUNT(*)::int AS whiteboard_count
				FROM task_location_views location_view
				JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id
					AND binding.task_view_id=location_view.id
				JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
				WHERE $5::boolean AND location_view.account_id=list_item.account_id AND location_view.list_id=list_item.id
				  AND location_view.deleted_at IS NULL AND board.archived_at IS NULL
			) contextual ON TRUE
		WHERE list_item.account_id=$1 AND list_item.environment_id=$2 AND list_item.deleted_at IS NULL
		  AND `+taskActorAccountMembershipSQL("list_item", "$3")+`
		  AND ($4::boolean OR list_item.archived_at IS NOT NULL OR folder.archived_at IS NOT NULL)
		  AND (folder.id IS NULL OR folder.deleted_at IS NULL)
		  AND (`+taskActorListAccessRankSQL("list_item", "$3")+`)>=1
		ORDER BY list_item.sort_order,list_item.id`, accountID, environmentID, actorID, environmentArchived, includeWhiteboardCounts)
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
			&item.CompletedTaskCount, &item.CancelledTaskCount, &item.WhiteboardCount); err != nil {
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

func (r *TaskWorkRepository) ArchiveList(ctx context.Context, accountID, actorID, listID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var environmentID uuid.UUID
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT environment_id,is_default FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, accountID, listID).Scan(&environmentID, &isDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if isDefault {
		return nil, ErrDefaultTaskList
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	var open int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND task.list_id=$2 AND task.deleted_at IS NULL AND `+taskOpenCategorySQL("task", "status"), accountID, listID).Scan(&open); err != nil {
		return nil, err
	}
	if open > 0 {
		return nil, ErrTaskContainerHasOpenTasks
	}
	hasFutureEvents, err := hasFutureScheduledWorkEventsWith(ctx, tx, accountID, []uuid.UUID{listID}, nil, time.Now())
	if err != nil {
		return nil, err
	}
	if hasFutureEvents {
		return nil, ErrTaskContainerHasFutureEvents
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, nil); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),archived_with_folder=FALSE,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, listID); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, nil, []uuid.UUID{listID}, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

func (r *TaskWorkRepository) UnarchiveList(ctx context.Context, accountID, actorID, listID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var environmentID uuid.UUID
	var folderID *uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id,folder_id FROM task_lists
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, accountID, listID).Scan(&environmentID, &folderID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if folderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT archived_at IS NULL AND deleted_at IS NULL FROM task_folders
				WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, *folderID).Scan(&active); err != nil || !active {
			return nil, ErrTaskParentArchived
		}
	}
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_lists
		WHERE account_id=$1 AND environment_id=$2 AND folder_id IS NOT DISTINCT FROM $3::uuid
		  AND archived_at IS NULL AND deleted_at IS NULL`, accountID, environmentID, folderID).Scan(&next); err != nil {
		return nil, err
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, nil); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NULL,archived_with_folder=FALSE,sort_order=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, listID, next); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, nil, []uuid.UUID{listID}, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

func (r *TaskWorkRepository) ArchiveFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id FROM task_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return nil, err
	}
	listIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		listIDs = append(listIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := requireFolderChildListAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listIDs, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	var open int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
		WHERE task.account_id=$1 AND list_item.folder_id=$2 AND task.deleted_at IS NULL AND list_item.deleted_at IS NULL
		  AND `+taskOpenCategorySQL("task", "status"), accountID, folderID).Scan(&open); err != nil {
		return nil, err
	}
	if open > 0 {
		return nil, ErrTaskContainerHasOpenTasks
	}
	hasFutureEvents, err := hasFutureScheduledWorkEventsWith(ctx, tx, accountID, listIDs, nil, time.Now())
	if err != nil {
		return nil, err
	}
	if hasFutureEvents {
		return nil, ErrTaskContainerHasFutureEvents
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, folderID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET archived_at=NOW(),archived_with_folder=TRUE,updated_at=NOW()
		WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, folderID); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, []uuid.UUID{folderID}, listIDs, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

func (r *TaskWorkRepository) UnarchiveFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT environment_id FROM task_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL AND deleted_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NULL ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return nil, err
	}
	listIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		listIDs = append(listIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if err := requireFolderChildListAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listIDs, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_folders
		WHERE account_id=$1 AND environment_id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, environmentID).Scan(&next); err != nil {
		return nil, err
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET archived_at=NULL,sort_order=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, folderID, next); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `WITH ordered AS (
		SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,created_at,id) AS position FROM task_lists
		WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NOT NULL AND archived_with_folder AND deleted_at IS NULL
	) UPDATE task_lists list_item SET archived_at=NULL,archived_with_folder=FALSE,
		sort_order=ordered.position*1024,updated_at=NOW()
	FROM ordered WHERE list_item.account_id=$1 AND list_item.id=ordered.id`, accountID, folderID); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, []uuid.UUID{folderID}, listIDs, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}
