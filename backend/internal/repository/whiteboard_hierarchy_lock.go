package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// lockWhiteboardHierarchyTx serializes structural whiteboard mutations within
// one account. A hash collision can only cause extra serialization; it cannot
// weaken isolation. Every caller must hold the returned transaction until its
// folder/board validation and write have both completed.
func lockWhiteboardHierarchyTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, accountID.String())
	return err
}

func requireWhiteboardExpectedVersion(expectedVersion int64) error {
	if expectedVersion <= 0 {
		return ErrWhiteboardInvalid
	}
	return nil
}

func checkWhiteboardExpectedVersion(expectedVersion, currentVersion int64) error {
	if err := requireWhiteboardExpectedVersion(expectedVersion); err != nil {
		return err
	}
	if expectedVersion != currentVersion {
		return &WhiteboardConflictError{CurrentVersion: currentVersion}
	}
	return nil
}
