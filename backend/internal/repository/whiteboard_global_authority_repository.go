package repository

import (
	"context"
	"sort"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// WhiteboardAuthorityMutationEffect is the exact durable scope captured by the
// same transaction that changed global authority. Deletions return this value
// because their membership/role relation no longer exists after commit.
type WhiteboardAuthorityMutationEffect struct {
	AccountIDs []uuid.UUID
	UserIDs    []uuid.UUID
}

func canonicalAuthorityUUIDs(values ...[]uuid.UUID) []uuid.UUID {
	seen := make(map[uuid.UUID]struct{})
	for _, items := range values {
		for _, item := range items {
			if item != uuid.Nil {
				seen[item] = struct{}{}
			}
		}
	}
	result := make([]uuid.UUID, 0, len(seen))
	for item := range seen {
		result = append(result, item)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].String() < result[j].String() })
	return result
}

// lockUserAuthorityTx serializes every mutation that can change one user's
// account-wide authority without taking the user row before board locks. The
// latter would invert the board->user order used by collaboration callbacks.
func lockUserAuthorityTx(ctx context.Context, tx pgx.Tx, userID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731942))`, userID)
	return err
}

// lockWhiteboardAuthorityAccountTx is the account-wide serialization point
// shared by contextual whiteboard creation/mutation and every authority or
// Work-container transition that invalidates whiteboard access. Contextual
// mutations take the relevant Work parent lock first and then this barrier.
// Invalidation paths take it immediately before enumerating affected views and
// boards. That ordering gives concurrent operations one durable outcome:
// either the contextual board commits first and is included in the following
// invalidation, or the invalidation commits first and the contextual mutation
// re-evaluates the new authority before it can write.
func lockWhiteboardAuthorityAccountTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731943))`, accountID)
	return err
}

func lockRoleAuthorityReferenceTx(ctx context.Context, tx pgx.Tx, roleID *uuid.UUID) error {
	if roleID == nil || *roleID == uuid.Nil {
		return nil
	}
	var lockedID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM roles WHERE id=$1 FOR KEY SHARE`, *roleID).Scan(&lockedID); err != nil {
		return err
	}
	return nil
}

// bumpAllWhiteboardAccessRevisionTx serializes a tenant-wide authority change
// with contextual lifecycle and document mutations. The canonical order is:
// every Work location view by UUID, then every board by UUID. Standalone boards
// participate in the board phase; Work boards additionally advance their view
// revision so deep links and contextual metadata cannot retain stale access.
func bumpAllWhiteboardAccessRevisionTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	if err := lockWhiteboardAuthorityAccountTx(ctx, tx, accountID); err != nil {
		return err
	}
	viewRows, err := tx.Query(ctx, `SELECT id FROM task_location_views
		WHERE account_id=$1 ORDER BY id FOR UPDATE`, accountID)
	if err != nil {
		return err
	}
	viewIDs := make([]uuid.UUID, 0)
	for viewRows.Next() {
		var viewID uuid.UUID
		if err := viewRows.Scan(&viewID); err != nil {
			viewRows.Close()
			return err
		}
		viewIDs = append(viewIDs, viewID)
	}
	if err := viewRows.Err(); err != nil {
		viewRows.Close()
		return err
	}
	viewRows.Close()

	boardRows, err := tx.Query(ctx, `SELECT id FROM whiteboards
		WHERE account_id=$1 ORDER BY id FOR UPDATE`, accountID)
	if err != nil {
		return err
	}
	boardIDs := make([]uuid.UUID, 0)
	for boardRows.Next() {
		var boardID uuid.UUID
		if err := boardRows.Scan(&boardID); err != nil {
			boardRows.Close()
			return err
		}
		boardIDs = append(boardIDs, boardID)
	}
	if err := boardRows.Err(); err != nil {
		boardRows.Close()
		return err
	}
	boardRows.Close()

	// UUID ordering is guaranteed by SQL and retained explicitly for callers
	// that construct account sets from maps before invoking this helper.
	sort.Slice(viewIDs, func(i, j int) bool { return viewIDs[i].String() < viewIDs[j].String() })
	sort.Slice(boardIDs, func(i, j int) bool { return boardIDs[i].String() < boardIDs[j].String() })
	if len(viewIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE task_location_views SET
			access_revision=access_revision+1
			WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, viewIDs); err != nil {
			return err
		}
	}
	if len(boardIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET
			access_revision=access_revision+1
			WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, boardIDs); err != nil {
			return err
		}
	}
	return nil
}
