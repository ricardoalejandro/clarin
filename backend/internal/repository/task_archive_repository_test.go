package repository

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func sourceFunctionBody(t *testing.T, source, startMarker, endMarker string) string {
	t.Helper()
	start := strings.Index(source, startMarker)
	if start < 0 {
		t.Fatalf("missing source marker %q", startMarker)
	}
	end := len(source)
	if endMarker != "" {
		relative := strings.Index(source[start+len(startMarker):], endMarker)
		if relative < 0 {
			t.Fatalf("missing end marker %q after %q", endMarker, startMarker)
		}
		end = start + len(startMarker) + relative
	}
	return source[start:end]
}

func TestHistoricalArchiveAllowsOnlyDoneAndCancelledTasks(t *testing.T) {
	t.Parallel()
	predicate := taskOpenCategorySQL("task", "status")
	for _, invariant := range []string{
		"WHEN 'completed' THEN 'done'",
		"WHEN 'cancelled' THEN 'cancelled'",
		"NOT IN ('done','cancelled')",
	} {
		if !strings.Contains(predicate, invariant) {
			t.Fatalf("historical Archive open-task predicate lost %q: %s", invariant, predicate)
		}
	}
}

func TestHistoricalArchiveRedactsAHiddenFolderFromDirectlySharedList(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_archive_repository.go")
	for _, invariant := range []string{
		"CASE WHEN folder.id IS NOT NULL AND (",
		"taskActorFolderAccessRankSQL(\"folder\", \"$3\")",
		")>=1 THEN list_item.folder_id END",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("historical List projection lost hidden-parent redaction %q", invariant)
		}
	}
}

func TestContainerLifecycleUsesMembershipFirstAndFinalAuthorityBarrier(t *testing.T) {
	t.Parallel()
	archiveSource := readRepositorySource(t, "task_archive_repository.go")
	trashSource := readRepositorySource(t, "task_trash_repository.go")
	environmentSource := readRepositorySource(t, "task_environment_repository.go")
	accessSource := readRepositorySource(t, "task_acl_edge_repository.go")

	containerRevalidation := sourceFunctionBody(t, archiveSource,
		"func revalidateContainerLifecycleAuthorityTx(", "func revalidateEnvironmentLifecycleAuthorityTx(")
	barrier := strings.Index(containerRevalidation, "lockWhiteboardAuthorityAccountTx(ctx, tx, accountID)")
	exact := strings.Index(containerRevalidation, "requireContainerAccessIncludingLifecycleTx(")
	children := strings.Index(containerRevalidation, "requireFolderChildListAccessIncludingLifecycleTx(")
	if barrier < 0 || exact <= barrier || children <= exact {
		t.Fatal("container lifecycle lost barrier -> exact resource -> child List revalidation order")
	}
	environmentRevalidation := sourceFunctionBody(t, archiveSource,
		"func revalidateEnvironmentLifecycleAuthorityTx(", "// ListArchiveHierarchyForActor")
	barrier = strings.Index(environmentRevalidation, "lockWhiteboardAuthorityAccountTx(ctx, tx, accountID)")
	exact = strings.Index(environmentRevalidation, "requireEnvironmentAccessIncludingArchiveTx(")
	children = strings.Index(environmentRevalidation, "requireEnvironmentDescendantAccessIncludingLifecycleTx(")
	if barrier < 0 || exact <= barrier || children <= exact {
		t.Fatal("Entorno lifecycle lost barrier -> exact Entorno -> descendant revalidation order")
	}

	tests := []struct {
		name, source, start, end, revalidate string
	}{
		{"archive list", archiveSource, "func (r *TaskWorkRepository) ArchiveList(", "func (r *TaskWorkRepository) UnarchiveList(", "revalidateContainerLifecycleAuthorityTx("},
		{"unarchive list", archiveSource, "func (r *TaskWorkRepository) UnarchiveList(", "func (r *TaskWorkRepository) ArchiveFolder(", "revalidateContainerLifecycleAuthorityTx("},
		{"archive folder", archiveSource, "func (r *TaskWorkRepository) ArchiveFolder(", "func (r *TaskWorkRepository) UnarchiveFolder(", "revalidateContainerLifecycleAuthorityTx("},
		{"unarchive folder", archiveSource, "func (r *TaskWorkRepository) UnarchiveFolder(", "", "revalidateContainerLifecycleAuthorityTx("},
		{"trash list", trashSource, "func (r *TaskWorkRepository) TrashListConfirmed(", "func (r *TaskWorkRepository) ArchiveListConfirmed(", "revalidateContainerLifecycleAuthorityTx("},
		{"trash folder", trashSource, "func (r *TaskWorkRepository) TrashFolderConfirmed(", "func (r *TaskWorkRepository) ArchiveFolderConfirmed(", "revalidateContainerLifecycleAuthorityTx("},
		{"restore list", trashSource, "func (r *TaskWorkRepository) RestoreList(", "func (r *TaskWorkRepository) RestoreFolder(", "revalidateContainerLifecycleAuthorityTx("},
		{"restore folder", trashSource, "func (r *TaskWorkRepository) RestoreFolder(", "func (r *TaskWorkRepository) ListTrashEnvironments(", "revalidateContainerLifecycleAuthorityTx("},
		{"archive environment", environmentSource, "func (r *TaskWorkRepository) ArchiveEnvironment(", "func (r *TaskWorkRepository) RestoreEnvironment(", "revalidateEnvironmentLifecycleAuthorityTx("},
		{"restore environment", environmentSource, "func (r *TaskWorkRepository) RestoreEnvironment(", "", "revalidateEnvironmentLifecycleAuthorityTx("},
		{"trash environment", trashSource, "func (r *TaskWorkRepository) TrashEnvironment(", "func (r *TaskWorkRepository) RestoreEnvironmentFromTrash(", "revalidateEnvironmentLifecycleAuthorityTx("},
		{"restore trash environment", trashSource, "func (r *TaskWorkRepository) RestoreEnvironmentFromTrash(", "func lockTrashPolicy(", "revalidateEnvironmentLifecycleAuthorityTx("},
	}
	for _, test := range tests {
		body := sourceFunctionBody(t, test.source, test.start, test.end)
		membership := strings.Index(body, "lockTaskActorAndMembershipsTx(ctx, tx, accountID, actorID, nil)")
		resource := strings.Index(body, "FOR UPDATE")
		finalAuthority := strings.LastIndex(body, test.revalidate)
		write := -1
		if finalAuthority >= 0 {
			write = strings.Index(body[finalAuthority:], "UPDATE ")
		}
		if membership < 0 || resource <= membership || finalAuthority <= resource || write < 0 {
			t.Fatalf("%s lost membership -> resource -> final authority -> write order", test.name)
		}
	}

	adminBody := sourceFunctionBody(t, accessSource, "func lockAndRequireTaskAccountAdminTx(", "")
	if membership := strings.Index(adminBody, "lockTaskActorAndMembershipsTx("); membership < 0 ||
		strings.Index(adminBody, "SELECT membership.role") <= membership {
		t.Fatal("account-admin purge gate no longer locks live Work authority before reading admin state")
	}
}

func TestArchiveAndTrashUseIndependentContainerState(t *testing.T) {
	t.Parallel()
	archiveSource := readRepositorySource(t, "task_archive_repository.go")
	for _, invariant := range []string{
		"SET archived_at=NOW(),archived_with_folder=FALSE",
		"SET archived_at=NOW(),archived_with_folder=TRUE",
		"taskOpenCategorySQL(\"task\", \"status\")",
	} {
		if !strings.Contains(archiveSource, invariant) {
			t.Fatalf("historical Archive lost invariant %q", invariant)
		}
	}
	environmentSource := readRepositorySource(t, "task_environment_repository.go")
	if !strings.Contains(environmentSource, "UPDATE task_environments SET archived_at=NOW()") {
		t.Fatal("Entorno historical Archive no longer uses archived_at")
	}

	trashSource := readRepositorySource(t, "task_trash_repository.go")
	for _, invariant := range []string{
		"SET deleted_at=NOW(),deleted_by=$3",
		"task.deleted_at IS NULL",
		"SET deleted_at=NULL,deleted_by=NULL",
		"UPDATE task_environments SET deleted_at=NOW(),deleted_by=$3",
	} {
		if !strings.Contains(trashSource, invariant) {
			t.Fatalf("Trash lost independent lifecycle invariant %q", invariant)
		}
	}
	if strings.Contains(trashSource, "SET archived_at=NULL,deleted_at=NULL") {
		t.Fatal("Trash restore must preserve prior historical Archive state")
	}
}

func TestArchiveFolderWhiteboardCountOnlyRepresentsHistoricalFolder(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_archive_repository.go")
	for _, invariant := range []string{
		"includeWhiteboardCounts bool",
		"CASE WHEN $5::boolean AND ($4::boolean OR folder.archived_at IS NOT NULL)",
		"THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END",
		"WHERE $5::boolean AND location_view.account_id=folder.account_id",
		"CASE WHEN $5::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END",
		"WHERE $5::boolean AND location_view.account_id=list_item.account_id",
		"folder.archived_at IS NOT NULL OR EXISTS(",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("Archive folder whiteboard count lost lifecycle guard %q", invariant)
		}
	}
}

func TestTrashWhiteboardMetadataAndRetentionUseTheSameModuleAndACLProjection(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_trash_repository.go")
	for _, invariant := range []string{
		"includeWhiteboardCounts bool",
		"CASE WHEN $4::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END",
		"CASE WHEN $3::boolean THEN COALESCE(contextual.whiteboard_count,0) ELSE 0 END",
		"MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL(\"location_view\", \"$2\")+`) AS latest_explicit_deleted_at",
		"MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $3::boolean AND `+taskTrashLocationViewCanViewSQL(\"location_view\", \"$2\")+`) AS latest_explicit_deleted_at",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("Trash whiteboard metadata lost module/rollout guard %q", invariant)
		}
	}
	if strings.Contains(source, "MAX(GREATEST(location_view.deleted_at,board.archived_at)) AS latest_explicit_deleted_at") {
		t.Fatal("Trash still lets hidden contextual whiteboards affect retention metadata")
	}
}

func TestTaskContainerLifecycleReturnsExactCommittedWhiteboardSet(t *testing.T) {
	t.Parallel()
	functionBody := func(source, start, end string) string {
		t.Helper()
		startIndex := strings.Index(source, start)
		endIndex := len(source)
		if startIndex >= 0 && end != "" {
			relativeEnd := strings.Index(source[startIndex+len(start):], end)
			if relativeEnd >= 0 {
				endIndex = relativeEnd + startIndex + len(start)
			} else {
				endIndex = -1
			}
		}
		if startIndex < 0 || endIndex <= startIndex {
			t.Fatalf("lifecycle bounds changed: %q -> %q", start, end)
		}
		return source[startIndex:endIndex]
	}
	files := map[string]string{
		"environment": readRepositorySource(t, "task_environment_repository.go"),
		"archive":     readRepositorySource(t, "task_archive_repository.go"),
		"trash":       readRepositorySource(t, "task_trash_repository.go"),
	}
	cases := []struct{ file, start, end string }{
		{"environment", "func (r *TaskWorkRepository) ArchiveEnvironment(", "func (r *TaskWorkRepository) RestoreEnvironment("},
		{"environment", "func (r *TaskWorkRepository) RestoreEnvironment(", ""},
		{"archive", "func (r *TaskWorkRepository) ArchiveList(", "func (r *TaskWorkRepository) UnarchiveList("},
		{"archive", "func (r *TaskWorkRepository) UnarchiveList(", "func (r *TaskWorkRepository) ArchiveFolder("},
		{"archive", "func (r *TaskWorkRepository) ArchiveFolder(", "func (r *TaskWorkRepository) UnarchiveFolder("},
		{"archive", "func (r *TaskWorkRepository) UnarchiveFolder(", ""},
		{"trash", "func (r *TaskWorkRepository) TrashListConfirmed(", "func (r *TaskWorkRepository) ArchiveListConfirmed("},
		{"trash", "func (r *TaskWorkRepository) TrashFolderConfirmed(", "func (r *TaskWorkRepository) ArchiveFolderConfirmed("},
		{"trash", "func (r *TaskWorkRepository) RestoreList(", "func (r *TaskWorkRepository) RestoreFolder("},
		{"trash", "func (r *TaskWorkRepository) RestoreFolder(", "func (r *TaskWorkRepository) ListTrashEnvironments("},
		{"trash", "func (r *TaskWorkRepository) TrashEnvironment(", "func (r *TaskWorkRepository) RestoreEnvironmentFromTrash("},
		{"trash", "func (r *TaskWorkRepository) RestoreEnvironmentFromTrash(", "func lockTrashPolicy("},
	}
	for _, test := range cases {
		body := functionBody(files[test.file], test.start, test.end)
		capture := strings.Index(body, "bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(")
		commit := strings.Index(body, "tx.Commit(ctx)")
		returned := strings.Index(body, "return boardIDs, nil")
		if capture < 0 || commit < 0 || returned < 0 || !(capture < commit && commit < returned) {
			t.Fatalf("%s must return its transaction-locked board IDs only after commit", test.start)
		}
		if strings.Contains(body, "bumpTaskLocationWhiteboardAccessRevisionTx(") {
			t.Fatalf("%s discarded its exact board invalidation set", test.start)
		}
	}

	trashSource := files["trash"]
	purges := []struct{ start, end string }{
		{"func (r *TaskWorkRepository) PurgeList(", "func (r *TaskWorkRepository) PurgeFolder("},
		{"func (r *TaskWorkRepository) PurgeFolder(", "func (r *TaskWorkRepository) PurgeEnvironment("},
		{"func (r *TaskWorkRepository) PurgeEnvironment(", "func (r *TaskWorkRepository) ClaimTaskMediaGCJob("},
	}
	for _, purge := range purges {
		body := functionBody(trashSource, purge.start, purge.end)
		locked := strings.Index(body, "lockTaskLocationWhiteboardsForPurge(")
		commit := strings.Index(body, "tx.Commit(ctx)")
		returned := strings.Index(body, "WhiteboardIDs:")
		if locked < 0 || commit < 0 || returned < 0 || !(locked < commit && commit < returned) {
			t.Fatalf("%s must return its exact locked purge set only after commit", purge.start)
		}
	}

	secretID := uuid.New()
	encoded, err := json.Marshal(&domain.TaskTrashPurgeResult{Whiteboards: 1, WhiteboardIDs: []uuid.UUID{secretID}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), secretID.String()) || strings.Contains(string(encoded), "WhiteboardIDs") {
		t.Fatalf("internal purged board IDs leaked in the API result: %s", encoded)
	}
}

func TestTaskContainerPurgeKillSwitchBlocksEveryContextualTreeInsideTransaction(t *testing.T) {
	t.Parallel()
	trashSource := readRepositorySource(t, "task_trash_repository.go")
	helperSource := readRepositorySource(t, "task_location_whiteboard_purge_repository.go")
	queryLock := strings.Index(helperSource, "FOR UPDATE OF location_view")
	capture := strings.Index(helperSource, "set.BoardIDs = append(set.BoardIDs, boardID)")
	flagGate := strings.Index(helperSource, "if !workWhiteboardViewsEnabled {")
	reject := strings.Index(helperSource, "return nil, ErrTaskLocationViewDisabled")
	boardLock := strings.Index(helperSource, "lockWhiteboardRowsTx(")
	if queryLock < 0 || capture < 0 || flagGate < 0 || reject < 0 || boardLock < 0 ||
		!(queryLock < capture && capture < flagGate && flagGate < reject && reject < boardLock) {
		t.Fatal("contextual purge kill switch must reject from the transaction-locked set before any board deletion work")
	}

	functionBody := func(start, end string) string {
		t.Helper()
		startIndex := strings.Index(trashSource, start)
		endIndex := strings.Index(trashSource, end)
		if startIndex < 0 || endIndex <= startIndex {
			t.Fatalf("purge source bounds changed: %q -> %q", start, end)
		}
		return trashSource[startIndex:endIndex]
	}
	for _, test := range []struct {
		name, start, end string
	}{
		{"list", "func (r *TaskWorkRepository) PurgeList(", "func (r *TaskWorkRepository) PurgeFolder("},
		{"folder", "func (r *TaskWorkRepository) PurgeFolder(", "func (r *TaskWorkRepository) PurgeEnvironment("},
		{"environment", "func (r *TaskWorkRepository) PurgeEnvironment(", "func (r *TaskWorkRepository) ClaimTaskMediaGCJob("},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := functionBody(test.start, test.end)
			if !strings.Contains(body, "workWhiteboardViewsEnabled bool") ||
				!strings.Contains(body, "lockTaskLocationWhiteboardsForPurge(") ||
				!strings.Contains(body, "workWhiteboardViewsEnabled,") {
				t.Fatalf("%s purge can bypass the transaction-scoped Work whiteboard kill switch", test.name)
			}
			lockIndex := strings.Index(body, "lockTaskLocationWhiteboardsForPurge(")
			deleteIndex := strings.Index(body, "deleteTaskLocationWhiteboardsForPurge(")
			commitIndex := strings.Index(body, "tx.Commit(ctx)")
			if lockIndex < 0 || deleteIndex < 0 || commitIndex < 0 || !(lockIndex < deleteIndex && deleteIndex < commitIndex) {
				t.Fatalf("%s purge changed lock/check/delete/commit order", test.name)
			}
		})
	}
}
