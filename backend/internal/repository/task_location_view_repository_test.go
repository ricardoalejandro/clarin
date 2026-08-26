package repository

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/naperu/clarin/internal/domain"
)

func TestTaskLocationWhiteboardPurgeEligibilityUsesBothRetentionPolicies(t *testing.T) {
	t.Parallel()
	parentEligibleAt := time.Date(2026, time.August, 10, 12, 0, 0, 0, time.UTC)
	whiteboardDays := 30

	activeEligibleAt, err := taskLocationWhiteboardPurgeEligibleAt(parentEligibleAt, nil, nil, nil)
	if err != nil || !activeEligibleAt.Equal(parentEligibleAt) {
		t.Fatalf("an active contextual board must follow its parent: eligible_at=%s err=%v", activeEligibleAt, err)
	}

	viewDeletedAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	boardArchivedAt := time.Date(2026, time.August, 5, 12, 0, 0, 0, time.UTC)
	explicitEligibleAt, err := taskLocationWhiteboardPurgeEligibleAt(
		parentEligibleAt, &viewDeletedAt, &boardArchivedAt, &whiteboardDays,
	)
	wantExplicitEligibleAt := boardArchivedAt.Add(30 * 24 * time.Hour)
	if err != nil || !explicitEligibleAt.Equal(wantExplicitEligibleAt) {
		t.Fatalf("explicit deletion did not use its later deletion clock and whiteboard policy: eligible_at=%s want=%s err=%v",
			explicitEligibleAt, wantExplicitEligibleAt, err)
	}

	laterParentEligibleAt := wantExplicitEligibleAt.Add(24 * time.Hour)
	eligibleAt, err := taskLocationWhiteboardPurgeEligibleAt(
		laterParentEligibleAt, &viewDeletedAt, &boardArchivedAt, &whiteboardDays,
	)
	if err != nil || !eligibleAt.Equal(laterParentEligibleAt) {
		t.Fatalf("the later parent retention clock must win: eligible_at=%s want=%s err=%v", eligibleAt, laterParentEligibleAt, err)
	}

	if _, err := taskLocationWhiteboardPurgeEligibleAt(parentEligibleAt, &viewDeletedAt, nil, nil); !errors.Is(err, ErrTaskTrashDisabled) {
		t.Fatalf("an explicitly deleted board became purgeable while whiteboard purge is disabled: %v", err)
	}
}

func TestTaskTrashProjectionUsesTheCanonicalContextualRetentionClock(t *testing.T) {
	t.Parallel()
	parentLatestDeletedAt := time.Date(2026, time.August, 1, 12, 0, 0, 0, time.UTC)
	explicitWhiteboardDeletedAt := time.Date(2026, time.August, 5, 12, 0, 0, 0, time.UTC)
	taskDays, whiteboardDays := 7, 30
	now := time.Date(2026, time.August, 20, 12, 0, 0, 0, time.UTC)

	next, canPurge := taskContainerTrashEligibility(
		parentLatestDeletedAt, &taskDays, &whiteboardDays, &explicitWhiteboardDeletedAt, now,
	)
	want := explicitWhiteboardDeletedAt.Add(30 * 24 * time.Hour)
	if next == nil || !next.Equal(want) || canPurge {
		t.Fatalf("Trash advertised premature contextual purge: next=%v want=%s can_purge=%v", next, want, canPurge)
	}
	if next, canPurge = taskContainerTrashEligibility(parentLatestDeletedAt, &taskDays, &whiteboardDays, nil, now); next == nil ||
		!next.Equal(parentLatestDeletedAt.Add(7*24*time.Hour)) || !canPurge {
		t.Fatalf("a hidden or active contextual board must not change the visible Work retention clock: next=%v can_purge=%v", next, canPurge)
	}
	if next, canPurge = taskContainerTrashEligibility(
		parentLatestDeletedAt, &taskDays, nil, &explicitWhiteboardDeletedAt, now,
	); next != nil || canPurge {
		t.Fatalf("Trash advertised purge while whiteboard retention is disabled: next=%v can_purge=%v", next, canPurge)
	}
	if next, canPurge = taskContainerTrashEligibility(
		parentLatestDeletedAt, nil, &whiteboardDays, &explicitWhiteboardDeletedAt, now,
	); next != nil || canPurge {
		t.Fatalf("Trash advertised purge while Work retention is disabled: next=%v can_purge=%v", next, canPurge)
	}

	trashSource := readRepositorySource(t, "task_trash_repository.go")
	if count := strings.Count(trashSource,
		"MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $4::boolean AND `+taskTrashLocationViewCanViewSQL(\"location_view\", \"$2\")+`) AS latest_explicit_deleted_at"); count != 2 {
		t.Fatalf("folder/list Trash queries do not gate their two retention clocks exactly like their counts: count=%d", count)
	}
	if count := strings.Count(trashSource,
		"MAX(GREATEST(location_view.deleted_at,board.archived_at)) FILTER (WHERE $3::boolean AND `+taskTrashLocationViewCanViewSQL(\"location_view\", \"$2\")+`) AS latest_explicit_deleted_at"); count != 1 {
		t.Fatalf("environment Trash query does not gate its retention clock exactly like its count: count=%d", count)
	}
	if strings.Contains(trashSource,
		"MAX(GREATEST(location_view.deleted_at,board.archived_at)) AS latest_explicit_deleted_at") {
		t.Fatal("Trash still projects an ungated contextual retention clock")
	}
	if count := strings.Count(trashSource, "item.NextEligibleAt, item.CanPurge = taskContainerTrashEligibility("); count != 3 {
		t.Fatalf("folder/list/environment Trash projections diverged from canonical retention: count=%d", count)
	}
}

func TestTaskLocationViewLimitsAndArchivedCapabilities(t *testing.T) {
	t.Parallel()
	for input, expected := range map[int]int{-1: 50, 0: 50, 1: 1, 50: 50, 200: 200, 201: 200} {
		if actual := taskLocationViewLimit(input); actual != expected {
			t.Fatalf("limit %d resolved to %d, want %d", input, actual, expected)
		}
	}
	item := &domain.TaskLocationView{Lifecycle: domain.WhiteboardWorkLifecycleArchived}
	applyTaskLocationViewAccess(item, buildTaskEffectiveAccess(domain.TaskAccessFull, true, "test"))
	if !item.Capabilities.CanView || item.Capabilities.CanComment || item.Capabilities.CanEdit ||
		item.Capabilities.CanManage || item.Capabilities.CanManageAccess {
		t.Fatalf("archived parent was not capped to read-only: %#v", item.Capabilities)
	}
}

func TestTaskLocationModuleGateRequiresBothModulesUnlessAccountAdmin(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name        string
		role        string
		permissions []string
		superAdmin  bool
		allowed     bool
	}{
		{name: "both modules", role: domain.RoleAgent, permissions: []string{domain.PermTasks, domain.PermWhiteboards}, allowed: true},
		{name: "wildcard", role: domain.RoleAgent, permissions: []string{domain.PermAll}, allowed: true},
		{name: "tasks only", role: domain.RoleAgent, permissions: []string{domain.PermTasks}},
		{name: "whiteboards only", role: domain.RoleAgent, permissions: []string{domain.PermWhiteboards}},
		{name: "role admin recovery", role: domain.RoleAdmin, allowed: true},
		{name: "legacy admin mirror has no cross-account recovery", role: domain.RoleAgent},
		{name: "super admin recovery", role: domain.RoleAgent, superAdmin: true, allowed: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if actual := taskLocationModulesAllowed(test.role, test.permissions, test.superAdmin); actual != test.allowed {
				t.Fatalf("allowed=%v, want %v", actual, test.allowed)
			}
		})
	}
}

func TestValidateTaskLocationOperationReplayBindsActionAndPayload(t *testing.T) {
	t.Parallel()
	const payloadHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

	if err := validateTaskLocationOperationReplay("update", payloadHash, "update", payloadHash); err != nil {
		t.Fatalf("an exact idempotent replay was rejected: %v", err)
	}
	if err := validateTaskLocationOperationReplay("update", payloadHash, "trash", payloadHash); err != ErrTaskLocationViewConflict {
		t.Fatalf("an operation id reused for another action returned %v, want conflict", err)
	}
	if err := validateTaskLocationOperationReplay("update", payloadHash, "update",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"); err != ErrTaskLocationViewConflict {
		t.Fatalf("an operation id reused for another canonical payload returned %v, want conflict", err)
	}
}

func TestTaskLocationViewMutationContractKeepsCanonicalACLAndLockOrder(t *testing.T) {
	t.Parallel()
	repositorySource := readRepositorySource(t, "task_location_view_repository.go")
	duplicateSource := readRepositorySource(t, "task_location_view_duplicate_repository.go")

	for _, invariant := range []string{
		"ResolveWorkWhiteboardAccess(ctx, accountID, actorID",
		"getOperationResult(ctx, accountID, actorID, viewID)",
		"environment.archived_at IS NOT NULL OR location_folder.archived_at IS NOT NULL",
		"storageTag.RowsAffected() != 1",
		"insertTaskLocationViewOperationTx",
		"access_revision=access_revision+1",
	} {
		if !strings.Contains(repositorySource, invariant) {
			t.Fatalf("location view repository lost invariant %q", invariant)
		}
	}
	if strings.Contains(repositorySource, "INSERT INTO whiteboard_grants") || strings.Contains(duplicateSource, "INSERT INTO whiteboard_grants") {
		t.Fatal("contextual creation must not create standalone whiteboard grants")
	}

	discoverIndex := strings.Index(duplicateSource, "readTaskLocationViewDuplicateState(ctx, tx, input.AccountID, input.SourceViewID, false)")
	parentIndex := strings.Index(duplicateSource, "requireTaskLocationManageTx(ctx, tx, input.AccountID, input.ActorID")
	childIndex := strings.Index(duplicateSource, "readTaskLocationViewDuplicateState(ctx, tx, input.AccountID, input.SourceViewID, true)")
	if discoverIndex < 0 || parentIndex < 0 || childIndex < 0 || !(discoverIndex < parentIndex && parentIndex < childIndex) {
		t.Fatal("duplicate must discover without locks, then lock parent before view and board")
	}
	viewLockIndex := strings.Index(duplicateSource, "viewQuery += ` FOR UPDATE OF view_item`")
	boardLockIndex := strings.Index(duplicateSource, "boardQuery += ` FOR UPDATE`")
	if viewLockIndex < 0 || boardLockIndex < 0 || viewLockIndex > boardLockIndex {
		t.Fatal("duplicate lock helper must lock the contextual view before the whiteboard")
	}
	for _, invariant := range []string{
		"inserted.RowsAffected() != 1",
		"storageTag.RowsAffected() != 1",
		"current.Version != input.ExpectedVersion",
		"string(current.Scene) != string(input.Scene)",
	} {
		if !strings.Contains(duplicateSource, invariant) {
			t.Fatalf("duplicate lost atomic validation %q", invariant)
		}
	}
}

func TestTaskLocationViewMutationLocksParentThenAuthorityBarrierAndRevalidates(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_location_view_repository.go")

	activeStart := strings.Index(source, "func requireTaskLocationManageTx(")
	activeEnd := strings.Index(source[activeStart:], "func taskLocationScopeColumns(")
	if activeStart < 0 || activeEnd < 0 {
		t.Fatal("active contextual authorization helper bounds changed")
	}
	active := source[activeStart : activeStart+activeEnd]
	firstResolve := strings.Index(active, "resolveContainerAccessWith(")
	parentLock := strings.Index(active, "lockActiveTaskLocationTx(")
	barrier := strings.Index(active, "lockWhiteboardAuthorityAccountTx(")
	lastResolve := strings.LastIndex(active, "resolveContainerAccessWith(")
	lastModules := strings.LastIndex(active, "requireTaskLocationModulesWith(")
	if firstResolve < 0 || parentLock <= firstResolve || barrier <= parentLock ||
		lastModules <= barrier || lastResolve <= barrier || lastResolve == firstResolve {
		t.Fatal("active contextual mutation must preflight, lock parent, join the account barrier, then revalidate modules and ACL")
	}

	historicalStart := strings.Index(source, "func requireHistoricalTaskLocationManageTx(")
	historicalEnd := strings.Index(source[historicalStart:], "func requireTaskLocationManageTx(")
	if historicalStart < 0 || historicalEnd < 0 {
		t.Fatal("historical contextual authorization helper bounds changed")
	}
	historical := source[historicalStart : historicalStart+historicalEnd]
	firstHistoricalResolve := strings.Index(historical, "resolveHistoricalTaskLocationAccessWith(")
	parentHistoricalLock := strings.Index(historical, "FOR SHARE OF")
	historicalBarrier := strings.Index(historical, "lockWhiteboardAuthorityAccountTx(")
	lastHistoricalResolve := strings.LastIndex(historical, "resolveHistoricalTaskLocationAccessWith(")
	if firstHistoricalResolve < 0 || parentHistoricalLock <= firstHistoricalResolve ||
		historicalBarrier <= parentHistoricalLock || lastHistoricalResolve <= historicalBarrier ||
		lastHistoricalResolve == firstHistoricalResolve {
		t.Fatal("historical restore must preflight, lock parent, join the account barrier, then revalidate")
	}
}

func TestTaskListReparentInvalidatesContextualWhiteboardsInsideTheTransaction(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_work_repository.go")
	start := strings.Index(source, "func (r *TaskWorkRepository) UpdateListLocation")
	end := strings.Index(source, "func (r *TaskWorkRepository) ReorderFolder")
	if start < 0 || end <= start {
		t.Fatal("UpdateListLocation source bounds changed")
	}
	mutation := source[start:end]
	changeIndex := strings.Index(mutation, "locationChanged := !taskUUIDPointersEqual(currentFolderID, finalFolderID)")
	updateIndex := strings.Index(mutation, "UPDATE task_lists SET folder_id=$3")
	gateIndex := strings.Index(mutation, "if locationChanged {")
	bumpIndex := strings.Index(mutation, "bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(")
	commitIndex := strings.Index(mutation, "if err := tx.Commit(ctx); err != nil")
	if changeIndex < 0 || updateIndex < 0 || gateIndex < 0 || bumpIndex < 0 || commitIndex < 0 ||
		!(changeIndex < updateIndex && updateIndex < gateIndex && gateIndex < bumpIndex && bumpIndex < commitIndex) {
		t.Fatal("list reparenting must bump and return contextual whiteboard revisions after the list mutation and before commit")
	}
}

func TestReplaceAccessGrantsReturnsExactCommittedWhiteboardInvalidations(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_access_repository.go")
	start := strings.Index(source, "func (r *TaskWorkRepository) ReplaceAccessGrants(")
	end := strings.Index(source, "func taskActorAdminSQL(")
	if start < 0 || end <= start {
		t.Fatal("ReplaceAccessGrants source bounds changed")
	}
	mutation := source[start:end]
	bumpIndex := strings.Index(mutation, "bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx(")
	readbackIndex := strings.Index(mutation, "listAccessGrantsWith(ctx, tx")
	commitIndex := strings.Index(mutation, "tx.Commit(ctx)")
	effectsIndex := strings.Index(mutation, "effects[0].WhiteboardIDs =")
	if bumpIndex < 0 || readbackIndex < 0 || commitIndex < 0 || effectsIndex < 0 ||
		!(bumpIndex < readbackIndex && readbackIndex < commitIndex && commitIndex < effectsIndex) {
		t.Fatal("ACL replacement must capture and read back in its transaction, commit, then expose the exact invalidation set")
	}
	if strings.Contains(mutation, "bumpTaskLocationWhiteboardAccessRevisionTx(") ||
		strings.Contains(mutation, "r.ListAccessGrants(") ||
		strings.Contains(mutation, "WorkWhiteboardIDsForAccessTarget(") {
		t.Fatal("ACL replacement retained a discarded or post-commit re-queried contextual whiteboard set")
	}
}
