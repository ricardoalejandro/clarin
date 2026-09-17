package database

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// migrateOfflineDevicePosture makes Windows security features advisory for the
// end user while preserving a closed, auditable decision for the superadmin.
func migrateOfflineDevicePosture(ctx context.Context, db *pgxpool.Pool) error {
	statements := []string{
		`ALTER TABLE offline_terminals
			ADD COLUMN IF NOT EXISTS bitlocker_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
			ADD COLUMN IF NOT EXISTS windows_hello_status VARCHAR(24) NOT NULL DEFAULT 'unknown',
			ADD COLUMN IF NOT EXISTS posture_reported_at TIMESTAMPTZ`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offline_terminals_bitlocker_status_check' AND conrelid='offline_terminals'::regclass) THEN
				ALTER TABLE offline_terminals ADD CONSTRAINT offline_terminals_bitlocker_status_check CHECK (bitlocker_status IN ('enabled','disabled','unknown'));
			END IF;
		END $$`,
		`DO $$ BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offline_terminals_windows_hello_status_check' AND conrelid='offline_terminals'::regclass) THEN
				ALTER TABLE offline_terminals ADD CONSTRAINT offline_terminals_windows_hello_status_check CHECK (windows_hello_status IN ('configured','not_configured','unknown'));
			END IF;
		END $$`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(ctx, statement); err != nil {
			return fmt.Errorf("offline device posture migration: %w", err)
		}
	}
	return nil
}
