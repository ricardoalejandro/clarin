package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineEnrollmentRequests replaces operator-entered pairing data with
// a device-originated request that is still approved exclusively by the global
// superadmin. It is additive so an inactive v2 pilot can be upgraded safely.
func migrateOfflineEnrollmentRequests(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`ALTER TABLE offline_terminals
			ADD COLUMN IF NOT EXISTS requested_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
			ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ`,
		`ALTER TABLE offline_terminals DROP CONSTRAINT IF EXISTS offline_terminals_state_check`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offline_terminals_state_v3_check' AND conrelid='offline_terminals'::regclass) THEN
				ALTER TABLE offline_terminals ADD CONSTRAINT offline_terminals_state_v3_check CHECK (state IN ('pending','requested','approved','active','rejected','revoked'));
			END IF;
		END $$`,
		`DROP INDEX IF EXISTS uq_offline_terminal_user_sid_active`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_terminal_user_sid_live ON offline_terminals(user_id,windows_sid_hash) WHERE windows_sid_hash IS NOT NULL AND state IN ('pending','requested','approved','active')`,
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_offline_terminal_install_instance_live ON offline_terminals(install_instance_hash) WHERE install_instance_hash IS NOT NULL AND state IN ('pending','requested','approved','active')`,
		`CREATE INDEX IF NOT EXISTS idx_offline_terminals_requests ON offline_terminals(state,requested_at DESC) WHERE state IN ('requested','approved')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline enrollment request migration: %w", err)
		}
	}
	return nil
}
