package repository

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const (
	WhiteboardActivityCreated          = "board.created"
	WhiteboardActivityDuplicated       = "board.duplicated"
	WhiteboardActivityUpdated          = "board.updated"
	WhiteboardActivityArchived         = "board.archived"
	WhiteboardActivityRestored         = "board.restored"
	WhiteboardActivityScenePatched     = "scene.patched"
	WhiteboardActivitySceneSnapshotted = "scene.snapshotted"
	WhiteboardActivityRevisionCreated  = "revision.created"
	WhiteboardActivityRevisionRestored = "revision.restored"
	WhiteboardActivityAccessUpdated    = "access.updated"
	WhiteboardActivityShareCreated     = "share.created"
	WhiteboardActivityShareRevoked     = "share.revoked"
	WhiteboardActivityGuestJoined      = "guest.joined"
	WhiteboardActivityGuestRevoked     = "guest.revoked"
	WhiteboardActivityAssetUploaded    = "asset.uploaded"
	WhiteboardActivityAssetDeleted     = "asset.deleted"
	WhiteboardActivityThumbnailUpdated = "thumbnail.updated"
	maxWhiteboardActivityDetailsBytes  = 64 * 1024
)

var allowedWhiteboardActivityActions = map[string]struct{}{
	WhiteboardActivityCreated: {}, WhiteboardActivityDuplicated: {}, WhiteboardActivityUpdated: {},
	WhiteboardActivityArchived: {}, WhiteboardActivityRestored: {}, WhiteboardActivityScenePatched: {},
	WhiteboardActivitySceneSnapshotted: {}, WhiteboardActivityRevisionCreated: {},
	WhiteboardActivityRevisionRestored: {}, WhiteboardActivityAccessUpdated: {},
	WhiteboardActivityShareCreated: {}, WhiteboardActivityShareRevoked: {},
	WhiteboardActivityGuestJoined: {}, WhiteboardActivityGuestRevoked: {}, WhiteboardActivityAssetUploaded: {},
	WhiteboardActivityAssetDeleted: {}, WhiteboardActivityThumbnailUpdated: {},
}

type WhiteboardActivityInput struct {
	AccountID      uuid.UUID
	BoardID        uuid.UUID
	ActorID        *uuid.UUID
	GuestSessionID *uuid.UUID
	Action         string
	Details        json.RawMessage
	OperationID    *uuid.UUID
}

func validateWhiteboardActivityInput(input WhiteboardActivityInput) (json.RawMessage, error) {
	if input.AccountID == uuid.Nil || input.BoardID == uuid.Nil {
		return nil, ErrWhiteboardInvalid
	}
	if _, ok := allowedWhiteboardActivityActions[input.Action]; !ok {
		return nil, ErrWhiteboardInvalid
	}
	if (input.ActorID != nil && *input.ActorID == uuid.Nil) ||
		(input.GuestSessionID != nil && *input.GuestSessionID == uuid.Nil) ||
		(input.OperationID != nil && *input.OperationID == uuid.Nil) {
		return nil, ErrWhiteboardInvalid
	}
	details := bytes.TrimSpace(input.Details)
	if len(details) == 0 {
		details = []byte(`{}`)
	}
	if len(details) > maxWhiteboardActivityDetailsBytes || !json.Valid(details) {
		return nil, ErrWhiteboardInvalid
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(details, &object) != nil || object == nil {
		return nil, ErrWhiteboardInvalid
	}
	return append(json.RawMessage(nil), details...), nil
}

func insertWhiteboardActivityTx(ctx context.Context, tx pgx.Tx, input WhiteboardActivityInput) error {
	details, err := validateWhiteboardActivityInput(input)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO whiteboard_activity(
		account_id,board_id,actor_id,guest_session_id,action,details,operation_id
	) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
	ON CONFLICT(account_id,board_id,action,operation_id) WHERE operation_id IS NOT NULL DO NOTHING`,
		input.AccountID, input.BoardID, input.ActorID, input.GuestSessionID, input.Action, details, input.OperationID)
	return err
}

type WhiteboardActivityListOptions struct {
	BeforeCreatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

func (r *WhiteboardRepository) ListBoardActivity(ctx context.Context, accountID, actorID, boardID uuid.UUID, options WhiteboardActivityListOptions) ([]*domain.WhiteboardActivity, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT activity.id,activity.account_id,activity.board_id,
		activity.actor_id,COALESCE(NULLIF(actor.display_name,''),actor.username,''),
		activity.guest_session_id,COALESCE(guest.display_name,''),activity.action,activity.details,
		activity.operation_id,activity.created_at
		FROM whiteboard_activity activity
		LEFT JOIN users actor ON actor.id=activity.actor_id
		LEFT JOIN whiteboard_guest_sessions guest ON guest.account_id=activity.account_id
			AND guest.board_id=activity.board_id AND guest.id=activity.guest_session_id
		WHERE activity.account_id=$1 AND activity.board_id=$2
		AND ($3::timestamptz IS NULL OR (activity.created_at,activity.id)<($3::timestamptz,$4::uuid))
		ORDER BY activity.created_at DESC,activity.id DESC LIMIT $5`, accountID, boardID,
		options.BeforeCreatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardActivity, 0, limit)
	for rows.Next() {
		item := &domain.WhiteboardActivity{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.ActorID, &item.ActorName,
			&item.GuestSessionID, &item.GuestDisplayName, &item.Action, &item.Details,
			&item.OperationID, &item.CreatedAt); err != nil {
			return nil, false, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return items, hasMore, nil
}
