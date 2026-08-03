package repository

import (
	"context"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// lockAndRequireTaskAccessTx closes the authorization race for mutations that
// affect more than one task. Canonical root rows are locked first (the same
// rows used by task-level ACL replacement), requested child/root rows follow,
// then their environments are share-locked so neither task nor environment
// grants can change between authorization and commit.
func lockAndRequireTaskAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, taskIDs []uuid.UUID, required string) error {
	return lockAndRequireTaskAccessStateTx(ctx, tx, accountID, actorID, taskIDs, required, false)
}

func lockAndRequireDeletedTaskAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, taskIDs []uuid.UUID, required string) error {
	return lockAndRequireTaskAccessStateTx(ctx, tx, accountID, actorID, taskIDs, required, true)
}

func lockAndRequireTaskAccessStateTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID, taskIDs []uuid.UUID, required string, includeDeleted bool) error {
	unique := make(map[uuid.UUID]struct{}, len(taskIDs))
	ids := make([]uuid.UUID, 0, len(taskIDs))
	for _, id := range taskIDs {
		if id == uuid.Nil {
			return ErrTaskWorkNotFound
		}
		if _, exists := unique[id]; exists {
			continue
		}
		unique[id] = struct{}{}
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		return ErrTaskWorkNotFound
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i].String() < ids[j].String() })

	deletedPredicate := " AND task.deleted_at IS NULL"
	if includeDeleted {
		deletedPredicate = ""
	}
	rows, err := tx.Query(ctx, `SELECT task.id,root.id,list_item.environment_id
		FROM tasks task
		JOIN tasks root ON root.account_id=task.account_id AND root.id=COALESCE(task.parent_task_id,task.id)
		JOIN task_lists list_item ON list_item.account_id=root.account_id AND list_item.id=root.list_id
		WHERE task.account_id=$1 AND task.id=ANY($2::uuid[])`+deletedPredicate+`
		ORDER BY root.id,task.id FOR UPDATE OF root,task`, accountID, ids)
	if err != nil {
		return err
	}
	found := make(map[uuid.UUID]struct{}, len(ids))
	environmentSet := make(map[uuid.UUID]struct{})
	for rows.Next() {
		var taskID, rootID, environmentID uuid.UUID
		if err := rows.Scan(&taskID, &rootID, &environmentID); err != nil {
			rows.Close()
			return err
		}
		found[taskID] = struct{}{}
		environmentSet[environmentID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if len(found) != len(ids) {
		return ErrTaskWorkNotFound
	}

	environmentIDs := make([]uuid.UUID, 0, len(environmentSet))
	for id := range environmentSet {
		environmentIDs = append(environmentIDs, id)
	}
	sort.Slice(environmentIDs, func(i, j int) bool { return environmentIDs[i].String() < environmentIDs[j].String() })
	environmentRows, err := tx.Query(ctx, `SELECT id FROM task_environments
		WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`, accountID, environmentIDs)
	if err != nil {
		return err
	}
	lockedEnvironments := 0
	for environmentRows.Next() {
		var environmentID uuid.UUID
		if err := environmentRows.Scan(&environmentID); err != nil {
			environmentRows.Close()
			return err
		}
		lockedEnvironments++
	}
	if err := environmentRows.Err(); err != nil {
		environmentRows.Close()
		return err
	}
	environmentRows.Close()
	if lockedEnvironments != len(environmentIDs) {
		return ErrTaskWorkNotFound
	}

	for _, taskID := range ids {
		resolved, err := resolveTaskAccessWithState(ctx, tx, accountID, actorID, taskID, includeDeleted)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskWorkNotFound
			}
			return err
		}
		if !TaskAccessAllows(resolved.Access, required) {
			if resolved.Access == nil || !resolved.Access.CanView {
				return ErrTaskWorkNotFound
			}
			return ErrTaskAccessDenied
		}
	}
	return nil
}

func lockAndRequireActiveEnvironmentAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, environmentID uuid.UUID, required string) error {
	var active bool
	if err := tx.QueryRow(ctx, `SELECT archived_at IS NULL FROM task_environments
		WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, environmentID).Scan(&active); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		return err
	}
	if !active {
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

func lockAndRequireTaskAccountAdminTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID) error {
	var admin bool
	err := tx.QueryRow(ctx, `SELECT membership.role IN ('admin','super_admin')
			OR COALESCE(account_user.is_admin,FALSE) OR COALESCE(account_user.is_super_admin,FALSE)
		FROM user_accounts membership
		JOIN users account_user ON account_user.id=membership.user_id
		WHERE membership.account_id=$1 AND membership.user_id=$2
		FOR SHARE OF membership,account_user`, accountID, actorID).Scan(&admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if !admin {
		return ErrTaskAccessDenied
	}
	return nil
}
