package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Every enrollment/session creation holds this parent lock until commit. A
// concurrent conclusion or archive waits for accepted writes; writers arriving
// after that transition observe the new status before creating anything.
func lockActiveProgram(ctx context.Context, tx pgx.Tx, accountID, programID uuid.UUID) (string, error) {
	var kind, status string
	err := tx.QueryRow(ctx, `SELECT type,status FROM programs WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, programID).Scan(&kind, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrProgramNotFound
	}
	if err != nil {
		return "", err
	}
	if status != "active" {
		return "", ErrProgramInactive
	}
	return kind, nil
}
