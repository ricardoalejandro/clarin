package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func (r *TaskWorkRepository) WorkWhiteboardIDsForAccessTarget(ctx context.Context, accountID uuid.UUID, targetType string, targetID uuid.UUID) ([]uuid.UUID, error) {
	if targetType != "environment" && targetType != "folder" && targetType != "list" {
		return nil, nil
	}
	rows, err := r.db.Query(ctx, `SELECT binding.whiteboard_id
		FROM task_location_views location_view
		JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id
			AND binding.task_view_id=location_view.id
		WHERE location_view.account_id=$1 AND CASE $2::text
			WHEN 'environment' THEN location_view.environment_id=$3
			WHEN 'folder' THEN location_view.folder_id=$3 OR location_view.list_id IN (
				SELECT child.id FROM task_lists child WHERE child.account_id=$1 AND child.folder_id=$3)
			WHEN 'list' THEN location_view.list_id=$3
			ELSE FALSE END
		ORDER BY binding.whiteboard_id`, accountID, targetType, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	boardIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var boardID uuid.UUID
		if err := rows.Scan(&boardID); err != nil {
			return nil, err
		}
		boardIDs = append(boardIDs, boardID)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return boardIDs, nil
}

// bumpTaskLocationWhiteboardAccessRevisionTx invalidates every contextual
// authorization snapshot affected by a parent lifecycle transition. It never
// changes the location view's own deleted_at: restoring a parent must not
// revive a whiteboard that was explicitly sent to Whiteboards Trash.
func bumpTaskLocationWhiteboardAccessRevisionTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, environmentID uuid.UUID,
	folderIDs, listIDs []uuid.UUID,
	includeEnvironment bool,
) error {
	_, err := bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(
		ctx, tx, accountID, environmentID, folderIDs, listIDs, includeEnvironment,
	)
	return err
}

// bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx applies the same
// atomic invalidation as bumpTaskLocationWhiteboardAccessRevisionTx and also
// returns the exact boards changed by the transaction. Handlers use that
// committed set for immediate local and Redis socket invalidation instead of
// racing a second discovery query around an ACL mutation.
func bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, environmentID uuid.UUID,
	folderIDs, listIDs []uuid.UUID,
	includeEnvironment bool,
) ([]uuid.UUID, error) {
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `SELECT location_view.id,binding.whiteboard_id
		FROM task_location_views location_view
		JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id
			AND binding.task_view_id=location_view.id
		JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
		WHERE location_view.account_id=$1 AND (
			($5::boolean AND location_view.environment_id=$2) OR
			(COALESCE(cardinality($3::uuid[]),0)>0 AND location_view.folder_id=ANY($3::uuid[])) OR
			(COALESCE(cardinality($3::uuid[]),0)>0 AND location_view.list_id IN (
				SELECT child.id FROM task_lists child
				WHERE child.account_id=location_view.account_id AND child.folder_id=ANY($3::uuid[])
			)) OR
			(COALESCE(cardinality($4::uuid[]),0)>0 AND location_view.list_id=ANY($4::uuid[]))
		) ORDER BY location_view.id FOR UPDATE OF location_view`,
		accountID, environmentID, folderIDs, listIDs, includeEnvironment)
	if err != nil {
		return nil, err
	}
	viewIDs := make([]uuid.UUID, 0)
	boardIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var viewID, boardID uuid.UUID
		if err := rows.Scan(&viewID, &boardID); err != nil {
			rows.Close()
			return nil, err
		}
		viewIDs = append(viewIDs, viewID)
		boardIDs = append(boardIDs, boardID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(viewIDs) == 0 {
		return []uuid.UUID{}, nil
	}
	if err := lockWhiteboardRowsTx(ctx, tx, accountID, boardIDs); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_location_views SET
		access_revision=access_revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, viewIDs); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE whiteboards SET
		access_revision=access_revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, boardIDs); err != nil {
		return nil, err
	}
	return boardIDs, nil
}
