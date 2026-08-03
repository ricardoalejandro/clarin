package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// This is a source contract test for a handwritten, startup-run migration.
// The PostgreSQL integration test exercises the same statements against a
// disposable database when its opt-in environment variable is enabled.
func TestTaskEnvironmentMigrationKeepsIsolationAndACLInvariants(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_environment_migration.go"))
	if err != nil {
		t.Fatalf("read task environment migration: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"visibility VARCHAR(20) NOT NULL DEFAULT 'restricted'",
		"default_access_level VARCHAR(16) NOT NULL DEFAULT 'none'",
		"access_revision BIGINT NOT NULL DEFAULT 1",
		"FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id)",
		"task_folders_workflow_environment_fk",
		"task_lists_folder_environment_fk",
		"task_lists_workflow_environment_fk",
		"ALTER TABLE task_workflows VALIDATE CONSTRAINT task_workflows_environment_account_fk",
		"ALTER TABLE task_lists VALIDATE CONSTRAINT task_lists_workflow_environment_fk",
		"CREATE TABLE IF NOT EXISTS task_environment_grants",
		"CREATE TABLE IF NOT EXISTS task_folder_access_grants",
		"CREATE TABLE IF NOT EXISTS task_list_access_grants",
		"CREATE TABLE IF NOT EXISTS task_access_grants",
		"ALTER TABLE task_folders ADD COLUMN IF NOT EXISTS access_mode",
		"ALTER TABLE task_lists ADD COLUMN IF NOT EXISTS access_revision",
		"target_type IN ('environment','folder','list','task')",
		"FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE",
		"task access grants can only target root tasks",
		"a task with direct grants cannot become a subtask",
		"actor_id UUID REFERENCES users(id) ON DELETE SET NULL",
		"scope_type IN ('all','environment','folder','list')",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task environment migration lost invariant %q", invariant)
		}
	}
}

func TestTaskWorkRerunIsEnvironmentAware(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_work_migration.go"))
	if err != nil {
		t.Fatalf("read task work migration: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"environmentScoped",
		`listOrderPartition = "account_id,environment_id,folder_id"`,
		"environment.is_default AND environment.archived_at IS NULL",
		"w.environment_id=l.environment_id",
		"JOIN task_lists parent_list",
		"attachment_scope VARCHAR(20) NOT NULL DEFAULT 'task'",
		"task_attachments_scope_check",
		"task_attachments_draft_owner_fkey",
		"DROP CONSTRAINT IF EXISTS task_attachments_task_id_media_asset_id_key",
		"uq_task_attachments_task_asset",
		"uq_task_attachments_comment_draft_owner_asset",
		"idx_task_attachments_expired_comment_drafts",
		"idx_task_attachments_draft_owner",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task work rerun lost environment invariant %q", invariant)
		}
	}
}
