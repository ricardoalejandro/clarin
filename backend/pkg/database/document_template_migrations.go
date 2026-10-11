package database

func documentTemplateRevisionMigrations() []string {
	return []string{
		`ALTER TABLE document_templates ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1`,
		`CREATE INDEX IF NOT EXISTS idx_document_templates_page ON document_templates(account_id,updated_at DESC,id DESC)`,
	}
}
