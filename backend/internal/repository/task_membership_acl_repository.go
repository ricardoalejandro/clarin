package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// removeTaskMembershipACLTx records and removes all explicit Work grants for
// one account membership. It refuses a removal that would leave a private
// environment, folder, list or private task without an explicit access manager.
func removeTaskMembershipACLTx(ctx context.Context, tx pgx.Tx, accountID, userID uuid.UUID, actorID *uuid.UUID) error {
	var membershipID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM user_accounts WHERE account_id=$1 AND user_id=$2 FOR UPDATE`, accountID, userID).Scan(&membershipID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		return err
	}

	// Serialize membership removal with ACL replacement and with another
	// manager removal. Task roots are locked before environments, matching the
	// canonical task-mutation order, so two concurrent removals cannot each see
	// the other manager and leave a private resource without one.
	taskRows, err := tx.Query(ctx, `SELECT task.id FROM tasks task
		WHERE task.account_id=$1 AND task.parent_task_id IS NULL
		  AND task.id IN (SELECT grant_item.task_id FROM task_access_grants grant_item
			WHERE grant_item.account_id=$1 AND grant_item.user_id=$2)
		ORDER BY task.id FOR UPDATE`, accountID, userID)
	if err != nil {
		return err
	}
	for taskRows.Next() {
		var taskID uuid.UUID
		if err := taskRows.Scan(&taskID); err != nil {
			taskRows.Close()
			return err
		}
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return err
	}
	taskRows.Close()

	listRows, err := tx.Query(ctx, `SELECT list_item.id FROM task_lists list_item
		WHERE list_item.account_id=$1
		  AND list_item.id IN (SELECT grant_item.list_id FROM task_list_access_grants grant_item
			WHERE grant_item.account_id=$1 AND grant_item.user_id=$2)
		ORDER BY list_item.id FOR UPDATE`, accountID, userID)
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

	folderRows, err := tx.Query(ctx, `SELECT folder.id FROM task_folders folder
		WHERE folder.account_id=$1
		  AND folder.id IN (SELECT grant_item.folder_id FROM task_folder_access_grants grant_item
			WHERE grant_item.account_id=$1 AND grant_item.user_id=$2)
		ORDER BY folder.id FOR UPDATE`, accountID, userID)
	if err != nil {
		return err
	}
	for folderRows.Next() {
		var folderID uuid.UUID
		if err := folderRows.Scan(&folderID); err != nil {
			folderRows.Close()
			return err
		}
	}
	if err := folderRows.Err(); err != nil {
		folderRows.Close()
		return err
	}
	folderRows.Close()

	environmentRows, err := tx.Query(ctx, `SELECT environment.id FROM task_environments environment
		WHERE environment.account_id=$1
		  AND environment.id IN (SELECT grant_item.environment_id FROM task_environment_grants grant_item
			WHERE grant_item.account_id=$1 AND grant_item.user_id=$2)
		ORDER BY environment.id FOR UPDATE`, accountID, userID)
	if err != nil {
		return err
	}
	for environmentRows.Next() {
		var environmentID uuid.UUID
		if err := environmentRows.Scan(&environmentID); err != nil {
			environmentRows.Close()
			return err
		}
	}
	if err := environmentRows.Err(); err != nil {
		environmentRows.Close()
		return err
	}
	environmentRows.Close()

	var leavesPrivateManagerless bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM task_environment_grants removed
		JOIN task_environments environment ON environment.account_id=removed.account_id AND environment.id=removed.environment_id
		WHERE removed.account_id=$1 AND removed.user_id=$2 AND removed.access_level='full' AND removed.can_manage_access
		  AND environment.visibility='restricted'
		  AND NOT EXISTS(SELECT 1 FROM task_environment_grants other WHERE other.account_id=removed.account_id
			AND other.environment_id=removed.environment_id AND other.user_id<>removed.user_id
			AND other.access_level='full' AND other.can_manage_access)
		UNION ALL
		SELECT 1 FROM task_folder_access_grants removed
		JOIN task_folders folder ON folder.account_id=removed.account_id AND folder.id=removed.folder_id
		WHERE removed.account_id=$1 AND removed.user_id=$2 AND removed.access_level='full' AND removed.can_manage_access
		  AND folder.access_mode='private'
		  AND NOT EXISTS(SELECT 1 FROM task_folder_access_grants other WHERE other.account_id=removed.account_id
			AND other.folder_id=removed.folder_id AND other.user_id<>removed.user_id
			AND other.access_level='full' AND other.can_manage_access)
		UNION ALL
		SELECT 1 FROM task_list_access_grants removed
		JOIN task_lists list_item ON list_item.account_id=removed.account_id AND list_item.id=removed.list_id
		WHERE removed.account_id=$1 AND removed.user_id=$2 AND removed.access_level='full' AND removed.can_manage_access
		  AND list_item.access_mode='private'
		  AND NOT EXISTS(SELECT 1 FROM task_list_access_grants other WHERE other.account_id=removed.account_id
			AND other.list_id=removed.list_id AND other.user_id<>removed.user_id
			AND other.access_level='full' AND other.can_manage_access)
		UNION ALL
		SELECT 1 FROM task_access_grants removed
		JOIN tasks task ON task.account_id=removed.account_id AND task.id=removed.task_id
		WHERE removed.account_id=$1 AND removed.user_id=$2 AND removed.access_level='full' AND removed.can_manage_access
		  AND task.parent_task_id IS NULL AND task.access_mode='private'
		  AND NOT EXISTS(SELECT 1 FROM task_access_grants other WHERE other.account_id=removed.account_id
			AND other.task_id=removed.task_id AND other.user_id<>removed.user_id
			AND other.access_level='full' AND other.can_manage_access)
	)`, accountID, userID).Scan(&leavesPrivateManagerless); err != nil {
		return err
	}
	if leavesPrivateManagerless {
		return ErrTaskLastAccessManager
	}

	operationID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		SELECT grant_item.account_id,$3,'environment',grant_item.environment_id,'membership_grant_removed',
			jsonb_build_object('user_id',grant_item.user_id,'access_level',grant_item.access_level,'can_manage_access',grant_item.can_manage_access),
			'{}'::jsonb,$4
		FROM task_environment_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2`, accountID, userID, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		SELECT grant_item.account_id,$3,'folder',grant_item.folder_id,'membership_grant_removed',
			jsonb_build_object('user_id',grant_item.user_id,'access_level',grant_item.access_level,'can_manage_access',grant_item.can_manage_access),
			'{}'::jsonb,$4
		FROM task_folder_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2`, accountID, userID, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		SELECT grant_item.account_id,$3,'list',grant_item.list_id,'membership_grant_removed',
			jsonb_build_object('user_id',grant_item.user_id,'access_level',grant_item.access_level,'can_manage_access',grant_item.can_manage_access),
			'{}'::jsonb,$4
		FROM task_list_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2`, accountID, userID, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		SELECT grant_item.account_id,$3,'task',grant_item.task_id,'membership_grant_removed',
			jsonb_build_object('user_id',grant_item.user_id,'access_level',grant_item.access_level,'can_manage_access',grant_item.can_manage_access),
			'{}'::jsonb,$4
		FROM task_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2`, accountID, userID, actorID, operationID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH affected AS (
		SELECT environment_id FROM task_environment_grants WHERE account_id=$1 AND user_id=$2
	) UPDATE task_environments environment SET access_revision=access_revision+1,updated_at=NOW()
	FROM affected WHERE environment.account_id=$1 AND environment.id=affected.environment_id`, accountID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH affected AS (
		SELECT folder_id FROM task_folder_access_grants WHERE account_id=$1 AND user_id=$2
	) UPDATE task_folders folder SET access_revision=access_revision+1,updated_at=NOW()
	FROM affected WHERE folder.account_id=$1 AND folder.id=affected.folder_id`, accountID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH affected AS (
		SELECT list_id FROM task_list_access_grants WHERE account_id=$1 AND user_id=$2
	) UPDATE task_lists list_item SET access_revision=access_revision+1,updated_at=NOW()
	FROM affected WHERE list_item.account_id=$1 AND list_item.id=affected.list_id`, accountID, userID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `WITH affected AS (
		SELECT task_id FROM task_access_grants WHERE account_id=$1 AND user_id=$2
	) UPDATE tasks task SET access_revision=COALESCE(access_revision,1)+1,updated_at=NOW()
	FROM affected WHERE task.account_id=$1 AND task.id=affected.task_id AND task.parent_task_id IS NULL`, accountID, userID); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `DELETE FROM user_accounts WHERE account_id=$1 AND user_id=$2`, accountID, userID)
	return err
}
