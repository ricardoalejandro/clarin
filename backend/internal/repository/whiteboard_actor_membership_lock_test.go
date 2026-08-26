package repository

import (
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func whiteboardActorMutationBody(t *testing.T, file, start, end string) string {
	t.Helper()
	source := readRepositorySource(t, file)
	startIndex := strings.Index(source, start)
	if startIndex < 0 {
		t.Fatalf("missing source boundary %q in %s", start, file)
	}
	endIndex := len(source)
	if end != "" {
		relativeEnd := strings.Index(source[startIndex+len(start):], end)
		if relativeEnd < 0 {
			t.Fatalf("missing end boundary %q after %q in %s", end, start, file)
		}
		endIndex = startIndex + len(start) + relativeEnd
	}
	return source[startIndex:endIndex]
}

func assertWhiteboardActorMutationOrder(t *testing.T, file, start, end string, markers ...string) {
	t.Helper()
	body := whiteboardActorMutationBody(t, file, start, end)
	previous := -1
	for _, marker := range markers {
		relative := strings.Index(body[previous+1:], marker)
		if relative < 0 {
			t.Fatalf("%s lost ordered mutation marker %q", start, marker)
		}
		current := previous + 1 + relative
		if current <= previous {
			t.Fatalf("%s mutation marker %q is out of order", start, marker)
		}
		previous = current
	}
}

func TestWhiteboardActorMembershipLockUsesAuthorityThenSharedMembershipHelper(t *testing.T) {
	t.Parallel()
	body := whiteboardActorMutationBody(t, "whiteboard_actor_membership_lock.go",
		"func lockWhiteboardActorMembershipsTx(", "func lockTaskLocationViewActorMembershipTx(")
	canonical := strings.Index(body, "canonicalAccountMembershipUserIDs(")
	authority := strings.Index(body, "lockUserAuthorityTx(")
	membership := strings.Index(body, "lockAccountMembershipsKeyShareTx(")
	cardinality := strings.Index(body, "len(locked) != len(actors)")
	authorityRead := strings.Index(body, "account_user.is_active")
	authorityDecision := strings.Index(body, "whiteboardActorMembershipAllows(")
	if canonical < 0 || authority <= canonical || membership <= authority || cardinality <= membership ||
		authorityRead <= cardinality || authorityDecision <= authorityRead {
		t.Fatalf("actor prelock lost canonical UUID -> authority advisory -> membership KEY SHARE -> exact membership -> live authority order")
	}
	if !strings.Contains(body, "return ErrWhiteboardNotFound") {
		t.Fatal("a missing account membership must remain indistinguishable from an inaccessible whiteboard")
	}
	for _, required := range []string{
		"COALESCE(account_user.is_super_admin,FALSE)", "membership.role",
		"COALESCE(role_item.permissions,'{}'::text[])",
		"requested := append([]uuid.UUID{actorID}, relatedMembershipIDs...)",
		"WHERE membership.account_id=$1 AND membership.user_id=$2",
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("actor authority revalidation lost %q", required)
		}
	}
	if strings.Contains(body, "lockWhiteboardAuthorityAccountTx(") {
		t.Fatal("actor membership helper must not invert contextual Work parent -> account barrier order")
	}

	wrapper := whiteboardActorMutationBody(t, "whiteboard_actor_membership_lock.go",
		"func lockTaskLocationViewActorMembershipTx(", "")
	for _, required := range []string{"lockWhiteboardActorMembershipsTx(", "ErrTaskWorkNotFound", "ErrTaskLocationViewInvalid"} {
		if !strings.Contains(wrapper, required) {
			t.Fatalf("task location membership wrapper lost %q", required)
		}
	}
}

func TestWhiteboardActorMembershipAuthorityMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name             string
		role             string
		permissions      []string
		active           bool
		globalSuperAdmin bool
		allowed          bool
	}{
		{name: "active account admin", role: domain.RoleAdmin, active: true, allowed: true},
		{name: "active account super admin", role: domain.RoleSuperAdmin, active: true, allowed: true},
		{name: "active global super admin member", role: domain.RoleAgent, active: true, globalSuperAdmin: true, allowed: true},
		{name: "active agent with module", role: domain.RoleAgent, active: true, permissions: []string{domain.PermWhiteboards}, allowed: true},
		{name: "active agent with all modules", role: domain.RoleAgent, active: true, permissions: []string{domain.PermAll}, allowed: true},
		{name: "inactive admin", role: domain.RoleAdmin},
		{name: "inactive global super admin", role: domain.RoleAgent, globalSuperAdmin: true},
		{name: "active agent without module", role: domain.RoleAgent, active: true},
		{name: "active agent with tasks only", role: domain.RoleAgent, active: true, permissions: []string{domain.PermTasks}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := whiteboardActorMembershipAllows(test.role, test.permissions, test.active, test.globalSuperAdmin); got != test.allowed {
				t.Fatalf("whiteboard membership authority=%v want=%v", got, test.allowed)
			}
		})
	}
}

func TestTaskLocationViewMutationsPrelockActorBeforeWorkAndDocumentRows(t *testing.T) {
	t.Parallel()
	assertWhiteboardActorMutationOrder(t, "task_location_view_repository.go",
		"func (r *TaskLocationViewRepository) Create(", "func (r *TaskLocationViewRepository) Update(",
		"lockActiveWhiteboardTenantTx(", "lockTaskLocationViewActorMembershipTx(",
		"requireTaskLocationManageTx(", "INSERT INTO whiteboards(", "INSERT INTO task_location_views(")
	assertWhiteboardActorMutationOrder(t, "task_location_view_duplicate_repository.go",
		"func (r *TaskLocationViewRepository) Duplicate(", "",
		"lockActiveWhiteboardTenantTx(", "lockTaskLocationViewActorMembershipTx(",
		"requireTaskLocationManageTx(", "readTaskLocationViewDuplicateState(ctx, tx, input.AccountID, input.SourceViewID, true)",
		"requireWorkWhiteboardAccessTx(", "INSERT INTO whiteboards(")

	update := whiteboardActorMutationBody(t, "task_location_view_repository.go",
		"func (r *TaskLocationViewRepository) Update(", "func (r *TaskLocationViewRepository) Trash(")
	updateActor := strings.Index(update, "lockTaskLocationViewActorMembershipTx(")
	updateParent := strings.Index(update, "requireTaskLocationManageTx(")
	updateRows := strings.Index(update, "readTaskLocationViewMutationState(ctx, tx, accountID, viewID, true)")
	updateReauth := strings.LastIndex(update, "requireWorkWhiteboardAccessTx(")
	updateWrite := strings.Index(update, "UPDATE task_location_views SET")
	if updateActor < 0 || updateParent <= updateActor || updateRows <= updateParent ||
		updateReauth <= updateRows || updateWrite <= updateReauth {
		t.Fatal("location-view update lost member -> Work parent/barrier -> view/board -> reauthorization -> write order")
	}

	lifecycle := whiteboardActorMutationBody(t, "task_location_view_repository.go",
		"func (r *TaskLocationViewRepository) setTrashState(", "")
	lifecycleActor := strings.Index(lifecycle, "lockTaskLocationViewActorMembershipTx(")
	lifecycleParent := strings.Index(lifecycle, "requireTaskLocationManageTx(")
	lifecycleRows := strings.Index(lifecycle, "readTaskLocationViewMutationState(ctx, tx, accountID, viewID, true)")
	lifecycleActiveReauth := strings.LastIndex(lifecycle, "requireWorkWhiteboardAccessTx(")
	lifecycleHistoricalReauth := strings.LastIndex(lifecycle, "requireWorkWhiteboardLifecycleAccessTx(")
	lifecycleWrite := strings.Index(lifecycle, "UPDATE task_location_views SET deleted_at=NOW()")
	if lifecycleActor < 0 || lifecycleParent <= lifecycleActor || lifecycleRows <= lifecycleParent ||
		lifecycleActiveReauth <= lifecycleRows || lifecycleHistoricalReauth <= lifecycleRows ||
		lifecycleWrite <= lifecycleActiveReauth || lifecycleWrite <= lifecycleHistoricalReauth {
		t.Fatal("location-view trash/restore lost member -> Work parent/barrier -> view/board -> lifecycle reauthorization -> write order")
	}
}

func TestStandaloneBoardCreationAndDuplicationPrelockMembershipBeforeResources(t *testing.T) {
	t.Parallel()
	assertWhiteboardActorMutationOrder(t, "whiteboard_repository.go",
		"func (r *WhiteboardRepository) CreateBoard(", "func (r *WhiteboardRepository) GetBoard(",
		"lockActiveWhiteboardTenantTx(", "lockWhiteboardActorMembershipsTx(",
		"lockWhiteboardHierarchyTx(", "INSERT INTO whiteboards(")
	assertWhiteboardActorMutationOrder(t, "whiteboard_duplicate_repository.go",
		"func (r *WhiteboardRepository) DuplicateBoard(", "",
		"lockActiveWhiteboardTenantTx(", "lockWhiteboardActorMembershipsTx(",
		"lockWhiteboardHierarchyTx(", "lockWorkWhiteboardParentViewTx(",
		"FROM whiteboards WHERE account_id=$1 AND id=$2 FOR SHARE",
		"requireWhiteboardAccessTx(", "requireStandaloneWhiteboardMutationLock(workLock)", "INSERT INTO whiteboards(")
	assertWhiteboardActorMutationOrder(t, "whiteboard_folder_repository.go",
		"func (r *WhiteboardRepository) CreateFolder(", "func (r *WhiteboardRepository) GetFolder(",
		"lockActiveWhiteboardTenantTx(", "lockWhiteboardActorMembershipsTx(",
		"lockWhiteboardHierarchyTx(", "INSERT INTO whiteboard_folders(")
	assertWhiteboardActorMutationOrder(t, "whiteboard_library_repository.go",
		"func (r *WhiteboardRepository) CreateLibrary(", "func (r *WhiteboardRepository) GetLibrary(",
		"lockActiveWhiteboardTenantTx(", "lockWhiteboardActorMembershipsTx(",
		"INSERT INTO whiteboard_libraries AS library(")
}

func TestBoardMetadataAndLifecycleMutationsReauthorizeAfterBoardLock(t *testing.T) {
	t.Parallel()
	for _, mutation := range []struct {
		start string
		end   string
		gate  string
	}{
		{"func (r *WhiteboardRepository) UpdateBoard(", "func (r *WhiteboardRepository) ArchiveBoard(", "requireWhiteboardAccessTx("},
		{"func (r *WhiteboardRepository) ArchiveBoard(", "func (r *WhiteboardRepository) RestoreBoard(", "requireWhiteboardAccessTx("},
		{"func (r *WhiteboardRepository) RestoreBoard(", "", "requireWorkWhiteboardLifecycleAccessTx("},
	} {
		body := whiteboardActorMutationBody(t, "whiteboard_board_mutation_repository.go", mutation.start, mutation.end)
		actor := strings.Index(body, "lockWhiteboardActorMembershipsTx(")
		parent := strings.Index(body, "lockWorkWhiteboardParentViewTx(")
		board := strings.Index(body, "FROM whiteboards")
		boardLock := -1
		if board >= 0 {
			boardLock = strings.Index(body[board:], "FOR UPDATE")
			if boardLock >= 0 {
				boardLock += board
			}
		}
		gate := strings.Index(body, mutation.gate)
		if actor < 0 || parent <= actor || board <= parent || boardLock <= board || gate <= boardLock {
			t.Fatalf("%s lost member -> Work parent/view -> board -> transactional access order", mutation.start)
		}
	}
}

func TestSceneAssetsAndCommentsLockActorBeforeDocumentAndDependentRows(t *testing.T) {
	t.Parallel()
	assertWhiteboardActorMutationOrder(t, "whiteboard_scene_repository.go",
		"func (r *WhiteboardRepository) writeScene(", "const whiteboardRestoreRevisionLockSQL",
		"lockWhiteboardActorMembershipsTx(", "lockWorkWhiteboardParentViewTx(",
		"FROM whiteboards", "FOR UPDATE", "requireWhiteboardAccessTx(", "INSERT INTO whiteboard_operations(")

	attach := whiteboardActorMutationBody(t, "whiteboard_asset_repository.go",
		"func (r *WhiteboardRepository) attachBoardAsset(", "func scanWhiteboardAsset(")
	actorConditional := strings.Index(attach, "if actorID != nil {")
	actorLock := strings.Index(attach, "lockWhiteboardActorMembershipsTx(")
	documentLock := strings.Index(attach, "lockActiveWhiteboardMutationRowsTx(")
	access := strings.Index(attach, "requireWhiteboardAccessTx(")
	dependent := strings.Index(attach, "FROM media_assets")
	if actorConditional < 0 || actorLock <= actorConditional || documentLock <= actorLock ||
		access <= documentLock || dependent <= access {
		t.Fatal("authenticated asset attach lost actor membership -> parent/view/board -> access -> asset row order")
	}
	if !strings.Contains(attach, "if guestTokenHash != \"\"") {
		t.Fatal("guest-only attachment path was accidentally folded into actor membership authority")
	}
	assertWhiteboardActorMutationOrder(t, "whiteboard_asset_repository.go",
		"func (r *WhiteboardRepository) DeleteBoardAsset(", "",
		"lockWhiteboardActorMembershipsTx(", "lockActiveWhiteboardMutationRowsTx(",
		"requireWhiteboardAccessTx(", "FROM whiteboard_assets", "FOR UPDATE")

	commentGate := whiteboardActorMutationBody(t, "whiteboard_comment_repository.go",
		"func requireActiveWhiteboardCommentAccessTx(", "func reserveWhiteboardCommentOperationTx(")
	rows := strings.Index(commentGate, "lockActiveWhiteboardMutationRowsTx(")
	commentAccess := strings.Index(commentGate, "requireWhiteboardAccessTx(")
	if rows < 0 || commentAccess <= rows {
		t.Fatal("comment access gate must lock parent/view/board before transactional authorization")
	}
	for _, mutation := range []struct{ start, end string }{
		{"func (r *WhiteboardRepository) CreateWhiteboardCommentThread(", "func (r *WhiteboardRepository) AddWhiteboardCommentReply("},
		{"func (r *WhiteboardRepository) AddWhiteboardCommentReply(", "func (r *WhiteboardRepository) EditWhiteboardComment("},
		{"func (r *WhiteboardRepository) EditWhiteboardComment(", "func (r *WhiteboardRepository) DeleteWhiteboardComment("},
		{"func (r *WhiteboardRepository) DeleteWhiteboardComment(", "func (r *WhiteboardRepository) UpdateWhiteboardCommentThreadStatus("},
		{"func (r *WhiteboardRepository) UpdateWhiteboardCommentThreadStatus(", ""},
	} {
		assertWhiteboardActorMutationOrder(t, "whiteboard_comment_repository.go", mutation.start, mutation.end,
			"lockWhiteboardActorMembershipsTx(", "requireActiveWhiteboardCommentAccessTx(",
			"reserveWhiteboardCommentOperationTx(")
	}
}

func TestShareTrashAndLibraryMutationsUseActorFirstOrder(t *testing.T) {
	t.Parallel()
	shareHelper := whiteboardActorMutationBody(t, "whiteboard_share_repository.go",
		"func requireStandaloneWhiteboardManageMutationTx(", "func (r *WhiteboardRepository) CreateShareLink(")
	shareParent := strings.Index(shareHelper, "lockWorkWhiteboardParentViewTx(")
	board := strings.Index(shareHelper, "FROM whiteboards")
	boardLock := -1
	if board >= 0 {
		boardLock = strings.Index(shareHelper[board:], "FOR UPDATE")
		if boardLock >= 0 {
			boardLock += board
		}
	}
	viewAccess := strings.Index(shareHelper, "requireWhiteboardAccessTx(")
	origin := strings.Index(shareHelper, "requireStandaloneWhiteboardMutationLock(workState)")
	manageAccess := strings.LastIndex(shareHelper, "requireWhiteboardAccessTx(")
	if shareParent < 0 || board <= shareParent || boardLock <= board || viewAccess <= boardLock || origin <= viewAccess || manageAccess <= origin {
		t.Fatal("share gate lost Work parent/view -> board -> Ver -> origin -> manage order")
	}
	for _, mutation := range []struct{ start, end, dependent string }{
		{"func (r *WhiteboardRepository) CreateShareLink(", "func (r *WhiteboardRepository) ListShareLinks(", "INSERT INTO whiteboard_share_links("},
		{"func (r *WhiteboardRepository) RevokeShareLink(", "func (r *WhiteboardRepository) GetActiveShareLinkByTokenHash(", "FROM whiteboard_share_links"},
		{"func (r *WhiteboardRepository) RevokeGuestSession(", "", "FROM whiteboard_guest_sessions"},
	} {
		assertWhiteboardActorMutationOrder(t, "whiteboard_share_repository.go", mutation.start, mutation.end,
			"lockWhiteboardActorMembershipsTx(", "requireStandaloneWhiteboardManageMutationTx(", mutation.dependent)
	}

	purge := whiteboardActorMutationBody(t, "whiteboard_trash_repository.go",
		"func (r *WhiteboardRepository) PurgeBoard(", "")
	account := strings.Index(purge, "FROM accounts")
	actor := strings.Index(purge, "lockWhiteboardActorMembershipsTx(")
	parent := strings.Index(purge, "lockWorkWhiteboardParentViewTx(")
	board = strings.Index(purge, "SELECT name,archived_at FROM whiteboards")
	workAccess := strings.Index(purge, "requireWorkWhiteboardLifecycleAccessTx(")
	standaloneAccess := strings.Index(purge, "requireWhiteboardAccountAdminTx(")
	if account < 0 || actor <= account || parent <= actor || board <= parent ||
		workAccess <= board || standaloneAccess <= workAccess {
		t.Fatal("purge lost account -> actor membership -> Work parent/view -> board -> origin-aware reauthorization order")
	}

	for _, mutation := range []struct{ file, start, end, resource string }{
		{"whiteboard_library_repository.go", "func (r *WhiteboardRepository) UpdateLibrary(", "func (r *WhiteboardRepository) ArchiveLibrary(", "requireWhiteboardLibraryMutationAccessTx("},
		{"whiteboard_library_repository.go", "func (r *WhiteboardRepository) ArchiveLibrary(", "", "requireWhiteboardLibraryMutationAccessTx("},
		{"whiteboard_library_asset_repository.go", "func (r *WhiteboardRepository) AttachLibraryAsset(", "func (r *WhiteboardRepository) ListLibraryAssets(", "requireWhiteboardLibraryMutationAccessTx("},
		{"whiteboard_library_asset_repository.go", "func (r *WhiteboardRepository) DeleteLibraryAsset(", "", "requireWhiteboardLibraryMutationAccessTx("},
	} {
		assertWhiteboardActorMutationOrder(t, mutation.file, mutation.start, mutation.end,
			"lockWhiteboardActorMembershipsTx(", mutation.resource)
	}
}
