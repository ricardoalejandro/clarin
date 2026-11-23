package repository

import (
	"context"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func taskRemovalTargetTable(kind string) string {
	switch kind {
	case "environment":
		return "task_environments"
	case "folder":
		return "task_folders"
	default:
		return "task_lists"
	}
}

// All Work writers take this barrier before their first hierarchy/task/view row
// lock. Lifecycle operations take exclusive directly; never upgrade shared.
// Sorted keys also serialize cross-Entorno task moves without lock inversion.
func lockWorkEnvironmentBarrierTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, environmentIDs []uuid.UUID, exclusive bool) error {
	ids := canonicalWorkEnvironmentIDs(environmentIDs)
	function := "pg_advisory_xact_lock_shared"
	if exclusive {
		function = "pg_advisory_xact_lock"
	}
	for _, id := range ids {
		if _, err := tx.Exec(ctx, `SELECT `+function+`(hashtextextended('clarin:work-environment:'||$1::text||':'||$2::text,0))`, accountID, id); err != nil {
			return err
		}
	}
	return nil
}

func canonicalWorkEnvironmentIDs(input []uuid.UUID) []uuid.UUID {
	ids := make([]uuid.UUID, 0, len(input))
	seen := map[uuid.UUID]bool{}
	for _, id := range input {
		if id != uuid.Nil && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })
	return ids
}

// Resource discovery deliberately takes no row locks. Callers must re-read
// location/lifecycle/version after waiting, using their existing canonical checks.
func lockWorkResourceEnvironmentBarrierTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, kind string, ids []uuid.UUID, exclusive bool) error {
	if err := lockTaskContainerAccountReferenceTx(ctx, tx, accountID); err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	query := `SELECT DISTINCT environment_id FROM task_lists WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY environment_id`
	switch kind {
	case "environment":
		return lockWorkEnvironmentBarrierTx(ctx, tx, accountID, ids, exclusive)
	case "folder":
		query = `SELECT DISTINCT environment_id FROM task_folders WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY environment_id`
	case "task":
		query = `SELECT DISTINCT item.environment_id FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id WHERE task.account_id=$1 AND task.id=ANY($2::uuid[]) ORDER BY item.environment_id`
	case "event":
		query = `SELECT DISTINCT item.environment_id FROM work_events event JOIN task_lists item ON item.account_id=event.account_id AND item.id=event.list_id WHERE event.account_id=$1 AND event.id=ANY($2::uuid[]) ORDER BY item.environment_id`
	case "workflow":
		query = `SELECT DISTINCT environment_id FROM task_workflows WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY environment_id`
	case "status":
		query = `SELECT DISTINCT workflow.environment_id FROM task_statuses status JOIN task_workflows workflow ON workflow.account_id=status.account_id AND workflow.id=status.workflow_id WHERE status.account_id=$1 AND status.id=ANY($2::uuid[]) ORDER BY workflow.environment_id`
	case "view":
		query = `SELECT DISTINCT environment_id FROM task_location_views WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY environment_id`
	}
	rows, err := tx.Query(ctx, query, accountID, ids)
	if err != nil {
		return err
	}
	environments := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		environments = append(environments, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if err := lockWorkEnvironmentBarrierTx(ctx, tx, accountID, environments, exclusive); err != nil {
		return err
	}
	rows, err = tx.Query(ctx, query, accountID, ids)
	if err != nil {
		return err
	}
	current := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		current = append(current, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	before, after := canonicalWorkEnvironmentIDs(environments), canonicalWorkEnvironmentIDs(current)
	if len(before) != len(after) {
		return ErrTaskVersionConflict
	}
	for i := range before {
		if before[i] != after[i] {
			return ErrTaskVersionConflict
		}
	}
	return nil
}

func lockTaskRemovalEnvironmentBarrierTx(ctx context.Context, tx pgx.Tx, accountID, targetID uuid.UUID, kind string, req domain.TaskContainerRemovalRequest) error {
	// Destinations are restricted to the same Entorno, so the source key is
	// sufficient; the complete destination relationship is revalidated later.
	return lockWorkResourceEnvironmentBarrierTx(ctx, tx, accountID, kind, []uuid.UUID{targetID}, kind == "environment")
}

func lockEnvironmentRemovalParentsTx(ctx context.Context, tx pgx.Tx, accountID, actorID, environmentID uuid.UUID) error {
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM task_environments WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE`, accountID, environmentID).Scan(&id); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if err := requireEnvironmentAccessIncludingArchiveTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessView, false); err != nil {
		return err
	}
	_, _, err := lockEnvironmentLifecycleDescendantsTx(ctx, tx, accountID, environmentID, taskEnvironmentLifecycleRetained)
	return err
}

func environmentViewerUserIDsWith(ctx context.Context, q taskAccessQuerier, accountID, environmentID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := q.Query(ctx, `SELECT membership.user_id FROM task_environments environment JOIN user_accounts membership ON membership.account_id=environment.account_id WHERE environment.account_id=$1 AND environment.id=$2 AND (`+environmentActorAccessRankSQL("environment", "membership.user_id")+`)>=1 ORDER BY membership.user_id`, accountID, environmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

func trashEnvironmentRemovalDescendantsTx(ctx context.Context, tx pgx.Tx, accountID, actorID, environmentID, operationID uuid.UUID) error {
	for _, item := range []struct{ table, kind string }{{"task_folders", "folder"}, {"task_lists", "list"}} {
		if err := recordTaskRemovalRowsTx(ctx, tx, accountID, operationID, item.table, item.kind, `item.environment_id=$4 AND item.deleted_at IS NULL`, environmentID); err != nil {
			return err
		}
		// The local pinned Inbox is owned by this non-General parent. Its
		// individual-delete guard remains intact in every standalone route.
		if _, err := tx.Exec(ctx, `UPDATE `+item.table+` SET deleted_at=NOW(),deleted_by=$3,trash_operation_id=$4,deleted_with_environment=TRUE,updated_at=NOW() WHERE account_id=$1 AND environment_id=$2 AND deleted_at IS NULL`, accountID, environmentID, actorID, operationID); err != nil {
			return err
		}
	}
	return nil
}

func restoreEnvironmentRemovalFoldersTx(ctx context.Context, tx pgx.Tx, accountID, actorID, operationID uuid.UUID) error {
	var hidden, forbidden int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FILTER(WHERE (`+taskActorFolderAccessRankSQL("item", "$3")+`)<1),COUNT(*) FILTER(WHERE (`+taskActorFolderAccessRankSQL("item", "$3")+`)<4) FROM task_folders item WHERE item.account_id=$1 AND item.trash_operation_id=$2`, accountID, operationID, actorID).Scan(&hidden, &forbidden); err != nil {
		return err
	}
	if hidden > 0 {
		return ErrTaskWorkNotFound
	}
	if forbidden > 0 {
		return ErrTaskAccessDenied
	}
	_, err := tx.Exec(ctx, `UPDATE task_folders item SET deleted_at=NULL,deleted_by=NULL,
        deleted_with_environment=COALESCE((provenance.previous_state->>'deleted_with_environment')::boolean,FALSE),
        trash_operation_id=(provenance.previous_state->>'trash_operation_id')::uuid,updated_at=NOW()
        FROM task_container_removal_items provenance WHERE item.account_id=$1 AND item.trash_operation_id=$2
        AND provenance.account_id=item.account_id AND provenance.operation_id=$2 AND provenance.resource_type='folder' AND provenance.resource_id=item.id`, accountID, operationID)
	return err
}

// Only legacy tasks without a real list use this account-wide order namespace.
func lockLegacyTaskOrderTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('clarin:legacy-task-order:'||$1::text,0))`, accountID)
	return err
}

func requireActiveWorkflowEnvironmentTx(ctx context.Context, tx pgx.Tx, accountID, workflowID uuid.UUID) error {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT environment.id FROM task_workflows workflow JOIN task_environments environment ON environment.account_id=workflow.account_id AND environment.id=workflow.environment_id WHERE workflow.account_id=$1 AND workflow.id=$2 AND environment.archived_at IS NULL AND environment.deleted_at IS NULL`, accountID, workflowID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	return err
}

func requireActiveWorkEnvironmentTx(ctx context.Context, tx pgx.Tx, accountID, environmentID uuid.UUID) error {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM task_environments WHERE account_id=$1 AND id=$2 AND archived_at IS NULL AND deleted_at IS NULL FOR SHARE`, accountID, environmentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	return err
}
func requireActiveWorkTaskTx(ctx context.Context, tx pgx.Tx, accountID, taskID uuid.UUID) error {
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT task.id FROM tasks task JOIN task_lists item ON item.account_id=task.account_id AND item.id=task.list_id JOIN task_environments environment ON environment.account_id=item.account_id AND environment.id=item.environment_id LEFT JOIN task_folders folder ON folder.account_id=item.account_id AND folder.id=item.folder_id WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NULL AND item.deleted_at IS NULL AND item.archived_at IS NULL AND environment.deleted_at IS NULL AND environment.archived_at IS NULL AND (folder.id IS NULL OR (folder.deleted_at IS NULL AND folder.archived_at IS NULL)) FOR SHARE OF task,item,environment`, accountID, taskID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	return err
}
