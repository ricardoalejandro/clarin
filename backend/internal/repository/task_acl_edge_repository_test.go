package repository

import (
	"strings"
	"testing"
)

func TestSavedViewScopePredicateRequiresActorAccessInEveryHierarchyScope(t *testing.T) {
	predicate := taskSavedViewActorScopeSQL("saved", "$2")
	for _, fragment := range []string{
		"saved.scope_type='environment'",
		"saved.scope_type='folder'",
		"saved.scope_type='list'",
		"environment.id=folder.environment_id",
		"environment.id=list_item.environment_id",
		"environment_grant.user_id=$2",
		"environment.archived_at IS NULL",
	} {
		if !strings.Contains(predicate, fragment) {
			t.Errorf("saved-view ACL predicate missing %q: %s", fragment, predicate)
		}
	}
}

func TestTaskVisibilityPredicateUsesRootGrantAndEnvironmentFallback(t *testing.T) {
	predicate := TaskActorCanViewSQL("candidate", "candidate_list", "$7")
	for _, fragment := range []string{
		"candidate.account_id",
		"COALESCE(candidate.parent_task_id,candidate.id)",
		"candidate_list.environment_id",
		"direct_grant.user_id=$7",
		"environment_grant.user_id=$7",
	} {
		if !strings.Contains(predicate, fragment) {
			t.Errorf("task visibility predicate missing %q: %s", fragment, predicate)
		}
	}
}

func TestDependencyReadRequiresVisibilityOfBothCrossEnvironmentEndpoints(t *testing.T) {
	query := taskDependenciesForActorSQL()
	for _, fragment := range []string{
		"JOIN task_lists predecessor_list",
		"JOIN task_lists successor_list",
		"predecessor_list.environment_id",
		"successor_list.environment_id",
		"d.predecessor_task_id=$3 OR d.successor_task_id=$3",
		"p.deleted_at IS NULL AND s.deleted_at IS NULL",
	} {
		if !strings.Contains(query, fragment) {
			t.Errorf("dependency endpoint ACL query missing %q: %s", fragment, query)
		}
	}
	if count := strings.Count(query, "task_access_grants direct_grant"); count != 2 {
		t.Fatalf("dependency query applies task grants %d times, want once per endpoint: %s", count, query)
	}
	if count := strings.Count(query, "direct_grant.user_id=$2"); count != 2 {
		t.Fatalf("dependency query applies actor predicate %d times, want once per endpoint: %s", count, query)
	}
}

func TestActivityFeedDoesNotExposeHierarchyOrHiddenRelations(t *testing.T) {
	t.Parallel()
	raw := []byte(`{"version":7,"operation_id":"op","from_list_id":"secret-list","to_environment_id":"secret-environment","predecessor_task_id":"secret-task"}`)
	public := string(taskActivityPublicMetadata(raw))
	if !strings.Contains(public, `"version":7`) || !strings.Contains(public, `"operation_id":"op"`) {
		t.Fatalf("safe activity metadata was removed: %s", public)
	}
	for _, secret := range []string{"from_list_id", "to_environment_id", "predecessor_task_id", "secret-list", "secret-task"} {
		if strings.Contains(public, secret) {
			t.Fatalf("activity metadata exposed %q: %s", secret, public)
		}
	}
	source := readRepositorySource(t, "task_work_repository.go")
	for _, invariant := range []string{"ListActivityForActor", "task.deleted_at IS NULL", "taskActorCanViewSQL(\"task\", \"list_item\", \"$2\")"} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("actor-scoped activity query lost invariant %q", invariant)
		}
	}
}

func TestLegacyOrderAndStarMutationsRecheckACLInsideTransaction(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_repository.go")
	for _, invariant := range []string{
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{id}, domain.TaskAccessEdit)",
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, taskIDs, domain.TaskAccessEdit)",
		"resolveEnvironmentAccessWith(ctx, tx, accountID, actorID, environmentID)",
		"TaskAccessAllows(access, domain.TaskAccessFull)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("legacy mutation lost transactional ACL invariant %q", invariant)
		}
	}
}

func TestTrashMutationsKeepACLAndAdminChecksInsideTransaction(t *testing.T) {
	t.Parallel()
	trashSource := readRepositorySource(t, "task_trash_repository.go")
	for _, invariant := range []string{
		"ArchiveListConfirmed(ctx context.Context, accountID, actorID, listID uuid.UUID",
		"ArchiveFolderConfirmed(ctx context.Context, accountID, actorID, folderID uuid.UUID",
		"RestoreList(ctx context.Context, accountID, actorID, listID uuid.UUID",
		"RestoreFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID",
		"lockAndRequireActiveEnvironmentAccessTx(ctx, tx, accountID, actorID, environmentID, domain.TaskAccessFull)",
		"lockAndRequireTaskAccountAdminTx(ctx, tx, accountID, actorID)",
		"lockAndRequireDeletedTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{taskID}, domain.TaskAccessFull)",
		"lockTrashPolicy(ctx, tx, accountID)",
		"ErrTaskTrashConfirmation",
	} {
		if !strings.Contains(trashSource, invariant) {
			t.Fatalf("trash mutation lost transactional invariant %q", invariant)
		}
	}
	workSource := readRepositorySource(t, "task_work_repository.go")
	for _, invariant := range []string{
		"lockAndRequireTaskAccessTx(ctx, tx, accountID, userID, []uuid.UUID{taskID}, domain.TaskAccessFull)",
		"lockAndRequireDeletedTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{taskID}, domain.TaskAccessFull)",
	} {
		if !strings.Contains(workSource, invariant) {
			t.Fatalf("task trash/restore lost transactional invariant %q", invariant)
		}
	}
}
