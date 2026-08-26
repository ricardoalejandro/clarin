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

func taskActorMembershipAllows(role string, permissions []string, active, globalSuperAdmin bool) bool {
	return active && (domain.HasAccountAdminAuthority(role, globalSuperAdmin) ||
		whiteboardPermissionSetAllows(permissions, domain.PermTasks))
}

// lockTaskActorAndMembershipsTx serializes one authenticated Work mutation
// with account-membership removal and authority changes. The actor and every
// membership whose FK may be inserted are locked together in canonical UUID
// order; locking the actor separately first would let inverse A->B and B->A
// mutations deadlock.
func lockTaskActorAndMembershipsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	relatedUserIDs []uuid.UUID,
) (map[uuid.UUID]struct{}, error) {
	if actorID == uuid.Nil {
		return nil, ErrTaskWorkNotFound
	}
	if err := lockUserAuthorityTx(ctx, tx, actorID); err != nil {
		return nil, err
	}
	userIDs := make([]uuid.UUID, 0, len(relatedUserIDs)+1)
	userIDs = append(userIDs, actorID)
	userIDs = append(userIDs, relatedUserIDs...)
	locked, err := lockAccountMembershipsKeyShareTx(ctx, tx, accountID, userIDs)
	if err != nil {
		return nil, err
	}
	if _, actorIsMember := locked[actorID]; !actorIsMember {
		return nil, ErrTaskWorkNotFound
	}

	var active, globalSuperAdmin bool
	var role string
	var permissions []string
	if err := tx.QueryRow(ctx, `SELECT account_user.is_active,
		COALESCE(account_user.is_super_admin,FALSE),membership.role,
		COALESCE(role_item.permissions,'{}'::text[])
		FROM user_accounts membership
		JOIN users account_user ON account_user.id=membership.user_id
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
		WHERE membership.account_id=$1 AND membership.user_id=$2`, accountID, actorID).
		Scan(&active, &globalSuperAdmin, &role, &permissions); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	if !taskActorMembershipAllows(role, permissions, active, globalSuperAdmin) {
		return nil, ErrTaskWorkNotFound
	}
	return locked, nil
}

// lockTaskParticipantMembershipsTx is the mandatory first lock for a task
// mutation that may insert or strengthen participant grants. Membership
// removal locks user_accounts before the affected task rows, so callers must
// invoke this helper before taking any task/list/environment lock and then
// revalidate all resource state under their normal optimistic transaction.
func lockTaskParticipantMembershipsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, actorID uuid.UUID,
	participantIDs []uuid.UUID,
) (map[uuid.UUID]struct{}, error) {
	return lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, participantIDs)
}

func taskParticipantMembershipsLocked(locked map[uuid.UUID]struct{}, participantIDs []uuid.UUID) bool {
	canonical := canonicalAccountMembershipUserIDs(participantIDs)
	for _, participantID := range canonical {
		if _, ok := locked[participantID]; !ok {
			return false
		}
	}
	return len(canonical) == len(participantIDs)
}

func taskParticipantIDSetsEqual(left, right []uuid.UUID) bool {
	canonicalLeft := canonicalAccountMembershipUserIDs(left)
	canonicalRight := canonicalAccountMembershipUserIDs(right)
	if len(canonicalLeft) != len(canonicalRight) {
		return false
	}
	for index := range canonicalLeft {
		if canonicalLeft[index] != canonicalRight[index] {
			return false
		}
	}
	return true
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
		JOIN task_environments environment ON environment.account_id=membership.account_id AND environment.id=$3 AND environment.archived_at IS NULL AND environment.deleted_at IS NULL
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
