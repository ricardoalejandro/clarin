package database

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Missing historical order stays unknown. Never reopen completed history.
func MigrateEventLogbookWorkspace(db *pgxpool.Pool) error {
	statements := []string{
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS captured_filter JSONB`,
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1`,
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS captured_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`,
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES users(id) ON DELETE SET NULL`,
		`ALTER TABLE event_logbooks ADD COLUMN IF NOT EXISTS saved_filter JSONB`,
		`ALTER TABLE event_logbook_entries ADD COLUMN IF NOT EXISTS capture_stage_key TEXT`,
		`ALTER TABLE event_logbook_entries ADD COLUMN IF NOT EXISTS stage_position INT`,
		`UPDATE event_logbook_entries SET capture_stage_key=CASE WHEN stage_id IS NOT NULL THEN stage_id::text WHEN stage_name='' THEN 'unassigned' ELSE 'legacy:'||id::text END WHERE capture_stage_key IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_logbook_workspace_dates ON event_logbooks(account_id,event_id,date DESC,id DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_logbook_workspace_entries ON event_logbook_entries(logbook_id,capture_stage_key,id)`,
		`CREATE TABLE IF NOT EXISTS event_logbook_actions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE, logbook_id UUID NOT NULL REFERENCES event_logbooks(id) ON DELETE CASCADE, action TEXT NOT NULL, actor_id UUID REFERENCES users(id) ON DELETE SET NULL, version BIGINT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
		`CREATE INDEX IF NOT EXISTS idx_logbook_actions ON event_logbook_actions(account_id,logbook_id,version DESC)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(context.Background(), statement); err != nil {
			return fmt.Errorf("logbook workspace migration: %w", err)
		}
	}
	return nil
}
