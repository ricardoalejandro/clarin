package repository

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// WithAccessEpoch holds a shared lock on the canonical whiteboards row while
// callback resolves every room principal and enqueues one fanout. ACL,
// lifecycle, account, membership, role and subscription mutations all advance
// access_revision while taking an UPDATE lock on this row. Consequently the
// fanout is serialized wholly before or wholly after their commit; there is no
// revision-read -> enqueue gap.
//
// Fanout intentionally locks only the board row. Work mutations use the
// parent -> location view -> board order and never need a parent lock after the
// board, so this shared endpoint cannot invert that order.
func (r *WhiteboardRepository) WithAccessEpoch(
	ctx context.Context,
	accountID, boardID uuid.UUID,
	callback func(int64) error,
) error {
	if r == nil || r.db == nil || accountID == uuid.Nil || boardID == uuid.Nil || callback == nil {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	var releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			rollbackCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_ = tx.Rollback(rollbackCtx)
		})
	}
	defer release()

	var revision int64
	if err := tx.QueryRow(ctx, `SELECT access_revision FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, boardID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if err := callback(revision); err != nil {
		return err
	}
	// No writes are performed. Rollback is the cheapest explicit release and
	// avoids presenting this read-side serializer as a durable mutation. A
	// release failure after callback must never turn an already enqueued payload
	// into a false authorization failure and terminal-disconnect the room.
	release()
	return nil
}
