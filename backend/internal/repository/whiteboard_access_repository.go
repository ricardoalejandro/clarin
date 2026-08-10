package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type WhiteboardGrantInput struct {
	UserID      uuid.UUID `json:"user_id"`
	AccessLevel string    `json:"access_level"`
}

func (r *WhiteboardRepository) GetBoardAccessPolicy(ctx context.Context, accountID, actorID, boardID uuid.UUID) (*domain.WhiteboardAccessPolicy, error) {
	access, err := r.RequireManageAccess(ctx, accountID, actorID, boardID)
	if err != nil {
		return nil, err
	}
	policy := &domain.WhiteboardAccessPolicy{BoardID: boardID, EffectiveAccess: access, Grants: []*domain.WhiteboardGrant{}}
	if err := r.db.QueryRow(ctx, `SELECT access_mode,access_revision FROM whiteboards
		WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&policy.AccessMode, &policy.AccessRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	rows, err := r.db.Query(ctx, `SELECT grant_item.id,grant_item.account_id,grant_item.board_id,grant_item.user_id,
		COALESCE(NULLIF(account_user.display_name,''),account_user.username),account_user.email,
		grant_item.access_level,grant_item.can_manage_access,grant_item.created_by,
		grant_item.created_at,grant_item.updated_at
		FROM whiteboard_grants grant_item
		JOIN users account_user ON account_user.id=grant_item.user_id
		JOIN user_accounts membership ON membership.account_id=grant_item.account_id AND membership.user_id=grant_item.user_id
		WHERE grant_item.account_id=$1 AND grant_item.board_id=$2 AND account_user.is_active
		ORDER BY LOWER(COALESCE(NULLIF(account_user.display_name,''),account_user.username)),grant_item.user_id`, accountID, boardID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		grant := &domain.WhiteboardGrant{}
		if err := rows.Scan(&grant.ID, &grant.AccountID, &grant.BoardID, &grant.UserID,
			&grant.DisplayName, &grant.Email, &grant.AccessLevel, &grant.CanManageAccess,
			&grant.CreatedBy, &grant.CreatedAt, &grant.UpdatedAt); err != nil {
			return nil, err
		}
		policy.Grants = append(policy.Grants, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return policy, nil
}

func (r *WhiteboardRepository) ReplaceBoardAccess(ctx context.Context, accountID, actorID, boardID uuid.UUID, accessMode string, inputs []WhiteboardGrantInput, expectedAccessRevision int64, operationID uuid.UUID) (*domain.WhiteboardAccessPolicy, error) {
	if accessMode != domain.WhiteboardAccessPrivate && accessMode != domain.WhiteboardAccessAccount {
		return nil, ErrWhiteboardInvalid
	}
	if err := requireWhiteboardExpectedVersion(expectedAccessRevision); err != nil {
		return nil, err
	}
	if operationID == uuid.Nil {
		return nil, ErrWhiteboardInvalid
	}
	if len(inputs) > 200 {
		return nil, ErrWhiteboardInvalid
	}
	byUser := make(map[uuid.UUID]WhiteboardGrantInput, len(inputs)+1)
	for _, input := range inputs {
		if input.UserID == uuid.Nil || !validWhiteboardAccessLevel(input.AccessLevel, false) {
			return nil, ErrWhiteboardInvalid
		}
		if _, duplicate := byUser[input.UserID]; duplicate {
			return nil, ErrWhiteboardInvalid
		}
		byUser[input.UserID] = input
	}
	requestedIDs := make([]uuid.UUID, 0, len(byUser))
	for userID := range byUser {
		requestedIDs = append(requestedIDs, userID)
	}
	sort.Slice(requestedIDs, func(i, j int) bool { return requestedIDs[i].String() < requestedIDs[j].String() })
	requestedGrants := make([]WhiteboardGrantInput, 0, len(requestedIDs))
	for _, userID := range requestedIDs {
		requestedGrants = append(requestedGrants, byUser[userID])
	}
	requestJSON, _ := json.Marshal(struct {
		AccessMode             string                 `json:"access_mode"`
		ExpectedAccessRevision int64                  `json:"expected_access_revision"`
		Grants                 []WhiteboardGrantInput `json:"grants"`
	}{accessMode, expectedAccessRevision, requestedGrants})
	digest := sha256.Sum256(requestJSON)
	requestPayloadHash := hex.EncodeToString(digest[:])
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var creatorID *uuid.UUID
	var beforeMode string
	var beforeRevision int64
	if err := tx.QueryRow(ctx, `SELECT created_by,access_mode,access_revision FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).Scan(&creatorID, &beforeMode, &beforeRevision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	actorAccess, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessManage, true)
	if err != nil {
		return nil, err
	}
	var existingActorID *uuid.UUID
	var existingPayloadHash *string
	err = tx.QueryRow(ctx, `SELECT actor_id,request_payload_hash FROM whiteboard_access_audit
		WHERE account_id=$1 AND board_id=$2 AND operation_id=$3 AND action='access_replaced'`,
		accountID, boardID, operationID).Scan(&existingActorID, &existingPayloadHash)
	if err == nil {
		if existingActorID == nil || *existingActorID != actorID || existingPayloadHash == nil || *existingPayloadHash != requestPayloadHash {
			return nil, ErrWhiteboardConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.GetBoardAccessPolicy(ctx, accountID, actorID, boardID)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if err := checkWhiteboardExpectedVersion(expectedAccessRevision, beforeRevision); err != nil {
		return nil, err
	}
	if creatorID != nil {
		byUser[*creatorID] = WhiteboardGrantInput{UserID: *creatorID, AccessLevel: domain.WhiteboardAccessManage}
	}
	if actorAccess.InheritedFrom == "direct_grant" {
		byUser[actorID] = WhiteboardGrantInput{UserID: actorID, AccessLevel: domain.WhiteboardAccessManage}
	}
	userIDs := make([]uuid.UUID, 0, len(byUser))
	for userID := range byUser {
		userIDs = append(userIDs, userID)
	}
	if len(userIDs) > 0 {
		var memberCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM user_accounts membership
			JOIN users account_user ON account_user.id=membership.user_id AND account_user.is_active
			WHERE membership.account_id=$1 AND membership.user_id=ANY($2::uuid[])`, accountID, userIDs).Scan(&memberCount); err != nil {
			return nil, err
		}
		if memberCount != len(userIDs) {
			return nil, ErrWhiteboardInvalid
		}
	}
	var beforeJSON []byte
	if err := tx.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(jsonb_build_object(
		'user_id',user_id,'access_level',access_level,'can_manage_access',can_manage_access
	) ORDER BY user_id),'[]'::jsonb) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2`, accountID, boardID).Scan(&beforeJSON); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2`, accountID, boardID); err != nil {
		return nil, err
	}
	sort.Slice(userIDs, func(i, j int) bool { return userIDs[i].String() < userIDs[j].String() })
	for _, userID := range userIDs {
		input := byUser[userID]
		manage := input.AccessLevel == domain.WhiteboardAccessManage
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_grants(
			account_id,board_id,user_id,access_level,can_manage_access,created_by
		) VALUES($1,$2,$3,$4,$5,$6)`, accountID, boardID, userID, input.AccessLevel, manage, actorID); err != nil {
			return nil, normalizeWhiteboardConstraintError(err)
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET access_mode=$3,access_revision=access_revision+1,
		version=version+1,updated_by=$4,updated_at=NOW() WHERE account_id=$1 AND id=$2`,
		accountID, boardID, accessMode, actorID); err != nil {
		return nil, err
	}
	afterGrants := make([]WhiteboardGrantInput, 0, len(userIDs))
	for _, userID := range userIDs {
		afterGrants = append(afterGrants, byUser[userID])
	}
	beforeState, _ := json.Marshal(map[string]any{"access_mode": beforeMode, "access_revision": beforeRevision, "grants": json.RawMessage(beforeJSON)})
	afterState, _ := json.Marshal(map[string]any{"access_mode": accessMode, "access_revision": beforeRevision + 1, "grants": afterGrants})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,before_state,after_state,operation_id,request_payload_hash
	) VALUES($1,$2,$3,'access_replaced',$4::jsonb,$5::jsonb,$6,$7)`,
		accountID, boardID, actorID, beforeState, afterState, operationID, requestPayloadHash); err != nil {
		return nil, err
	}
	activityDetails, _ := json.Marshal(map[string]any{
		"access_mode": accessMode, "access_revision": beforeRevision + 1, "grant_count": len(afterGrants),
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityAccessUpdated, Details: activityDetails, OperationID: &operationID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetBoardAccessPolicy(ctx, accountID, actorID, boardID)
}
