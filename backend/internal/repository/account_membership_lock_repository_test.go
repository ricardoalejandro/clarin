package repository

import (
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func membershipLockFunctionBody(t *testing.T, source, startMarker, endMarker string) string {
	t.Helper()
	start := strings.Index(source, startMarker)
	if start < 0 {
		t.Fatalf("missing source marker %q", startMarker)
	}
	end := len(source)
	if endMarker != "" {
		relativeEnd := strings.Index(source[start+len(startMarker):], endMarker)
		if relativeEnd < 0 {
			t.Fatalf("missing end marker %q after %q", endMarker, startMarker)
		}
		end = start + len(startMarker) + relativeEnd
	}
	return source[start:end]
}

func TestCanonicalAccountMembershipUserIDsAreUniqueAndOrdered(t *testing.T) {
	t.Parallel()
	first := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	second := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	got := canonicalAccountMembershipUserIDs([]uuid.UUID{second, uuid.Nil, first, second})
	if len(got) != 2 || got[0] != first || got[1] != second {
		t.Fatalf("membership lock order is not canonical: %#v", got)
	}
}

func TestAccountMembershipLockUsesOrderedKeyShare(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "account_membership_lock_repository.go")
	body := membershipLockFunctionBody(t, source, "func lockAccountMembershipsKeyShareTx(", "")
	normalized := strings.Join(strings.Fields(body), " ")
	if !strings.Contains(normalized, "WHERE account_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR KEY SHARE") {
		t.Fatal("account membership lock lost account scope, stable UUID order or KEY SHARE")
	}
}

func TestTaskAccessReplacementLocksMembershipsBeforeResources(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_access_repository.go")
	body := membershipLockFunctionBody(t, source,
		"func (r *TaskWorkRepository) ReplaceAccessGrants(", "func taskActorAdminSQL(")
	membershipLock := strings.Index(body, "lockTaskActorAndMembershipsTx(")
	recipientCheck := strings.Index(body, "recipientIsMember")
	firstResourceBranch := strings.Index(body, "if targetType == domain.TaskAccessTargetEnvironment")
	revalidation := strings.Index(body, "SELECT COUNT(*) FROM user_accounts")
	if membershipLock < 0 || recipientCheck <= membershipLock ||
		firstResourceBranch <= recipientCheck || revalidation <= firstResourceBranch {
		t.Fatal("Task ACL replacement must lock and validate actor/recipient memberships before any resource, then revalidate in-transaction")
	}
}

func TestTaskActorMembershipLockRevalidatesLiveModuleAuthority(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_participant_access_repository.go")
	body := membershipLockFunctionBody(t, source,
		"func lockTaskActorAndMembershipsTx(", "// lockTaskParticipantMembershipsTx")
	authorityLock := strings.Index(body, "lockUserAuthorityTx(ctx, tx, actorID)")
	membershipLock := strings.Index(body, "lockAccountMembershipsKeyShareTx(")
	authorityRead := strings.Index(body, "account_user.is_active")
	authorityDecision := strings.Index(body, "taskActorMembershipAllows(")
	if authorityLock < 0 || membershipLock <= authorityLock || authorityRead <= membershipLock || authorityDecision <= authorityRead {
		t.Fatal("Work actor prelock lost authority advisory -> ordered membership KEY SHARE -> live PermTasks revalidation")
	}

	tests := []struct {
		name             string
		role             string
		permissions      []string
		active           bool
		globalSuperAdmin bool
		allowed          bool
	}{
		{name: "account admin", role: domain.RoleAdmin, active: true, allowed: true},
		{name: "account super admin", role: domain.RoleSuperAdmin, active: true, allowed: true},
		{name: "global super admin member", role: domain.RoleAgent, active: true, globalSuperAdmin: true, allowed: true},
		{name: "tasks agent", role: domain.RoleAgent, active: true, permissions: []string{domain.PermTasks}, allowed: true},
		{name: "all modules agent", role: domain.RoleAgent, active: true, permissions: []string{domain.PermAll}, allowed: true},
		{name: "inactive admin", role: domain.RoleAdmin},
		{name: "agent without tasks", role: domain.RoleAgent, active: true, permissions: []string{domain.PermWhiteboards}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := taskActorMembershipAllows(test.role, test.permissions, test.active, test.globalSuperAdmin); got != test.allowed {
				t.Fatalf("task membership authority=%v want=%v", got, test.allowed)
			}
		})
	}
}

func TestBoardAccessReplacementLocksEveryMembershipBeforeBoard(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "whiteboard_access_repository.go")
	body := membershipLockFunctionBody(t, source,
		"func (r *WhiteboardRepository) ReplaceBoardAccess(", "")
	replayPreflight := strings.Index(body, "SELECT EXISTS(SELECT 1 FROM whiteboard_access_audit")
	creatorDiscovery := strings.Index(body, "SELECT created_by FROM whiteboards")
	membershipSet := strings.Index(body, "relatedMembershipIDs = append(relatedMembershipIDs, requestedIDs...)")
	membershipLock := strings.Index(body, "lockWhiteboardActorMembershipsTx(")
	workParentLock := strings.Index(body, "lockWorkWhiteboardParentViewTx(")
	boardLock := strings.Index(body, "SELECT created_by,access_mode,access_revision FROM whiteboards")
	viewCheck := strings.Index(body, "requireWhiteboardAccessTx(ctx, tx")
	transactionalOriginCheck := strings.Index(body, "requireStandaloneWhiteboardMutationLock(workLock)")
	manageCheck := strings.LastIndex(body, "requireWhiteboardAccessTx(ctx, tx")
	replayCheck := strings.Index(body, "SELECT actor_id,request_payload_hash FROM whiteboard_access_audit")
	if replayPreflight < 0 || creatorDiscovery <= replayPreflight || membershipSet <= creatorDiscovery || membershipLock <= membershipSet ||
		workParentLock <= membershipLock || boardLock <= workParentLock || viewCheck <= boardLock || transactionalOriginCheck <= viewCheck || manageCheck <= transactionalOriginCheck {
		t.Fatal("board ACL replacement lost replay -> membership -> Work parent/view -> board -> Ver -> origin -> manage order")
	}
	if replayCheck <= manageCheck || !strings.Contains(body, "if !replayPreflight") {
		t.Fatal("board ACL replay must recheck the canonical audit while allowing a departed original recipient")
	}
}

func TestWhiteboardLibraryImportMutationsUseMembershipFirstOrder(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "whiteboard_library_import_repository.go")
	helper := membershipLockFunctionBody(t, source,
		"func lockWhiteboardLibraryImportViewAccessTx(", "func (r *WhiteboardRepository) StartWhiteboardLibraryImport(")
	membershipLock := strings.Index(helper, "lockWhiteboardActorMembershipsTx(")
	boardLock := strings.Index(helper, "SELECT TRUE FROM whiteboards")
	grantLock := strings.Index(helper, "SELECT id FROM whiteboard_grants")
	accessCheck := strings.Index(helper, "requireWhiteboardAccessTx(ctx, tx")
	if membershipLock < 0 || boardLock <= membershipLock || grantLock <= boardLock || accessCheck <= grantLock {
		t.Fatal("library import authorization lost live actor membership -> board -> direct grant -> access order")
	}

	start := membershipLockFunctionBody(t, source,
		"func (r *WhiteboardRepository) StartWhiteboardLibraryImport(", "func (r *WhiteboardRepository) RotateWhiteboardLibraryImportNavigation(")
	startAccess := strings.Index(start, "lockWhiteboardLibraryImportViewAccessTx(")
	startLifecycle := strings.Index(start, "SELECT archived_at FROM whiteboards")
	startInsert := strings.Index(start, "INSERT INTO whiteboard_library_import_sessions")
	if startAccess < 0 || startLifecycle <= startAccess || startInsert <= startLifecycle {
		t.Fatal("library import start must authorize with canonical locks before lifecycle validation and insert")
	}

	for _, mutation := range []struct {
		start string
		end   string
		write string
	}{
		{"func (r *WhiteboardRepository) RotateWhiteboardLibraryImportNavigation(", "func (r *WhiteboardRepository) ClaimWhiteboardLibraryImport(", "whiteboardLibraryImportNavigationSQL"},
		{"func (r *WhiteboardRepository) ClaimWhiteboardLibraryImport(", "func (r *WhiteboardRepository) MarkWhiteboardLibraryImportReady(", "whiteboardLibraryImportClaimSelectSQL"},
		{"func (r *WhiteboardRepository) MarkWhiteboardLibraryImportReady(", "func (r *WhiteboardRepository) MarkWhiteboardLibraryImportFailed(", "UPDATE whiteboard_library_import_sessions"},
		{"func (r *WhiteboardRepository) CompleteWhiteboardLibraryImport(", "", "FOR UPDATE"},
	} {
		body := membershipLockFunctionBody(t, source, mutation.start, mutation.end)
		lock := strings.Index(body, "lockWhiteboardLibraryImportViewAccessTx(")
		write := strings.Index(body, mutation.write)
		if lock < 0 || write <= lock {
			t.Fatalf("%s must lock/revalidate membership and board before %q", mutation.start, mutation.write)
		}
	}
}

func TestTaskParticipantGrantCallersLockMembershipsBeforeResources(t *testing.T) {
	t.Parallel()
	for _, mutation := range []struct {
		file       string
		start      string
		end        string
		preflight  string
		revalidate string
	}{
		{"task_repository.go", "func (r *TaskRepository) Create(", "func (r *TaskRepository) Update(", "", "taskParticipantsNeedingGrant("},
		{"task_repository.go", "func (r *TaskRepository) Update(", "func (r *TaskRepository) GetByID(", "", "taskParticipantsNeedingGrant("},
		{"task_work_repository.go", "func (r *TaskWorkRepository) SetCollaborators(", "func (r *TaskWorkRepository) ListCollaborators(", "SELECT assigned_to FROM tasks", "ownerID != observedOwnerID"},
		{"task_bulk_operations.go", "func (r *TaskWorkRepository) BulkUpdateTasks(", "func (r *TaskWorkRepository) BulkTrashTasks(", "", "taskParticipantsNeedingGrant("},
		{"task_environment_move_repository.go", "func (r *TaskWorkRepository) MoveTaskToEnvironment(", "", "SELECT participant.user_id", "taskParticipantIDSetsEqual(participants, currentParticipants)"},
	} {
		source := readRepositorySource(t, mutation.file)
		body := membershipLockFunctionBody(t, source, mutation.start, mutation.end)
		membershipLock := strings.Index(body, "lockTaskParticipantMembershipsTx(")
		firstResourceLock := strings.Index(body, "FOR UPDATE")
		revalidation := strings.LastIndex(body, mutation.revalidate)
		grantWrite := strings.Index(body, "confirmTaskParticipantGrants(")
		if mutation.file == "task_environment_move_repository.go" {
			grantWrite = strings.Index(body, "INSERT INTO task_access_grants")
		}
		if membershipLock < 0 || firstResourceLock <= membershipLock || revalidation <= firstResourceLock || grantWrite <= revalidation {
			t.Fatalf("%s lost membership -> resource -> revalidation -> participant grant order", mutation.start)
		}
		if mutation.preflight != "" {
			preflight := strings.Index(body, mutation.preflight)
			if preflight < 0 || preflight >= membershipLock {
				t.Fatalf("%s must discover mutable participant identity before the membership lock", mutation.start)
			}
		}
	}

	participantSource := readRepositorySource(t, "task_participant_access_repository.go")
	confirm := membershipLockFunctionBody(t, participantSource,
		"func confirmTaskParticipantGrants(", "")
	if strings.Contains(confirm, "lockAccountMembershipsKeyShareTx(") ||
		strings.Contains(confirm, "lockTaskParticipantMembershipsTx(") {
		t.Fatal("participant grant helper must not acquire memberships after callers already locked task resources")
	}
}

func TestMembershipRemovalRejectsWorkEventOrganizerHistoryBeforeMutatingACLs(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_membership_acl_repository.go")
	body := membershipLockFunctionBody(t, source, "func removeTaskMembershipACLTx(", "")
	membershipLock := strings.Index(body, "SELECT id FROM user_accounts")
	historyCheck := strings.Index(body, "SELECT EXISTS(SELECT 1 FROM work_events")
	typedConflict := strings.Index(body, "return ErrTaskMembershipOwnsEvents")
	firstACLWrite := strings.Index(body, "INSERT INTO task_access_audit")
	membershipDelete := strings.Index(body, "DELETE FROM user_accounts")
	if membershipLock < 0 || historyCheck <= membershipLock || typedConflict <= historyCheck ||
		firstACLWrite <= typedConflict || membershipDelete <= firstACLWrite {
		t.Fatal("membership removal lost membership lock -> organizer history conflict -> ACL writes -> membership delete order")
	}
}
