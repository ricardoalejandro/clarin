package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrTaskTrashConfirmation = errors.New("task trash confirmation does not match")
	ErrTaskTrashDisabled     = errors.New("task trash permanent deletion is disabled")
	ErrTaskTrashNotEligible  = errors.New("task trash item is not eligible for permanent deletion")
)

type TaskTrashEligibilityError struct {
	NextEligibleAt *time.Time
}

func (e *TaskTrashEligibilityError) Error() string { return ErrTaskTrashNotEligible.Error() }
func (e *TaskTrashEligibilityError) Unwrap() error { return ErrTaskTrashNotEligible }

func (r *TaskWorkRepository) GetTrashRetentionDays(ctx context.Context, accountID uuid.UUID) (*int, error) {
	var days *int
	if err := r.db.QueryRow(ctx, `SELECT task_trash_retention_days FROM accounts WHERE id=$1`, accountID).Scan(&days); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	return days, nil
}

func (r *TaskWorkRepository) UpdateTrashRetentionDays(ctx context.Context, accountID uuid.UUID, days *int) error {
	if days != nil && (*days < 7 || *days > 365) {
		return fmt.Errorf("retention days must be between 7 and 365")
	}
	command, err := r.db.Exec(ctx, `UPDATE accounts SET task_trash_retention_days=$2,updated_at=NOW() WHERE id=$1`, accountID, days)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskWorkNotFound
	}
	return err
}

func trashEligibility(deletedAt time.Time, days *int, now time.Time) (*time.Time, bool) {
	if days == nil {
		return nil, false
	}
	next := deletedAt.Add(time.Duration(*days) * 24 * time.Hour)
	return &next, !next.After(now)
}

func taskContainerTrashEligibility(
	parentLatestDeletedAt time.Time,
	taskRetentionDays, whiteboardRetentionDays *int,
	explicitWhiteboardDeletedAt *time.Time,
	now time.Time,
) (*time.Time, bool) {
	parentEligibleAt, _ := trashEligibility(parentLatestDeletedAt, taskRetentionDays, now)
	if parentEligibleAt == nil {
		return nil, false
	}
	eligibleAt, err := taskLocationWhiteboardPurgeEligibleAt(
		*parentEligibleAt, explicitWhiteboardDeletedAt, nil, whiteboardRetentionDays,
	)
	if err != nil {
		return nil, false
	}
	return &eligibleAt, !eligibleAt.After(now)
}

func (r *TaskWorkRepository) getWhiteboardTrashRetentionDays(ctx context.Context, accountID uuid.UUID) (*int, error) {
	var days *int
	if err := r.db.QueryRow(ctx, `SELECT whiteboard_trash_retention_days FROM accounts WHERE id=$1`, accountID).Scan(&days); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	return days, nil
}

func taskActorAccountMembershipSQL(resourceAlias, actorExpression string) string {
	return fmt.Sprintf(`EXISTS(SELECT 1 FROM user_accounts trash_membership
		WHERE trash_membership.account_id=%s.account_id AND trash_membership.user_id=%s)`, resourceAlias, actorExpression)
}

// taskTrashLocationViewCanViewSQL applies the same Work hierarchy resolver as
// the canonical location-view endpoints. Contextual whiteboard counts and
// retention clocks must not reveal a denied Folder or List merely because an
// ancestor remains visible.
func taskTrashLocationViewCanViewSQL(locationAlias, actorExpression string) string {
	folderVisible := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_folders trash_location_folder
		WHERE trash_location_folder.account_id=%s.account_id AND trash_location_folder.id=%s.folder_id
		  AND (%s)>=1)`, locationAlias, locationAlias,
		taskActorFolderAccessRankSQL("trash_location_folder", actorExpression))
	folderManage := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_folders trash_location_folder
		WHERE trash_location_folder.account_id=%s.account_id AND trash_location_folder.id=%s.folder_id
		  AND (%s))`, locationAlias, locationAlias,
		taskActorFolderCanManageSQL("trash_location_folder", actorExpression))
	listVisible := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_lists trash_location_list
		WHERE trash_location_list.account_id=%s.account_id AND trash_location_list.id=%s.list_id
		  AND (%s)>=1)`, locationAlias, locationAlias,
		taskActorListAccessRankSQL("trash_location_list", actorExpression))
	listManage := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_lists trash_location_list
		WHERE trash_location_list.account_id=%s.account_id AND trash_location_list.id=%s.list_id
		  AND (%s))`, locationAlias, locationAlias,
		taskActorListCanManageSQL("trash_location_list", actorExpression))
	member := fmt.Sprintf(`EXISTS(SELECT 1 FROM task_location_view_visibility_members visibility_member
		WHERE visibility_member.account_id=%s.account_id AND visibility_member.task_view_id=%s.id
		AND visibility_member.user_id=%s)`, locationAlias, locationAlias, actorExpression)
	return fmt.Sprintf(`(((%s.folder_id IS NOT NULL AND %s) OR (%s.list_id IS NOT NULL AND %s))
		AND (%s.visibility_mode='inherit' OR %s OR %s OR %s))`,
		locationAlias, folderVisible, locationAlias, listVisible, locationAlias, member, folderManage, listManage)
}

func (r *TaskWorkRepository) ListTrashContainers(ctx context.Context, accountID, actorID, environmentID uuid.UUID, now time.Time, includeWhiteboardCounts bool) ([]*domain.TaskTrashContainer, error) {
	days, err := r.GetTrashRetentionDays(ctx, accountID)
	if err != nil {
		return nil, err
	}
	whiteboardDays, err := r.getWhiteboardTrashRetentionDays(ctx, accountID)
	if err != nil {
		return nil, err
	}
	items := make([]*domain.TaskTrashContainer, 0)
	folderRows, err := r.db.Query(ctx, `
		SELECT folder.id,folder.name,folder.color,folder.icon,folder.deleted_at,folder.archived_at,
			COALESCE(children.list_count,0),COALESCE(children.task_count,0),
			CASE WHEN $4::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END,
			GREATEST(folder.deleted_at,COALESCE(children.latest_deleted_at,folder.deleted_at)),
			contextual.latest_explicit_deleted_at
		FROM task_folders folder
		JOIN task_environments environment ON environment.account_id=folder.account_id AND environment.id=folder.environment_id
		CROSS JOIN LATERAL (SELECT (`+taskActorFolderAccessRankSQL("folder", "$2")+`) AS folder_rank) actor_access
		LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT list_item.id) FILTER (WHERE (`+taskActorListAccessRankSQL("list_item", "$2")+`)>=1)::int AS list_count,
				COUNT(DISTINCT task.id) FILTER (WHERE task.id IS NOT NULL AND `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$2")+`)::int AS task_count,
				MAX(GREATEST(COALESCE(list_item.deleted_at,folder.deleted_at),COALESCE(task.deleted_at,folder.deleted_at))) AS latest_deleted_at
			FROM task_lists list_item LEFT JOIN tasks task ON task.account_id=list_item.account_id AND task.list_id=list_item.id
			WHERE list_item.account_id=folder.account_id AND list_item.folder_id=folder.id
		) children ON TRUE
		LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`)::int AS whiteboard_count,
				MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`) AS latest_explicit_deleted_at
			FROM task_location_views location_view
			JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id AND binding.task_view_id=location_view.id
			JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
			WHERE location_view.account_id=folder.account_id AND (location_view.folder_id=folder.id OR location_view.list_id IN (
				SELECT child_list.id FROM task_lists child_list WHERE child_list.account_id=folder.account_id AND child_list.folder_id=folder.id))
		) contextual ON TRUE
		WHERE folder.account_id=$1 AND environment.id=$3 AND folder.deleted_at IS NOT NULL AND environment.deleted_at IS NULL
		  AND `+taskActorAccountMembershipSQL("folder", "$2")+`
		  AND actor_access.folder_rank>=4
		ORDER BY folder.deleted_at DESC,folder.id`, accountID, actorID, environmentID, includeWhiteboardCounts)
	if err != nil {
		return nil, err
	}
	for folderRows.Next() {
		item := &domain.TaskTrashContainer{Type: "folder", Lifecycle: domain.TaskLifecycleTrash, CanRestore: true}
		var latest time.Time
		var explicitWhiteboardDeletedAt *time.Time
		if err := folderRows.Scan(&item.ID, &item.Name, &item.Color, &item.Icon, &item.DeletedAt, &item.ArchivedAt,
			&item.ListCount, &item.TaskCount, &item.WhiteboardCount, &latest, &explicitWhiteboardDeletedAt); err != nil {
			folderRows.Close()
			return nil, err
		}
		item.NextEligibleAt, item.CanPurge = taskContainerTrashEligibility(
			latest, days, whiteboardDays, explicitWhiteboardDeletedAt, now,
		)
		items = append(items, item)
	}
	if err := folderRows.Err(); err != nil {
		folderRows.Close()
		return nil, err
	}
	folderRows.Close()

	listRows, err := r.db.Query(ctx, `
		SELECT list_item.id,list_item.name,list_item.color,list_item.icon,list_item.deleted_at,list_item.archived_at,
			CASE WHEN actor_access.folder_rank>=1 THEN folder.id END,
			CASE WHEN actor_access.folder_rank>=1 THEN COALESCE(folder.name,'') ELSE '' END,
			list_item.deleted_with_folder,folder.id IS NOT NULL,folder.deleted_at,
			COALESCE(children.task_count,0),
			CASE WHEN $4::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END,
			GREATEST(list_item.deleted_at,COALESCE(children.latest_deleted_at,list_item.deleted_at)),
			contextual.latest_explicit_deleted_at
		FROM task_lists list_item
		JOIN task_environments environment ON environment.account_id=list_item.account_id AND environment.id=list_item.environment_id
		LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
		CROSS JOIN LATERAL (SELECT (`+taskActorListAccessRankSQL("list_item", "$2")+`) AS list_rank,
			CASE WHEN folder.id IS NULL THEN 0 ELSE (`+taskActorFolderAccessRankSQL("folder", "$2")+`) END AS folder_rank) actor_access
		LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$2")+`)::int AS task_count,
				MAX(COALESCE(task.deleted_at,list_item.deleted_at)) AS latest_deleted_at
			FROM tasks task WHERE task.account_id=list_item.account_id AND task.list_id=list_item.id
		) children ON TRUE
		LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`)::int AS whiteboard_count,
				MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`) AS latest_explicit_deleted_at
			FROM task_location_views location_view
			JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id AND binding.task_view_id=location_view.id
			JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
			WHERE location_view.account_id=list_item.account_id AND location_view.list_id=list_item.id
		) contextual ON TRUE
		WHERE list_item.account_id=$1 AND environment.id=$3 AND list_item.deleted_at IS NOT NULL AND NOT list_item.is_default
			AND NOT list_item.deleted_with_folder AND environment.deleted_at IS NULL
			AND `+taskActorAccountMembershipSQL("list_item", "$2")+`
			AND actor_access.list_rank>=4
		ORDER BY list_item.deleted_at DESC,list_item.id`, accountID, actorID, environmentID, includeWhiteboardCounts)
	if err != nil {
		return nil, err
	}
	defer listRows.Close()
	for listRows.Next() {
		item := &domain.TaskTrashContainer{Type: "list", Lifecycle: domain.TaskLifecycleTrash, CanRestore: true}
		var parentDeletedAt *time.Time
		var hasParent bool
		var latest time.Time
		var explicitWhiteboardDeletedAt *time.Time
		if err := listRows.Scan(&item.ID, &item.Name, &item.Color, &item.Icon, &item.DeletedAt, &item.ArchivedAt,
			&item.OriginalFolderID, &item.OriginalFolderName, &item.DeletedWithFolder, &hasParent, &parentDeletedAt,
			&item.TaskCount, &item.WhiteboardCount, &latest, &explicitWhiteboardDeletedAt); err != nil {
			return nil, err
		}
		item.RestoreBlocked = hasParent && parentDeletedAt != nil
		item.NextEligibleAt, item.CanPurge = taskContainerTrashEligibility(
			latest, days, whiteboardDays, explicitWhiteboardDeletedAt, now,
		)
		items = append(items, item)
	}
	return items, listRows.Err()
}

func (r *TaskWorkRepository) TrashListConfirmed(ctx context.Context, accountID, actorID, listID uuid.UUID, expectedName string) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var name string
	var environmentID uuid.UUID
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT name,is_default,environment_id FROM task_lists WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, listID).Scan(&name, &isDefault, &environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	if isDefault {
		return nil, ErrDefaultTaskList
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
	}
	var active int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, listID).Scan(&active); err != nil {
		return nil, err
	}
	if active > 0 {
		return nil, ErrTaskContainerNotEmpty
	}
	var retainedEvents int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_events
		WHERE account_id=$1 AND list_id=$2 AND deleted_at IS NULL`, accountID, listID).Scan(&retainedEvents); err != nil {
		return nil, err
	}
	if retainedEvents > 0 {
		return nil, ErrTaskContainerHasWorkEvents
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, nil); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NOW(),deleted_by=$3,deleted_with_folder=FALSE,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, listID, actorID); err != nil {
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

// ArchiveListConfirmed remains as a compatibility alias for callers compiled
// against the first Trash implementation. New code must use TrashListConfirmed.
func (r *TaskWorkRepository) ArchiveListConfirmed(ctx context.Context, accountID, actorID, listID uuid.UUID, expectedName string) ([]uuid.UUID, error) {
	return r.TrashListConfirmed(ctx, accountID, actorID, listID, expectedName)
}

func (r *TaskWorkRepository) TrashFolderConfirmed(ctx context.Context, accountID, actorID, folderID uuid.UUID, expectedName string) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var name string
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT name,environment_id FROM task_folders WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&name, &environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
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
	var active int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists list ON list.account_id=task.account_id AND list.id=task.list_id WHERE task.account_id=$1 AND list.folder_id=$2 AND task.deleted_at IS NULL`, accountID, folderID).Scan(&active); err != nil {
		return nil, err
	}
	if active > 0 {
		return nil, ErrTaskContainerNotEmpty
	}
	var retainedEvents int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_events event_item
		JOIN task_lists list ON list.account_id=event_item.account_id AND list.id=event_item.list_id
		WHERE event_item.account_id=$1 AND list.folder_id=$2 AND event_item.deleted_at IS NULL`, accountID, folderID).Scan(&retainedEvents); err != nil {
		return nil, err
	}
	if retainedEvents > 0 {
		return nil, ErrTaskContainerHasWorkEvents
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET deleted_at=NOW(),deleted_by=$3,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, folderID, actorID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET folder_id=NULL,workflow_inherited=TRUE,updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND is_default AND deleted_at IS NULL`, accountID, folderID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NOW(),deleted_by=$3,deleted_with_folder=TRUE,updated_at=NOW() WHERE account_id=$1 AND folder_id=$2 AND NOT is_default AND deleted_at IS NULL`, accountID, folderID, actorID); err != nil {
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

func (r *TaskWorkRepository) ArchiveFolderConfirmed(ctx context.Context, accountID, actorID, folderID uuid.UUID, expectedName string) ([]uuid.UUID, error) {
	return r.TrashFolderConfirmed(ctx, accountID, actorID, folderID, expectedName)
}

func (r *TaskWorkRepository) RestoreList(ctx context.Context, accountID, actorID, listID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var folderID *uuid.UUID
	var environmentID uuid.UUID
	var isDefault bool
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT folder_id,is_default,environment_id,archived_at FROM task_lists WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, listID).Scan(&folderID, &isDefault, &environmentID, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	if isDefault {
		return nil, ErrDefaultTaskList
	}
	if folderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT deleted_at IS NULL AND ($2::boolean OR archived_at IS NULL) FROM task_folders WHERE account_id=$1 AND id=$3 FOR UPDATE`, accountID, archivedAt != nil, *folderID).Scan(&active); err != nil {
			return nil, ErrTaskParentArchived
		}
		if !active {
			return nil, ErrTaskParentArchived
		}
	}
	var next int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_lists WHERE account_id=$1 AND folder_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL AND deleted_at IS NULL`, accountID, folderID).Scan(&next); err != nil {
		return nil, err
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, nil); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NULL,deleted_by=NULL,deleted_with_folder=FALSE,
		sort_order=CASE WHEN archived_at IS NULL THEN $3 ELSE sort_order END,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, listID, next); err != nil {
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

func (r *TaskWorkRepository) RestoreFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var environmentID uuid.UUID
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT environment_id,archived_at FROM task_folders WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, folderID).Scan(&environmentID, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND folder_id=$2 ORDER BY id FOR UPDATE`, accountID, folderID)
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
	var nextFolder int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_folders WHERE account_id=$1 AND environment_id=$2 AND archived_at IS NULL AND deleted_at IS NULL`, accountID, environmentID).Scan(&nextFolder); err != nil {
		return nil, err
	}
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET deleted_at=NULL,deleted_by=NULL,
		sort_order=CASE WHEN archived_at IS NULL THEN $3 ELSE sort_order END,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, folderID, nextFolder); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `WITH ordered AS (
		SELECT id,ROW_NUMBER() OVER(ORDER BY sort_order,created_at,id) AS position FROM task_lists
		WHERE account_id=$1 AND folder_id=$2 AND deleted_at IS NOT NULL AND deleted_with_folder
	) UPDATE task_lists list SET deleted_at=NULL,deleted_by=NULL,deleted_with_folder=FALSE,
		sort_order=CASE WHEN list.archived_at IS NULL THEN ordered.position*1024 ELSE list.sort_order END,updated_at=NOW()
	FROM ordered WHERE list.account_id=$1 AND list.id=ordered.id`, accountID, folderID); err != nil {
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

func (r *TaskWorkRepository) ListTrashEnvironments(ctx context.Context, accountID, actorID uuid.UUID, now time.Time, includeWhiteboardCounts bool) ([]*domain.TaskTrashContainer, error) {
	days, err := r.GetTrashRetentionDays(ctx, accountID)
	if err != nil {
		return nil, err
	}
	whiteboardDays, err := r.getWhiteboardTrashRetentionDays(ctx, accountID)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `SELECT environment.id,environment.name,environment.color,environment.icon,
		environment.deleted_at,environment.archived_at,environment.version,COALESCE(children.list_count,0),COALESCE(children.task_count,0),
		CASE WHEN $3::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END,
		GREATEST(environment.deleted_at,COALESCE(children.latest_deleted_at,environment.deleted_at)),
		contextual.latest_explicit_deleted_at
		FROM task_environments environment
		CROSS JOIN LATERAL (SELECT (`+environmentActorAccessRankSQL("environment", "$2")+`) AS environment_rank) actor_access
		LEFT JOIN LATERAL (
			SELECT COUNT(DISTINCT list_item.id) FILTER (WHERE (`+taskActorListAccessRankSQL("list_item", "$2")+`)>=1)::int AS list_count,
				COUNT(DISTINCT task.id) FILTER (WHERE task.id IS NOT NULL AND `+taskActorCanViewIncludingArchivedSQL("task", "list_item", "$2")+`)::int AS task_count,
				MAX(GREATEST(COALESCE(folder.deleted_at,environment.deleted_at),
					COALESCE(list_item.deleted_at,environment.deleted_at),COALESCE(task.deleted_at,environment.deleted_at))) AS latest_deleted_at
			FROM task_lists list_item
			LEFT JOIN task_folders folder ON folder.account_id=list_item.account_id AND folder.id=list_item.folder_id
			LEFT JOIN tasks task ON task.account_id=list_item.account_id AND task.list_id=list_item.id
			WHERE list_item.account_id=environment.account_id AND list_item.environment_id=environment.id
		) children ON TRUE
		LEFT JOIN LATERAL (
			SELECT COUNT(*) FILTER (WHERE $3::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`)::int AS whiteboard_count,
				MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $3::boolean AND `+taskTrashLocationViewCanViewSQL("location_view", "$2")+`) AS latest_explicit_deleted_at
			FROM task_location_views location_view
			JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id AND binding.task_view_id=location_view.id
			JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
			WHERE location_view.account_id=environment.account_id AND location_view.environment_id=environment.id
		) contextual ON TRUE
		WHERE environment.account_id=$1 AND environment.deleted_at IS NOT NULL AND NOT environment.is_default
		  AND `+taskActorAccountMembershipSQL("environment", "$2")+`
		  AND actor_access.environment_rank>=4
		ORDER BY environment.deleted_at DESC,environment.id`, accountID, actorID, includeWhiteboardCounts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskTrashContainer, 0)
	for rows.Next() {
		item := &domain.TaskTrashContainer{Type: "environment", Lifecycle: domain.TaskLifecycleTrash, CanRestore: true}
		var latest time.Time
		var explicitWhiteboardDeletedAt *time.Time
		if err := rows.Scan(&item.ID, &item.Name, &item.Color, &item.Icon, &item.DeletedAt, &item.ArchivedAt, &item.Version,
			&item.ListCount, &item.TaskCount, &item.WhiteboardCount, &latest, &explicitWhiteboardDeletedAt); err != nil {
			return nil, err
		}
		item.NextEligibleAt, item.CanPurge = taskContainerTrashEligibility(
			latest, days, whiteboardDays, explicitWhiteboardDeletedAt, now,
		)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *TaskWorkRepository) TrashEnvironment(ctx context.Context, accountID, actorID, environmentID uuid.UUID, expectedName string, expectedVersion int64) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var name string
	var isDefault bool
	var version int64
	if err := tx.QueryRow(ctx, `SELECT name,is_default,version FROM task_environments
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, environmentID).
		Scan(&name, &isDefault, &version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if isDefault {
		return nil, ErrTaskEnvironmentDefault
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
	}
	if expectedVersion != version {
		return nil, ErrTaskVersionConflict
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	folderIDs, listIDs, err := lockEnvironmentLifecycleDescendantsTx(
		ctx, tx, accountID, environmentID, taskEnvironmentLifecycleActive,
	)
	if err != nil {
		return nil, err
	}
	if err := requireEnvironmentDescendantAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderIDs, listIDs); err != nil {
		return nil, err
	}
	var retained int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM tasks task JOIN task_lists list_item
		ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND list_item.environment_id=$2 AND task.deleted_at IS NULL`, accountID, environmentID).Scan(&retained); err != nil {
		return nil, err
	}
	if retained > 0 {
		return nil, ErrTaskContainerNotEmpty
	}
	var retainedEvents int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM work_events event_item JOIN task_lists list_item
		ON list_item.account_id=event_item.account_id AND list_item.id=event_item.list_id
		WHERE event_item.account_id=$1 AND list_item.environment_id=$2 AND event_item.deleted_at IS NULL`, accountID, environmentID).Scan(&retainedEvents); err != nil {
		return nil, err
	}
	if retainedEvents > 0 {
		return nil, ErrTaskContainerHasWorkEvents
	}
	if err := revalidateEnvironmentLifecycleAuthorityTx(ctx, tx, accountID, actorID, environmentID, false, folderIDs, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_environments SET deleted_at=NOW(),deleted_by=$3,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, environmentID, actorID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET deleted_at=NOW(),deleted_by=$3,deleted_with_environment=TRUE,updated_at=NOW()
		WHERE account_id=$1 AND environment_id=$2 AND deleted_at IS NULL`, accountID, environmentID, actorID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NOW(),deleted_by=$3,deleted_with_environment=TRUE,updated_at=NOW()
		WHERE account_id=$1 AND environment_id=$2 AND deleted_at IS NULL`, accountID, environmentID, actorID); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, nil, nil, true)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

func (r *TaskWorkRepository) RestoreEnvironmentFromTrash(ctx context.Context, accountID, actorID, environmentID uuid.UUID, expectedVersion int64) ([]uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil); err != nil {
		return nil, err
	}
	var version int64
	if err := tx.QueryRow(ctx, `SELECT version FROM task_environments
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, environmentID).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if version != expectedVersion {
		return nil, ErrTaskVersionConflict
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, true); err != nil {
		return nil, err
	}
	folderIDs, listIDs, err := lockEnvironmentLifecycleDescendantsTx(
		ctx, tx, accountID, environmentID, taskEnvironmentLifecycleDeletedWithParent,
	)
	if err != nil {
		return nil, err
	}
	if err := requireEnvironmentDescendantAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderIDs, listIDs); err != nil {
		return nil, err
	}
	if err := revalidateEnvironmentLifecycleAuthorityTx(ctx, tx, accountID, actorID, environmentID, true, folderIDs, listIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_environments SET deleted_at=NULL,deleted_by=NULL,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL`, accountID, environmentID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_folders SET deleted_at=NULL,deleted_by=NULL,deleted_with_environment=FALSE,updated_at=NOW()
		WHERE account_id=$1 AND environment_id=$2 AND deleted_with_environment`, accountID, environmentID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_lists SET deleted_at=NULL,deleted_by=NULL,deleted_with_environment=FALSE,updated_at=NOW()
		WHERE account_id=$1 AND environment_id=$2 AND deleted_with_environment`, accountID, environmentID); err != nil {
		return nil, err
	}
	boardIDs, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(ctx, tx, accountID, environmentID, nil, nil, true)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

func lockTrashPolicy(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) (*int, error) {
	var days *int
	if err := tx.QueryRow(ctx, `SELECT task_trash_retention_days FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&days); err != nil {
		return nil, err
	}
	if days == nil {
		return nil, ErrTaskTrashDisabled
	}
	return days, nil
}

// lockTaskPurgeAccountTx establishes the authority-row lock before a purge
// takes the actor advisory/membership locks. Contextual whiteboard creation,
// duplication and board purge already use account -> actor; using the inverse
// order here would let a Work-container purge and either operation deadlock.
//
// This gate deliberately does not inspect either retention policy. The actor
// is authenticated and authorized next, and only then may callers surface a
// disabled-policy or eligibility result. A missing account remains a generic
// Work 404.
func lockTaskPurgeAccountTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	var lockedAccountID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&lockedAccountID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	return nil
}

func lockWhiteboardTrashPolicy(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) (*int, error) {
	var days *int
	if err := tx.QueryRow(ctx, `SELECT whiteboard_trash_retention_days FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(&days); err != nil {
		return nil, err
	}
	return days, nil
}

func trashNotEligible(next time.Time) error { return &TaskTrashEligibilityError{NextEligibleAt: &next} }

func lockWorkEventsForContainerPurge(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, listIDs []uuid.UUID, latest time.Time, retentionDays int, now time.Time) (time.Time, int, error) {
	if len(listIDs) == 0 {
		return latest, 0, nil
	}
	rows, err := tx.Query(ctx, `SELECT id,deleted_at FROM work_events
		WHERE account_id=$1 AND list_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, listIDs)
	if err != nil {
		return latest, 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id uuid.UUID
		var deletedAt *time.Time
		if err := rows.Scan(&id, &deletedAt); err != nil {
			return latest, count, err
		}
		if deletedAt == nil {
			return latest, count, ErrTaskContainerHasWorkEvents
		}
		count++
		if deletedAt.After(latest) {
			latest = *deletedAt
		}
	}
	if err := rows.Err(); err != nil {
		return latest, count, err
	}
	if latest.After(now.Add(-time.Duration(retentionDays) * 24 * time.Hour)) {
		return latest, count, trashNotEligible(latest.Add(time.Duration(retentionDays) * 24 * time.Hour))
	}
	return latest, count, nil
}

func enqueueTaskMediaForTasks(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, taskIDs []uuid.UUID) error {
	if len(taskIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key)
		SELECT DISTINCT candidates.account_id,candidates.media_asset_id,candidates.object_key FROM (
			SELECT attachment.account_id,asset.id AS media_asset_id,asset.object_key
			FROM task_attachments attachment JOIN media_assets asset ON asset.account_id=attachment.account_id AND asset.id=attachment.media_asset_id
			WHERE attachment.account_id=$1 AND attachment.task_id=ANY($2::uuid[])
			UNION ALL
			SELECT preview.account_id,asset.id AS media_asset_id,asset.object_key
			FROM task_attachment_previews preview JOIN media_assets asset ON asset.account_id=preview.account_id AND asset.id=preview.derivative_asset_id
			WHERE preview.account_id=$1 AND preview.task_id=ANY($2::uuid[])
		) candidates
		ON CONFLICT(account_id,media_asset_id) DO UPDATE SET status='pending',available_at=NOW(),claim_token=NULL,updated_at=NOW()`, accountID, taskIDs)
	return err
}

func (r *TaskWorkRepository) PurgeTask(ctx context.Context, accountID, actorID, taskID uuid.UUID, expectedTitle string, now time.Time) (*domain.TaskTrashPurgeResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockTaskPurgeAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if err := lockAndRequireTaskAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	days, err := lockTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	if err := lockAndRequireDeletedTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{taskID}, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	var title string
	var deletedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT title,deleted_at FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, taskID).Scan(&title, &deletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if expectedTitle != title {
		return nil, ErrTaskTrashConfirmation
	}
	cutoff := now.Add(-time.Duration(*days) * 24 * time.Hour)
	rows, err := tx.Query(ctx, `SELECT id,deleted_at FROM tasks WHERE account_id=$1 AND (id=$2 OR parent_task_id=$2) ORDER BY id FOR UPDATE`, accountID, taskID)
	if err != nil {
		return nil, err
	}
	ids := []uuid.UUID{}
	var latest time.Time
	for rows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := rows.Scan(&id, &at); err != nil {
			rows.Close()
			return nil, err
		}
		if at == nil {
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		ids = append(ids, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if latest.After(cutoff) {
		return nil, trashNotEligible(latest.Add(time.Duration(*days) * 24 * time.Hour))
	}
	if err := enqueueTaskMediaForTasks(ctx, tx, accountID, ids); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE account_id=$1 AND id=$2`, accountID, taskID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &domain.TaskTrashPurgeResult{Tasks: len(ids)}, nil
}

func (r *TaskWorkRepository) PurgeList(ctx context.Context, accountID, actorID, listID uuid.UUID, expectedName string, now time.Time, workWhiteboardViewsEnabled bool) (*domain.TaskTrashPurgeResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockTaskPurgeAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if err := lockAndRequireTaskAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	days, err := lockTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	whiteboardDays, err := lockWhiteboardTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	var name string
	var deletedAt time.Time
	var environmentID uuid.UUID
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT name,deleted_at,is_default,environment_id FROM task_lists WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, listID).Scan(&name, &deletedAt, &isDefault, &environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	if isDefault {
		return nil, ErrDefaultTaskList
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
	}
	latest := deletedAt
	rows, err := tx.Query(ctx, `SELECT id,deleted_at FROM tasks WHERE account_id=$1 AND list_id=$2 ORDER BY id FOR UPDATE`, accountID, listID)
	if err != nil {
		return nil, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := rows.Scan(&id, &at); err != nil {
			rows.Close()
			return nil, err
		}
		if at == nil {
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		ids = append(ids, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	latest, _, err = lockWorkEventsForContainerPurge(ctx, tx, accountID, []uuid.UUID{listID}, latest, *days, now)
	if err != nil {
		return nil, err
	}
	parentEligibleAt := latest.Add(time.Duration(*days) * 24 * time.Hour)
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, listID, domain.TaskAccessTargetList, nil); err != nil {
		return nil, err
	}
	whiteboards, err := lockTaskLocationWhiteboardsForPurge(
		ctx, tx, accountID, environmentID, nil, []uuid.UUID{listID}, false, parentEligibleAt, whiteboardDays,
		workWhiteboardViewsEnabled,
	)
	if err != nil {
		return nil, err
	}
	if whiteboards.EligibleAt.After(now) {
		return nil, trashNotEligible(whiteboards.EligibleAt)
	}
	if err := enqueueTaskMediaForTasks(ctx, tx, accountID, ids); err != nil {
		return nil, err
	}
	if err := deleteTaskLocationWhiteboardsForPurge(ctx, tx, accountID, whiteboards); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_saved_views WHERE account_id=$1 AND scope_type='list' AND scope_id=$2`, accountID, listID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE account_id=$1 AND list_id=$2`, accountID, listID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM work_events WHERE account_id=$1 AND list_id=$2`, accountID, listID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_lists WHERE account_id=$1 AND id=$2`, accountID, listID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &domain.TaskTrashPurgeResult{
		Tasks: len(ids), Lists: 1, Whiteboards: len(whiteboards.BoardIDs),
		WhiteboardIDs: append([]uuid.UUID(nil), whiteboards.BoardIDs...),
	}, nil
}

func (r *TaskWorkRepository) PurgeFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID, expectedName string, now time.Time, workWhiteboardViewsEnabled bool) (*domain.TaskTrashPurgeResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockTaskPurgeAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if err := lockAndRequireTaskAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	days, err := lockTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	whiteboardDays, err := lockWhiteboardTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	var name string
	var deletedAt time.Time
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT name,deleted_at,environment_id FROM task_folders WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, folderID).Scan(&name, &deletedAt, &environmentID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if err := requireContainerAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, false); err != nil {
		return nil, err
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
	}
	listRows, err := tx.Query(ctx, `SELECT id,deleted_at FROM task_lists WHERE account_id=$1 AND folder_id=$2 ORDER BY id FOR UPDATE`, accountID, folderID)
	if err != nil {
		return nil, err
	}
	listIDs := []uuid.UUID{}
	latest := deletedAt
	for listRows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := listRows.Scan(&id, &at); err != nil {
			listRows.Close()
			return nil, err
		}
		if at == nil {
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		listIDs = append(listIDs, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := listRows.Err(); err != nil {
		listRows.Close()
		return nil, err
	}
	listRows.Close()
	if err := requireFolderChildListAccessIncludingLifecycleTx(ctx, tx, accountID, actorID, listIDs, domain.TaskAccessFull); err != nil {
		return nil, err
	}
	taskRows, err := tx.Query(ctx, `SELECT id,deleted_at FROM tasks WHERE account_id=$1 AND list_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, listIDs)
	if err != nil {
		return nil, err
	}
	taskIDs := []uuid.UUID{}
	for taskRows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := taskRows.Scan(&id, &at); err != nil {
			taskRows.Close()
			return nil, err
		}
		if at == nil {
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		taskIDs = append(taskIDs, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, err
	}
	taskRows.Close()
	latest, _, err = lockWorkEventsForContainerPurge(ctx, tx, accountID, listIDs, latest, *days, now)
	if err != nil {
		return nil, err
	}
	parentEligibleAt := latest.Add(time.Duration(*days) * 24 * time.Hour)
	if err := revalidateContainerLifecycleAuthorityTx(ctx, tx, accountID, actorID, folderID, domain.TaskAccessTargetFolder, listIDs); err != nil {
		return nil, err
	}
	whiteboards, err := lockTaskLocationWhiteboardsForPurge(
		ctx, tx, accountID, environmentID, []uuid.UUID{folderID}, listIDs, false, parentEligibleAt, whiteboardDays,
		workWhiteboardViewsEnabled,
	)
	if err != nil {
		return nil, err
	}
	if whiteboards.EligibleAt.After(now) {
		return nil, trashNotEligible(whiteboards.EligibleAt)
	}
	if err := enqueueTaskMediaForTasks(ctx, tx, accountID, taskIDs); err != nil {
		return nil, err
	}
	if err := deleteTaskLocationWhiteboardsForPurge(ctx, tx, accountID, whiteboards); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_saved_views WHERE account_id=$1 AND ((scope_type='folder' AND scope_id=$2) OR (scope_type='list' AND scope_id=ANY($3::uuid[])))`, accountID, folderID, listIDs); err != nil {
		return nil, err
	}
	if len(listIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE account_id=$1 AND list_id=ANY($2::uuid[])`, accountID, listIDs); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM work_events WHERE account_id=$1 AND list_id=ANY($2::uuid[])`, accountID, listIDs); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM task_lists WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, listIDs); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_folders WHERE account_id=$1 AND id=$2`, accountID, folderID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &domain.TaskTrashPurgeResult{
		Tasks: len(taskIDs), Lists: len(listIDs), Folders: 1, Whiteboards: len(whiteboards.BoardIDs),
		WhiteboardIDs: append([]uuid.UUID(nil), whiteboards.BoardIDs...),
	}, nil
}

func (r *TaskWorkRepository) PurgeEnvironment(ctx context.Context, accountID, actorID, environmentID uuid.UUID, expectedName string, now time.Time, workWhiteboardViewsEnabled bool) (*domain.TaskTrashPurgeResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err := lockTaskPurgeAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if err := lockAndRequireTaskAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	days, err := lockTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	whiteboardDays, err := lockWhiteboardTrashPolicy(ctx, tx, accountID)
	if err != nil {
		return nil, err
	}
	var name string
	var deletedAt time.Time
	var isDefault bool
	if err := tx.QueryRow(ctx, `SELECT name,deleted_at,is_default FROM task_environments
		WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL FOR UPDATE`, accountID, environmentID).
		Scan(&name, &deletedAt, &isDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if isDefault {
		return nil, ErrTaskEnvironmentDefault
	}
	if expectedName != name {
		return nil, ErrTaskTrashConfirmation
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull, true); err != nil {
		return nil, err
	}
	latest := deletedAt
	folderRows, err := tx.Query(ctx, `SELECT id,deleted_at FROM task_folders
		WHERE account_id=$1 AND environment_id=$2 ORDER BY id FOR UPDATE`, accountID, environmentID)
	if err != nil {
		return nil, err
	}
	folderIDs := make([]uuid.UUID, 0)
	for folderRows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := folderRows.Scan(&id, &at); err != nil {
			folderRows.Close()
			return nil, err
		}
		if at == nil {
			folderRows.Close()
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		folderIDs = append(folderIDs, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := folderRows.Err(); err != nil {
		folderRows.Close()
		return nil, err
	}
	folderRows.Close()

	listRows, err := tx.Query(ctx, `SELECT id,deleted_at FROM task_lists
		WHERE account_id=$1 AND environment_id=$2 ORDER BY id FOR UPDATE`, accountID, environmentID)
	if err != nil {
		return nil, err
	}
	listIDs := make([]uuid.UUID, 0)
	for listRows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := listRows.Scan(&id, &at); err != nil {
			listRows.Close()
			return nil, err
		}
		if at == nil {
			listRows.Close()
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		listIDs = append(listIDs, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := listRows.Err(); err != nil {
		listRows.Close()
		return nil, err
	}
	listRows.Close()

	taskRows, err := tx.Query(ctx, `SELECT id,deleted_at FROM tasks
		WHERE account_id=$1 AND list_id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, listIDs)
	if err != nil {
		return nil, err
	}
	taskIDs := make([]uuid.UUID, 0)
	for taskRows.Next() {
		var id uuid.UUID
		var at *time.Time
		if err := taskRows.Scan(&id, &at); err != nil {
			taskRows.Close()
			return nil, err
		}
		if at == nil {
			taskRows.Close()
			return nil, trashNotEligible(now.Add(time.Duration(*days) * 24 * time.Hour))
		}
		taskIDs = append(taskIDs, id)
		if at.After(latest) {
			latest = *at
		}
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, err
	}
	taskRows.Close()
	latest, _, err = lockWorkEventsForContainerPurge(ctx, tx, accountID, listIDs, latest, *days, now)
	if err != nil {
		return nil, err
	}
	parentEligibleAt := latest.Add(time.Duration(*days) * 24 * time.Hour)
	if err := revalidateEnvironmentLifecycleAuthorityTx(ctx, tx, accountID, actorID, environmentID, true, folderIDs, listIDs); err != nil {
		return nil, err
	}
	whiteboards, err := lockTaskLocationWhiteboardsForPurge(
		ctx, tx, accountID, environmentID, folderIDs, listIDs, true, parentEligibleAt, whiteboardDays,
		workWhiteboardViewsEnabled,
	)
	if err != nil {
		return nil, err
	}
	if whiteboards.EligibleAt.After(now) {
		return nil, trashNotEligible(whiteboards.EligibleAt)
	}
	if err := enqueueTaskMediaForTasks(ctx, tx, accountID, taskIDs); err != nil {
		return nil, err
	}
	if err := deleteTaskLocationWhiteboardsForPurge(ctx, tx, accountID, whiteboards); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_saved_views WHERE account_id=$1 AND (
		(scope_type='environment' AND scope_id=$2) OR
		(scope_type='folder' AND scope_id=ANY($3::uuid[])) OR
		(scope_type='list' AND scope_id=ANY($4::uuid[])))`, accountID, environmentID, folderIDs, listIDs); err != nil {
		return nil, err
	}
	if len(taskIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM tasks WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, taskIDs); err != nil {
			return nil, err
		}
	}
	if len(listIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM work_events WHERE account_id=$1 AND list_id=ANY($2::uuid[])`, accountID, listIDs); err != nil {
			return nil, err
		}
	}
	if len(listIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM task_lists WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, listIDs); err != nil {
			return nil, err
		}
	}
	if len(folderIDs) > 0 {
		if _, err := tx.Exec(ctx, `DELETE FROM task_folders WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, folderIDs); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_workflows WHERE account_id=$1 AND environment_id=$2`, accountID, environmentID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_environments WHERE account_id=$1 AND id=$2`, accountID, environmentID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &domain.TaskTrashPurgeResult{
		Tasks: len(taskIDs), Lists: len(listIDs), Folders: len(folderIDs), Environments: 1,
		Whiteboards: len(whiteboards.BoardIDs), WhiteboardIDs: append([]uuid.UUID(nil), whiteboards.BoardIDs...),
	}, nil
}

func (r *TaskWorkRepository) ClaimTaskMediaGCJob(ctx context.Context) (*domain.TaskMediaGCJob, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	job := &domain.TaskMediaGCJob{ClaimToken: uuid.New()}
	err = tx.QueryRow(ctx, `SELECT id,account_id,media_asset_id,object_key FROM task_media_gc_jobs
		WHERE (status='pending' AND available_at<=NOW()) OR (status='processing' AND updated_at<NOW()-INTERVAL '10 minutes')
		ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(&job.ID, &job.AccountID, &job.MediaAssetID, &job.ObjectKey)
	if err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE task_media_gc_jobs SET status='processing',claim_token=$2,updated_at=NOW() WHERE id=$1`, job.ID, job.ClaimToken); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

func (r *TaskWorkRepository) PrepareTaskMediaGCDeletion(ctx context.Context, job *domain.TaskMediaGCJob) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var objectKey string
	if err := tx.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE`, job.AccountID, job.MediaAssetID).Scan(&objectKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, tx.Commit(ctx)
		}
		return false, err
	}
	if objectKey != job.ObjectKey {
		return false, nil
	}
	// Comment uploads remain hidden drafts until a comment transaction claims
	// them. Once their durable TTL expires, remove the draft reference under the
	// same media lock so the ordinary reference proof below can safely collect
	// the object. A published comment deletes this GC job transactionally.
	if _, err := tx.Exec(ctx, `DELETE FROM task_attachments
		WHERE account_id=$1 AND media_asset_id=$2 AND attachment_scope='comment_draft'
		  AND draft_expires_at<=NOW()`, job.AccountID, job.MediaAssetID); err != nil {
		return false, err
	}
	var nextDraftExpiry *time.Time
	if err := tx.QueryRow(ctx, `SELECT MIN(draft_expires_at) FROM task_attachments
		WHERE account_id=$1 AND media_asset_id=$2 AND attachment_scope='comment_draft'`, job.AccountID, job.MediaAssetID).
		Scan(&nextDraftExpiry); err != nil {
		return false, err
	}
	if nextDraftExpiry != nil {
		if _, err := tx.Exec(ctx, `UPDATE task_media_gc_jobs SET status='pending',claim_token=NULL,last_error='',
			available_at=$3,updated_at=NOW() WHERE id=$1 AND claim_token=$2`, job.ID, job.ClaimToken, *nextDraftExpiry); err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM task_attachments WHERE account_id=$1 AND media_asset_id=$2
		UNION ALL SELECT 1 FROM task_attachment_previews WHERE account_id=$1 AND derivative_asset_id=$2
		UNION ALL SELECT 1 FROM messages WHERE account_id=$1 AND media_asset_id=$2
		UNION ALL SELECT 1 FROM contacts WHERE account_id=$1 AND avatar_media_asset_id=$2
		UNION ALL SELECT 1 FROM whatsapp_statuses WHERE account_id=$1 AND media_asset_id=$2
		UNION ALL SELECT 1 FROM survey_file_uploads WHERE account_id=$1 AND media_asset_id=$2 AND status<>'deleted'
	)`, job.AccountID, job.MediaAssetID).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		return false, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='task_gc_deleting',updated_at=NOW() WHERE account_id=$1 AND id=$2`, job.AccountID, job.MediaAssetID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (r *TaskWorkRepository) CompleteTaskMediaGCJob(ctx context.Context, job *domain.TaskMediaGCJob, deleted bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// A later upload can reuse the account-scoped content hash after Prepare
	// has committed and reset this durable job to a new object key/claim. Lock
	// and verify the original claim before changing inventory so a stale worker
	// can never mark that newer reservation as deleted.
	var claimedObjectKey string
	if err := tx.QueryRow(ctx, `SELECT object_key FROM task_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND claim_token=$4 FOR UPDATE`,
		job.ID, job.AccountID, job.MediaAssetID, job.ClaimToken).Scan(&claimedObjectKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return tx.Commit(ctx)
		}
		return err
	}
	if claimedObjectKey != job.ObjectKey {
		return tx.Commit(ctx)
	}
	if deleted {
		if _, err = tx.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status='task_gc_deleting'`, job.AccountID, job.MediaAssetID, job.ObjectKey); err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, job.AccountID, job.ObjectKey); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM task_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND object_key=$4 AND claim_token=$5`,
		job.ID, job.AccountID, job.MediaAssetID, job.ObjectKey, job.ClaimToken); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) RetryTaskMediaGCJob(ctx context.Context, job *domain.TaskMediaGCJob, cause error) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE media_assets SET status='active',updated_at=NOW() WHERE account_id=$1 AND id=$2 AND status='task_gc_deleting'`, job.AccountID, job.MediaAssetID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE task_media_gc_jobs SET status='pending',claim_token=NULL,attempts=attempts+1,last_error=$3,available_at=NOW()+INTERVAL '15 minutes',updated_at=NOW() WHERE id=$1 AND claim_token=$2`, job.ID, job.ClaimToken, strings.TrimSpace(cause.Error())); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
