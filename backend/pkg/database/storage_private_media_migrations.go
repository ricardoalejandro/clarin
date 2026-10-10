package database

// A storage removal hides an attachment while retaining comments, annotations,
// preview identity and the original task relation for exact recovery. It is
// independent of the task/container Trash lifecycle.
func storagePrivateMediaMigrations() []string {
	return []string{
		`ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS storage_removed_at TIMESTAMPTZ`,
		`ALTER TABLE task_attachments ADD COLUMN IF NOT EXISTS storage_removal_id UUID`,
		`DO $$ BEGIN
		 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='uq_task_attachments_task_asset' AND indexdef LIKE '%storage_removed_at IS NULL%') THEN
		  DROP INDEX IF EXISTS uq_task_attachments_task_asset;
		  CREATE UNIQUE INDEX uq_task_attachments_task_asset ON task_attachments(account_id,task_id,media_asset_id)
		   WHERE attachment_scope='task' AND storage_removed_at IS NULL;
		 END IF; END $$`,
		`DO $$ BEGIN
		 IF NOT EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='uq_task_attachments_comment_draft_owner_asset' AND indexdef LIKE '%storage_removed_at IS NULL%') THEN
		  DROP INDEX IF EXISTS uq_task_attachments_comment_draft_owner_asset;
		  CREATE UNIQUE INDEX uq_task_attachments_comment_draft_owner_asset ON task_attachments(account_id,task_id,media_asset_id,draft_owner_id)
		   WHERE attachment_scope='comment_draft' AND storage_removed_at IS NULL;
		 END IF; END $$`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachments_storage_active
		 ON task_attachments(account_id,task_id,media_asset_id) WHERE storage_removed_at IS NULL`,
		`CREATE INDEX IF NOT EXISTS idx_task_attachments_storage_removed
		 ON task_attachments(account_id,storage_removal_id) WHERE storage_removed_at IS NOT NULL`,
	}
}
