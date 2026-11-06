package repository

import (
	"context"

	"github.com/google/uuid"
)

func (r *AccountRepository) SessionIdleTimeout(ctx context.Context, id uuid.UUID) (int, error) {
	var minutes int
	err := r.db.QueryRow(ctx, `SELECT session_idle_timeout_minutes FROM accounts WHERE id=$1`, id).Scan(&minutes)
	return minutes, err
}

func (r *AccountRepository) UpdateSessionIdleTimeout(ctx context.Context, id, actorID uuid.UUID, minutes int) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var previous int
	if err := tx.QueryRow(ctx, `SELECT session_idle_timeout_minutes FROM accounts WHERE id=$1 FOR UPDATE`, id).Scan(&previous); err != nil {
		return err
	}
	if previous == minutes {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE accounts SET session_idle_timeout_minutes=$2, updated_at=NOW() WHERE id=$1`, id, minutes); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO security_events (type, account_id, user_id, metadata)
		VALUES ('account_session_policy_changed', $1, $2,
			jsonb_build_object('previous_idle_timeout_minutes', $3::integer, 'idle_timeout_minutes', $4::integer))
	`, id, actorID, previous, minutes); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
