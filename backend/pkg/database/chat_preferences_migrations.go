package database

func chatPreferencesMigrations() []string {
	return []string{
		`CREATE UNIQUE INDEX IF NOT EXISTS uq_chats_account_identity ON chats(account_id,id)`,
		`CREATE TABLE IF NOT EXISTS chat_user_preferences (
		 account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
		 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
		 chat_id UUID NOT NULL,
		 is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
		 pinned_at TIMESTAMPTZ,
		 version BIGINT NOT NULL DEFAULT 1 CHECK(version > 0),
		 PRIMARY KEY(account_id,user_id,chat_id),
		 FOREIGN KEY(account_id,chat_id) REFERENCES chats(account_id,id) ON DELETE CASCADE,
		 CHECK((is_pinned AND pinned_at IS NOT NULL) OR (NOT is_pinned AND pinned_at IS NULL))
		)`,
		`CREATE INDEX IF NOT EXISTS idx_chat_user_pins ON chat_user_preferences(account_id,user_id,pinned_at DESC,chat_id) WHERE is_pinned`,
	}
}
