package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// workWhiteboardMutationLock is discovered without locks, then validated again
// while holding the owning Work parent and location-view rows. Callers must
// lock the whiteboards row immediately afterwards. This establishes the common
// parent -> location view -> board order used by scene/checkpoint and lifecycle
// mutations without making standalone whiteboards depend on Work tables.
type workWhiteboardMutationLock struct {
	ViewID    uuid.UUID
	ScopeType string
	ScopeID   uuid.UUID
	DeletedAt *time.Time
}

func requireStandaloneWhiteboardMutationLock(state *workWhiteboardMutationLock) error {
	if state != nil {
		return ErrWhiteboardInheritsWorkAccess
	}
	return nil
}

func discoverWorkWhiteboardMutationLock(ctx context.Context, q whiteboardQuerier, accountID, boardID uuid.UUID) (*workWhiteboardMutationLock, error) {
	state := &workWhiteboardMutationLock{}
	err := q.QueryRow(ctx, `SELECT location_view.id,
		CASE WHEN location_view.folder_id IS NOT NULL THEN 'folder' ELSE 'list' END,
		COALESCE(location_view.folder_id,location_view.list_id),location_view.deleted_at
		FROM task_location_whiteboard_views binding
		JOIN task_location_views location_view ON location_view.account_id=binding.account_id
			AND location_view.id=binding.task_view_id
		WHERE binding.account_id=$1 AND binding.whiteboard_id=$2`, accountID, boardID).
		Scan(&state.ViewID, &state.ScopeType, &state.ScopeID, &state.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if state.ViewID == uuid.Nil || state.ScopeID == uuid.Nil ||
		(state.ScopeType != domain.TaskAccessTargetFolder && state.ScopeType != domain.TaskAccessTargetList) {
		return nil, ErrWhiteboardNotFound
	}
	return state, nil
}

// lockWorkWhiteboardParentViewTx locks only the exact location parent. Folder
// and Entorno lifecycle operations already lock every affected child before
// reaching location views, so taking an additional ancestor lock here would
// invert those established orders. The exact row is sufficient to serialize
// a scene write before or after every parent transition.
func lockWorkWhiteboardParentViewTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, boardID uuid.UUID,
	allowArchivedParent, allowDeletedView bool,
) (*workWhiteboardMutationLock, error) {
	state, err := discoverWorkWhiteboardMutationLock(ctx, tx, accountID, boardID)
	if err != nil || state == nil {
		return state, err
	}

	parentQuery := `SELECT archived_at,deleted_at FROM task_folders
		WHERE account_id=$1 AND id=$2 FOR SHARE`
	if state.ScopeType == domain.TaskAccessTargetList {
		parentQuery = `SELECT archived_at,deleted_at FROM task_lists
			WHERE account_id=$1 AND id=$2 FOR SHARE`
	}
	var archivedAt, deletedAt *time.Time
	if err := tx.QueryRow(ctx, parentQuery, accountID, state.ScopeID).Scan(&archivedAt, &deletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if deletedAt != nil || (!allowArchivedParent && archivedAt != nil) {
		return nil, ErrWhiteboardNotFound
	}

	if err := tx.QueryRow(ctx, `SELECT deleted_at FROM task_location_views
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, state.ViewID).Scan(&state.DeletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if state.DeletedAt != nil && !allowDeletedView {
		return nil, ErrWhiteboardNotFound
	}
	return state, nil
}

// lockActiveWhiteboardMutationRowsTx is the single lock entrance for active
// board mutations that also change asset/reference state. Contextual boards
// always lock their Work parent, location view and board in that order;
// standalone boards take only the board lock. Authorization must be resolved
// again after this helper returns so a lifecycle or ACL transition that won the
// race can never be followed by a stale write.
func lockActiveWhiteboardMutationRowsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, boardID uuid.UUID,
) (*workWhiteboardMutationLock, error) {
	state, err := lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, false, false)
	if err != nil {
		return nil, err
	}
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM whiteboards
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, boardID).Scan(&lockedID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	return state, nil
}

func lockWhiteboardRowsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, boardIDs []uuid.UUID) error {
	if len(boardIDs) == 0 {
		return nil
	}
	rows, err := tx.Query(ctx, `SELECT id FROM whiteboards
		WHERE account_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, accountID, boardIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	locked := 0
	for rows.Next() {
		var boardID uuid.UUID
		if err := rows.Scan(&boardID); err != nil {
			return err
		}
		locked++
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if locked != len(boardIDs) {
		return ErrWhiteboardConflict
	}
	return nil
}
