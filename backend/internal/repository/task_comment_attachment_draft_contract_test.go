package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func readRepositorySource(t *testing.T, name string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}

func TestCommentAttachmentDraftContractIsOwnerScopedHiddenAndDurable(t *testing.T) {
	t.Parallel()
	uploadSource := readRepositorySource(t, "task_attachment_upload_repository.go")
	commentSource := readRepositorySource(t, "task_work_repository.go")
	trashSource := readRepositorySource(t, "task_trash_repository.go")

	for _, invariant := range []string{
		"TaskAttachmentScopeCommentDraft",
		"ON CONFLICT DO NOTHING",
		"attachment_scope='comment_draft' AND draft_owner_id=$4 FOR UPDATE",
		"currentDraftOwner == nil || *currentDraftOwner != userID",
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, userID, []uuid.UUID{taskID}, requiredAccess)",
		"reconcileTaskCommentDraftGCJobTx",
		"SELECT MIN(draft_expires_at)",
		"attachment_scope='task'",
	} {
		if !strings.Contains(uploadSource, invariant) {
			t.Fatalf("comment draft upload lost invariant %q", invariant)
		}
	}
	migrationSource := readRepositorySource(t, "../../pkg/database/task_work_migration.go")
	for _, invariant := range []string{
		"DROP CONSTRAINT IF EXISTS task_attachments_task_id_media_asset_id_key",
		"uq_task_attachments_task_asset",
		"uq_task_attachments_comment_draft_owner_asset",
	} {
		if !strings.Contains(migrationSource, invariant) {
			t.Fatalf("comment drafts lost concurrent-owner migration invariant %q", invariant)
		}
	}
	for _, invariant := range []string{
		"WHERE account_id=$1 AND task_id=$2 AND id=$3 FOR UPDATE",
		"*ownerID != actorID",
		"attachment_scope='comment'",
		"COALESCE(ta.attachment_scope,'task')='task'",
		"scheduleOrphanedCommentAttachmentsTx",
		"[]uuid.UUID{comment.TaskID}, domain.TaskAccessComment",
		"[]uuid.UUID{taskID}, domain.TaskAccessComment",
	} {
		if !strings.Contains(commentSource, invariant) {
			t.Fatalf("comment draft promotion lost invariant %q", invariant)
		}
	}
	if !strings.Contains(trashSource, "attachment_scope='comment_draft'") ||
		!strings.Contains(trashSource, "draft_expires_at<=NOW()") ||
		!strings.Contains(trashSource, "nextDraftExpiry") ||
		!strings.Contains(trashSource, "status='pending',claim_token=NULL") {
		t.Fatal("expired comment drafts are not consumed by durable task media GC")
	}
	if !strings.Contains(trashSource, "claim_token=$4 FOR UPDATE") ||
		!strings.Contains(trashSource, "object_key=$3 AND status='task_gc_deleting'") ||
		!strings.Contains(trashSource, "object_key=$4 AND claim_token=$5") {
		t.Fatal("task media GC completion does not protect a newer hash reservation from a stale worker")
	}
}

func TestMembershipRemovalAuditsACLBeforeCascadeAndIsRetrySafe(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_membership_acl_repository.go")
	for _, invariant := range []string{
		"SELECT id FROM user_accounts WHERE account_id=$1 AND user_id=$2 FOR UPDATE",
		"errors.Is(err, pgx.ErrNoRows)",
		"ORDER BY task.id FOR UPDATE",
		"ORDER BY list_item.id FOR UPDATE",
		"ORDER BY folder.id FOR UPDATE",
		"ORDER BY environment.id FOR UPDATE",
		"ErrTaskLastAccessManager",
		"'membership_grant_removed'",
		"FROM task_environment_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2",
		"FROM task_folder_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2",
		"FROM task_list_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2",
		"FROM task_access_grants grant_item WHERE grant_item.account_id=$1 AND grant_item.user_id=$2",
		"access_revision=access_revision+1",
		"access_revision=COALESCE(access_revision,1)+1",
		"DELETE FROM user_accounts WHERE account_id=$1 AND user_id=$2",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("membership ACL removal lost invariant %q", invariant)
		}
	}
	if strings.Index(source, "'membership_grant_removed'") > strings.Index(source, "DELETE FROM user_accounts WHERE account_id=$1 AND user_id=$2") {
		t.Fatal("membership deletion occurs before its ACL audit")
	}
}
