package repository

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const taskLocationVisibilityMemberLimit = 200

type TaskLocationViewVisibilityReplaceInput struct {
	VisibilityMode         string
	VisibleUserIDs         []uuid.UUID
	ExpectedAccessRevision int64
	OperationID            uuid.UUID
	RequestPayloadHash     string
}

func normalizeTaskLocationVisibility(mode string, userIDs []uuid.UUID) (string, []uuid.UUID, error) {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "" {
		mode = domain.TaskLocationViewVisibilityInherit
	}
	if mode != domain.TaskLocationViewVisibilityInherit && mode != domain.TaskLocationViewVisibilityRestricted {
		return "", nil, ErrTaskLocationViewInvalid
	}
	if len(userIDs) > taskLocationVisibilityMemberLimit {
		return "", nil, ErrTaskLocationViewInvalid
	}
	seen := make(map[uuid.UUID]struct{}, len(userIDs))
	normalized := make([]uuid.UUID, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID == uuid.Nil {
			return "", nil, ErrTaskLocationViewInvalid
		}
		if _, duplicate := seen[userID]; duplicate {
			return "", nil, ErrTaskLocationViewInvalid
		}
		seen[userID] = struct{}{}
		normalized = append(normalized, userID)
	}
	sort.Slice(normalized, func(i, j int) bool { return normalized[i].String() < normalized[j].String() })
	if mode == domain.TaskLocationViewVisibilityInherit {
		if len(normalized) != 0 {
			return "", nil, ErrTaskLocationViewInvalid
		}
		return mode, []uuid.UUID{}, nil
	}
	if len(normalized) == 0 {
		return "", nil, ErrTaskLocationViewInvalid
	}
	return mode, normalized, nil
}

func taskLocationParentAccessRevisionWith(ctx context.Context, q taskAccessQuerier, accountID, scopeID uuid.UUID, scopeType string) (int64, error) {
	query := `SELECT access_revision FROM task_folders WHERE account_id=$1 AND id=$2`
	if scopeType == domain.TaskAccessTargetList {
		query = `SELECT access_revision FROM task_lists WHERE account_id=$1 AND id=$2`
	} else if scopeType != domain.TaskAccessTargetFolder {
		return 0, ErrTaskLocationViewInvalid
	}
	var revision int64
	if err := q.QueryRow(ctx, query, accountID, scopeID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrTaskLocationViewParent
		}
		return 0, err
	}
	return revision, nil
}

func validateTaskLocationVisibilityMembersWith(ctx context.Context, q taskAccessQuerier, accountID, scopeID uuid.UUID, scopeType string, userIDs []uuid.UUID) error {
	for _, userID := range userIDs {
		allowed, err := actorCanUseTaskLocationViewsWith(ctx, q, accountID, userID)
		if err != nil {
			return err
		}
		if !allowed {
			return ErrTaskLocationViewInvalid
		}
		access, _, err := resolveContainerAccessWith(ctx, q, accountID, userID, scopeID, scopeType)
		if err != nil || access == nil || !access.CanView {
			return ErrTaskLocationViewInvalid
		}
	}
	return nil
}

func insertTaskLocationVisibilityMembersTx(ctx context.Context, tx pgx.Tx, accountID, viewID, actorID uuid.UUID, userIDs []uuid.UUID) error {
	for _, userID := range userIDs {
		if _, err := tx.Exec(ctx, `INSERT INTO task_location_view_visibility_members(
			account_id,task_view_id,user_id,created_by
		) VALUES($1,$2,$3,$4)`, accountID, viewID, userID, actorID); err != nil {
			return normalizeWhiteboardConstraintError(err)
		}
	}
	return nil
}

func (r *TaskLocationViewRepository) GetVisibilityPolicy(ctx context.Context, accountID, actorID, viewID uuid.UUID) (*domain.TaskLocationViewVisibilityPolicy, error) {
	item, err := r.getRaw(ctx, accountID, viewID)
	if err != nil {
		return nil, err
	}
	if item == nil || item.Resource.Whiteboard == nil || item.Scope == nil {
		return nil, ErrTaskLocationViewNotFound
	}
	access, _, err := NewWhiteboardRepository(r.db).ResolveWorkWhiteboardAccess(ctx, accountID, actorID,
		item.Resource.Whiteboard.ID, domain.WhiteboardAccessView, true)
	if err != nil {
		return nil, err
	}
	if !access.CanManageAccess {
		return nil, ErrTaskAccessDenied
	}
	policy := &domain.TaskLocationViewVisibilityPolicy{
		ViewID: viewID, VisibilityMode: item.VisibilityMode, AccessRevision: item.AccessRevision,
		EffectiveAccess: access, Members: []*domain.TaskLocationViewVisibilityMember{},
	}
	rows, err := r.db.Query(ctx, `SELECT visibility_member.user_id,
		COALESCE(NULLIF(account_user.display_name,''),account_user.username),account_user.username
		FROM task_location_view_visibility_members visibility_member
		JOIN user_accounts membership ON membership.account_id=visibility_member.account_id AND membership.user_id=visibility_member.user_id
		JOIN users account_user ON account_user.id=visibility_member.user_id
		WHERE visibility_member.account_id=$1 AND visibility_member.task_view_id=$2
		ORDER BY LOWER(COALESCE(NULLIF(account_user.display_name,''),account_user.username)),visibility_member.user_id`, accountID, viewID)
	if err != nil {
		return nil, err
	}
	type visibilityMemberIdentity struct {
		userID      uuid.UUID
		displayName string
		username    string
	}
	identities := make([]visibilityMemberIdentity, 0)
	for rows.Next() {
		identity := visibilityMemberIdentity{}
		if err := rows.Scan(&identity.userID, &identity.displayName, &identity.username); err != nil {
			rows.Close()
			return nil, err
		}
		identities = append(identities, identity)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, identity := range identities {
		member := &domain.TaskLocationViewVisibilityMember{
			UserID: identity.userID, DisplayName: identity.displayName, Username: identity.username,
		}
		modules, moduleErr := actorCanUseTaskLocationViewsWith(ctx, r.db, accountID, identity.userID)
		containerAccess, _, accessErr := resolveContainerAccessWith(ctx, r.db, accountID, identity.userID,
			item.Scope.ScopeID, item.Scope.ScopeType)
		member.Eligible = moduleErr == nil && accessErr == nil && modules && containerAccess != nil && containerAccess.CanView
		if member.Eligible {
			member.EffectiveAccessLevel = containerAccess.Level
		} else {
			member.EffectiveAccessLevel = domain.TaskAccessNone
		}
		policy.Members = append(policy.Members, member)
	}
	return policy, nil
}

func (r *TaskLocationViewRepository) ReplaceVisibility(ctx context.Context, accountID, actorID, viewID uuid.UUID, input TaskLocationViewVisibilityReplaceInput) (*domain.TaskLocationViewVisibilityPolicy, bool, error) {
	mode, userIDs, err := normalizeTaskLocationVisibility(input.VisibilityMode, input.VisibleUserIDs)
	if err != nil || accountID == uuid.Nil || actorID == uuid.Nil || viewID == uuid.Nil || input.ExpectedAccessRevision < 1 ||
		input.OperationID == uuid.Nil || len(input.RequestPayloadHash) != 64 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	if existing, found, findErr := r.FindOperation(ctx, accountID, actorID, input.OperationID, "replace_visibility", input.RequestPayloadHash); findErr != nil {
		return nil, false, findErr
	} else if found {
		if existing == nil || existing.ID != viewID {
			return nil, false, ErrTaskLocationViewConflict
		}
		policy, getErr := r.GetVisibilityPolicy(ctx, accountID, actorID, viewID)
		return policy, true, getErr
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, accountID); err != nil {
		return nil, false, ErrTaskLocationViewNotFound
	}
	if err := lockTaskLocationOperationTx(ctx, tx, accountID, actorID, input.OperationID); err != nil {
		return nil, false, err
	}
	if existingID, found, opErr := taskLocationViewOperationTx(ctx, tx, accountID, actorID,
		input.OperationID, "replace_visibility", input.RequestPayloadHash); opErr != nil {
		return nil, false, opErr
	} else if found {
		_ = tx.Rollback(ctx)
		if existingID != viewID {
			return nil, false, ErrTaskLocationViewConflict
		}
		policy, getErr := r.GetVisibilityPolicy(ctx, accountID, actorID, viewID)
		return policy, true, getErr
	}
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID, userIDs...); err != nil {
		return nil, false, err
	}
	initial, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, false)
	if err != nil || initial.DeletedAt != nil || initial.BoardArchivedAt != nil {
		if err == nil {
			err = ErrTaskLocationViewConflict
		}
		return nil, false, err
	}
	parentAccess, _, err := requireTaskLocationManageTx(ctx, tx, accountID, actorID, initial.ScopeID, initial.ScopeType)
	if err != nil {
		return nil, false, err
	}
	if parentAccess == nil || !parentAccess.CanManageAccess {
		return nil, false, ErrTaskAccessDenied
	}
	current, err := readTaskLocationViewMutationState(ctx, tx, accountID, viewID, true)
	if err != nil {
		return nil, false, err
	}
	if current.ScopeID != initial.ScopeID || current.ScopeType != initial.ScopeType || current.BoardID != initial.BoardID ||
		current.DeletedAt != nil || current.BoardArchivedAt != nil || current.AccessRevision != input.ExpectedAccessRevision {
		return nil, false, ErrTaskAccessRevisionConflict
	}
	if err := validateTaskLocationVisibilityMembersWith(ctx, tx, accountID, current.ScopeID, current.ScopeType, userIDs); err != nil {
		return nil, false, err
	}
	var beforeMembersJSON []byte
	if err := tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(user_id ORDER BY user_id),'[]'::jsonb)::text
		FROM task_location_view_visibility_members WHERE account_id=$1 AND task_view_id=$2`, accountID, viewID).Scan(&beforeMembersJSON); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_location_view_visibility_members WHERE account_id=$1 AND task_view_id=$2`, accountID, viewID); err != nil {
		return nil, false, err
	}
	if err := insertTaskLocationVisibilityMembersTx(ctx, tx, accountID, viewID, actorID, userIDs); err != nil {
		return nil, false, err
	}
	var nextRevision int64
	if err := tx.QueryRow(ctx, `UPDATE task_location_views SET visibility_mode=$3,
		access_revision=access_revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2
		RETURNING access_revision`, accountID, viewID, mode).Scan(&nextRevision); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET access_revision=access_revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, current.BoardID); err != nil {
		return nil, false, err
	}
	beforeState, _ := json.Marshal(map[string]any{
		"visibility_mode": current.VisibilityMode, "access_revision": current.AccessRevision,
		"visible_user_ids": json.RawMessage(beforeMembersJSON),
	})
	afterState, _ := json.Marshal(map[string]any{
		"visibility_mode": mode, "access_revision": nextRevision, "visible_user_ids": userIDs,
	})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,before_state,after_state,operation_id,request_payload_hash
	) VALUES($1,$2,$3,'work_visibility_replaced',$4::jsonb,$5::jsonb,$6,$7)`, accountID,
		current.BoardID, actorID, beforeState, afterState, input.OperationID, input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	activityDetails, _ := json.Marshal(map[string]any{
		"visibility_mode": mode, "access_revision": nextRevision, "member_count": len(userIDs),
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: accountID,
		BoardID: current.BoardID, ActorID: &actorID, Action: WhiteboardActivityAccessUpdated,
		Details: activityDetails, OperationID: &input.OperationID}); err != nil {
		return nil, false, err
	}
	if err := insertTaskLocationViewOperationTx(ctx, tx, accountID, actorID, input.OperationID,
		viewID, "replace_visibility", input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	policy, err := r.GetVisibilityPolicy(ctx, accountID, actorID, viewID)
	return policy, false, err
}

func (r *TaskLocationViewRepository) ListVisibilityCandidates(ctx context.Context, accountID, actorID, scopeID uuid.UUID, scopeType, query string, limit int) ([]*domain.TaskLocationViewVisibilityCandidate, error) {
	access, _, err := resolveContainerAccessWith(ctx, r.db, accountID, actorID, scopeID, scopeType)
	if err != nil {
		return nil, err
	}
	if access == nil || !access.CanManageAccess {
		if access == nil || !access.CanView {
			return nil, ErrTaskWorkNotFound
		}
		return nil, ErrTaskAccessDenied
	}
	if err := requireTaskLocationModulesWith(ctx, r.db, accountID, actorID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query = strings.TrimSpace(query)
	accessRankSQL := taskActorFolderAccessRankSQL("scope_item", "membership.user_id")
	fromSQL := `FROM task_folders scope_item`
	lifecycleSQL := `scope_item.archived_at IS NULL AND scope_item.deleted_at IS NULL
		AND EXISTS(SELECT 1 FROM task_environments active_environment
			WHERE active_environment.account_id=scope_item.account_id AND active_environment.id=scope_item.environment_id
			AND active_environment.archived_at IS NULL AND active_environment.deleted_at IS NULL)`
	if scopeType == domain.TaskAccessTargetList {
		accessRankSQL = taskActorListAccessRankSQL("scope_item", "membership.user_id")
		fromSQL = `FROM task_lists scope_item`
		lifecycleSQL = `scope_item.archived_at IS NULL AND scope_item.deleted_at IS NULL
			AND EXISTS(SELECT 1 FROM task_environments active_environment
				WHERE active_environment.account_id=scope_item.account_id AND active_environment.id=scope_item.environment_id
				AND active_environment.archived_at IS NULL AND active_environment.deleted_at IS NULL)
			AND (scope_item.folder_id IS NULL OR EXISTS(SELECT 1 FROM task_folders active_folder
				WHERE active_folder.account_id=scope_item.account_id AND active_folder.id=scope_item.folder_id
				AND active_folder.archived_at IS NULL AND active_folder.deleted_at IS NULL))`
	} else if scopeType != domain.TaskAccessTargetFolder {
		return nil, ErrTaskLocationViewInvalid
	}
	rows, err := r.db.Query(ctx, `SELECT membership.user_id,
		COALESCE(NULLIF(account_user.display_name,''),account_user.username),account_user.username,actor_access.access_rank
		`+fromSQL+`
		JOIN user_accounts membership ON membership.account_id=scope_item.account_id
		JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
		CROSS JOIN LATERAL (SELECT (`+accessRankSQL+`) AS access_rank) actor_access
		WHERE scope_item.account_id=$1 AND scope_item.id=$2 AND `+lifecycleSQL+`
		AND actor_access.access_rank>=1
		AND (COALESCE(account_user.is_super_admin,FALSE) OR membership.role IN ('admin','super_admin') OR (
			(COALESCE(role_item.permissions,'{}'::text[]) @> ARRAY['tasks']::text[] OR COALESCE(role_item.permissions,'{}'::text[]) @> ARRAY['*']::text[])
			AND (COALESCE(role_item.permissions,'{}'::text[]) @> ARRAY['whiteboards']::text[] OR COALESCE(role_item.permissions,'{}'::text[]) @> ARRAY['*']::text[])))
		AND ($3::text='' OR COALESCE(NULLIF(account_user.display_name,''),account_user.username) ILIKE '%'||$3::text||'%'
			OR account_user.username ILIKE '%'||$3::text||'%')
		ORDER BY LOWER(COALESCE(NULLIF(account_user.display_name,''),account_user.username)),membership.user_id
		LIMIT $4`, accountID, scopeID, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]*domain.TaskLocationViewVisibilityCandidate, 0)
	for rows.Next() {
		item := &domain.TaskLocationViewVisibilityCandidate{}
		var rank int
		if err := rows.Scan(&item.UserID, &item.DisplayName, &item.Username, &rank); err != nil {
			return nil, err
		}
		item.EffectiveAccessLevel = taskAccessLevelFromRank(rank)
		items = append(items, item)
	}
	return items, rows.Err()
}
