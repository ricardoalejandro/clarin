package repository

import (
	"context"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type TaskParticipantAccessConfirmationError struct {
	AffectedUserIDs []uuid.UUID
}

func (e *TaskParticipantAccessConfirmationError) Error() string {
	return "task participants require explicit access confirmation"
}

func canonicalTaskParticipantIDs(ownerID uuid.UUID, collaboratorIDs []uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{}, len(collaboratorIDs)+1)
	items := make([]uuid.UUID, 0, len(collaboratorIDs)+1)
	for _, id := range append([]uuid.UUID{ownerID}, collaboratorIDs...) {
		if id == uuid.Nil {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		items = append(items, id)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].String() < items[j].String() })
	return items
}

func taskParticipantsNeedingGrant(ctx context.Context, q taskAccessQuerier, accountID, environmentID uuid.UUID, rootTaskID *uuid.UUID, participantIDs []uuid.UUID) ([]uuid.UUID, error) {
	affected := make([]uuid.UUID, 0)
	for _, participantID := range participantIDs {
		var access *domain.TaskEffectiveAccess
		var err error
		if rootTaskID != nil {
			resolved, resolveErr := resolveTaskAccessWith(ctx, q, accountID, participantID, *rootTaskID)
			err = resolveErr
			if resolved != nil {
				access = resolved.Access
			}
		} else {
			access, _, err = resolveEnvironmentAccessWith(ctx, q, accountID, participantID, environmentID)
		}
		if err != nil {
			return nil, err
		}
		if access == nil || !access.CanEdit {
			affected = append(affected, participantID)
		}
	}
	return affected, nil
}

func confirmTaskParticipantGrants(ctx context.Context, tx pgx.Tx, accountID, rootTaskID, actorID uuid.UUID, affected []uuid.UUID, operationID *uuid.UUID) error {
	if len(affected) == 0 {
		return nil
	}
	var accessMode string
	var environmentID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT COALESCE(task.access_mode,'inherit'),list_item.environment_id
		FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND task.id=$2 AND task.parent_task_id IS NULL`, accountID, rootTaskID).Scan(&accessMode, &environmentID); err != nil {
		return err
	}
	// A task-level grant can refine access only inside an Entorno the recipient
	// can already see. Participant confirmation must not become a bypass around
	// that collaboration boundary.
	var environmentViewerCount int
	if err := tx.QueryRow(ctx, `SELECT COUNT(*)
		FROM user_accounts membership
		JOIN task_environments environment ON environment.account_id=membership.account_id AND environment.id=$3 AND environment.archived_at IS NULL
		WHERE membership.account_id=$1 AND membership.user_id=ANY($2::uuid[])
		  AND (`+environmentActorAccessRankSQL("environment", "membership.user_id")+`) >= 1`, accountID, affected, environmentID).Scan(&environmentViewerCount); err != nil {
		return err
	}
	if environmentViewerCount != len(affected) {
		return ErrTaskAccessInvalid
	}
	beforeState, err := accessStateJSON(ctx, tx, accountID, "task_access_grants", "task_id", rootTaskID, accessMode)
	if err != nil {
		return err
	}
	for _, userID := range affected {
		if _, err := tx.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,can_manage_access,created_by)
			VALUES($1,$2,$3,'edit',FALSE,$4)
			ON CONFLICT(account_id,task_id,user_id) DO UPDATE SET
				access_level=CASE WHEN task_access_grants.access_level='full' THEN 'full' ELSE 'edit' END,
				can_manage_access=CASE WHEN task_access_grants.access_level='full' THEN task_access_grants.can_manage_access ELSE FALSE END,
				updated_at=NOW()`, accountID, rootTaskID, userID, actorID); err != nil {
			return err
		}
	}
	var revision int64
	if err := tx.QueryRow(ctx, `UPDATE tasks SET access_revision=COALESCE(access_revision,1)+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND parent_task_id IS NULL RETURNING access_revision`, accountID, rootTaskID).Scan(&revision); err != nil {
		return err
	}
	afterState, err := accessStateJSON(ctx, tx, accountID, "task_access_grants", "task_id", rootTaskID, accessMode)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_access_audit(account_id,actor_id,target_type,target_id,action,before_state,after_state,operation_id)
		VALUES($1,$2,'task',$3,'participant_grants_confirmed',$4::jsonb,$5::jsonb,$6)`, accountID, actorID, rootTaskID,
		beforeState, afterState, operationID)
	return err
}
