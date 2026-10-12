package database

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

// MigrateEventStageLayout is part of normal startup, never a seed-only migration.
func MigrateEventStageLayout(db *pgxpool.Pool) error {
	_, err := db.Exec(context.Background(), `ALTER TABLE events ADD COLUMN IF NOT EXISTS stage_revision BIGINT NOT NULL DEFAULT 0`)
	if err != nil {
		return fmt.Errorf("event stage revision: %w", err)
	}
	return nil
}
