package database

// eventParticipantSelectionMigrations is part of Migrate, never seed/bootstrap.
func eventParticipantSelectionMigrations() []string {
	return []string{
		`CREATE TABLE IF NOT EXISTS event_participant_selections (
   id UUID PRIMARY KEY, account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
   actor_id UUID NOT NULL, event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
   filter JSONB NOT NULL, rule_revision BIGINT NOT NULL, initial_stage_id UUID,
   selected_count INTEGER NOT NULL DEFAULT 0, new_count INTEGER NOT NULL DEFAULT 0,
   reactivation_count INTEGER NOT NULL DEFAULT 0, operation_id UUID, result JSONB,
   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL,
   UNIQUE(account_id,id)
  )`,
		`CREATE UNIQUE INDEX IF NOT EXISTS event_participant_selection_operation ON event_participant_selections(account_id,actor_id,operation_id) WHERE operation_id IS NOT NULL`,
		`CREATE INDEX IF NOT EXISTS event_participant_selection_expiration ON event_participant_selections(account_id,created_at,expires_at)`,
		`CREATE TABLE IF NOT EXISTS event_participant_selection_items (
   account_id UUID NOT NULL, selection_id UUID NOT NULL, contact_id UUID NOT NULL,
   previous_state TEXT NOT NULL,
   PRIMARY KEY(selection_id,contact_id),
   FOREIGN KEY(account_id,selection_id) REFERENCES event_participant_selections(account_id,id) ON DELETE CASCADE
  )`,
	}
}
