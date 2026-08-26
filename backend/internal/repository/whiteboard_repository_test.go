package repository

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhiteboardAccessLevelsAreCumulative(t *testing.T) {
	t.Parallel()
	tests := []struct {
		level                                  string
		manage                                 bool
		view, comment, edit, remove, manageACL bool
	}{
		{level: domain.WhiteboardAccessNone},
		{level: domain.WhiteboardAccessView, view: true},
		{level: domain.WhiteboardAccessComment, view: true, comment: true},
		{level: domain.WhiteboardAccessEdit, view: true, comment: true, edit: true},
		{level: domain.WhiteboardAccessManage, manage: true, view: true, comment: true, edit: true, remove: true, manageACL: true},
	}
	for _, test := range tests {
		access := BuildWhiteboardEffectiveAccess(test.level, test.manage, "test")
		if access.CanView != test.view || access.CanComment != test.comment || access.CanEdit != test.edit || access.CanDelete != test.remove || access.CanManageAccess != test.manageACL {
			t.Fatalf("unexpected capabilities for %s: %#v", test.level, access)
		}
	}
	edit := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessEdit, false, "test")
	if !WhiteboardAccessAllows(edit, domain.WhiteboardAccessView) || !WhiteboardAccessAllows(edit, domain.WhiteboardAccessComment) || !WhiteboardAccessAllows(edit, domain.WhiteboardAccessEdit) || WhiteboardAccessAllows(edit, domain.WhiteboardAccessManage) {
		t.Fatalf("unexpected edit ordering: %#v", edit)
	}
	comment := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessComment, false, "test")
	if !WhiteboardAccessAllows(comment, domain.WhiteboardAccessView) || !comment.CanComment || comment.CanEdit || WhiteboardAccessAllows(comment, domain.WhiteboardAccessEdit) {
		t.Fatalf("unexpected comment ordering: %#v", comment)
	}
	invalid := BuildWhiteboardEffectiveAccess("full", true, "legacy")
	if invalid.Level != domain.WhiteboardAccessNone || invalid.CanView {
		t.Fatalf("legacy task access leaked into whiteboards: %#v", invalid)
	}
}

func TestWhiteboardAccessQueryPreservesHistoricalRowsForCanonicalLifecycleGate(t *testing.T) {
	t.Parallel()
	query := strings.Join(strings.Fields(strings.ToLower(whiteboardActorAccessQuery)), " ")
	if strings.Contains(query, "board.archived_at is null") {
		t.Fatalf("canonical RequireAccess query unexpectedly excludes archived boards: %q", query)
	}
	for _, invariant := range []string{
		"board.account_id=$1", "board.id=$3", "task_location_whiteboard_views",
		"task_location_views", "task_environment_grants", "task_folder_access_grants", "task_list_access_grants",
		"join accounts tenant_account", "coalesce(tenant_account.is_active,true)",
		"join subscriptions tenant_subscription", "tenant_subscription.status='active'",
		"tenant_subscription.status='trialing'", "tenant_subscription.status='grace'",
	} {
		if !strings.Contains(query, invariant) {
			t.Fatalf("canonical access query lost invariant %q: %q", invariant, query)
		}
	}
}

func TestWhiteboardCreationLocksCurrentTenantAuthorityBeforeStructure(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source directory")
	}
	directory := filepath.Dir(currentFile)
	for _, candidate := range []struct {
		file, function, next string
	}{
		{"whiteboard_repository.go", "func (r *WhiteboardRepository) CreateBoard(", "func scanWhiteboard"},
		{"whiteboard_duplicate_repository.go", "func (r *WhiteboardRepository) DuplicateBoard(", ""},
		{"task_location_view_repository.go", "func (r *TaskLocationViewRepository) Create(", "func (r *TaskLocationViewRepository) Update("},
		{"task_location_view_duplicate_repository.go", "func (r *TaskLocationViewRepository) Duplicate(", ""},
	} {
		raw, err := os.ReadFile(filepath.Join(directory, candidate.file))
		if err != nil {
			t.Fatal(err)
		}
		source := string(raw)
		start := strings.Index(source, candidate.function)
		if start < 0 {
			t.Fatalf("missing %s in %s", candidate.function, candidate.file)
		}
		end := len(source)
		if candidate.next != "" {
			if offset := strings.Index(source[start+1:], candidate.next); offset >= 0 {
				end = start + 1 + offset
			}
		}
		body := source[start:end]
		tenantLock := strings.Index(body, "lockActiveWhiteboardTenantTx")
		insertBoard := strings.Index(body, "INSERT INTO whiteboards")
		if tenantLock < 0 || insertBoard <= tenantLock {
			t.Fatalf("%s does not serialize tenant authority before creating a board", candidate.function)
		}
	}
}

func TestWhiteboardWorkAccessMappingNeverGrantsIndependentACL(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		taskLevel string
		want      string
	}{
		{domain.TaskAccessNone, domain.WhiteboardAccessNone},
		{domain.TaskAccessView, domain.WhiteboardAccessView},
		{domain.TaskAccessComment, domain.WhiteboardAccessComment},
		{domain.TaskAccessEdit, domain.WhiteboardAccessEdit},
		{domain.TaskAccessFull, domain.WhiteboardAccessManage},
	} {
		access := BuildWhiteboardEffectiveAccess(whiteboardTaskLevel(test.taskLevel), false, "work_test")
		if access.Level != test.want {
			t.Fatalf("task level %q mapped to %q, want %q", test.taskLevel, access.Level, test.want)
		}
		if access.CanManageAccess {
			t.Fatalf("contextual level %q unexpectedly manages independent grants", test.taskLevel)
		}
	}
}

func TestWhiteboardHubArchivedParentKeepsOnlyExplicitTrashRestoreCapability(t *testing.T) {
	t.Parallel()
	access := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessView, false, "work_archive")
	applyWhiteboardHubStructuralCapabilities(access, domain.WhiteboardOriginWork, domain.WhiteboardWorkLifecycleTrash, true)
	if access.Level != domain.WhiteboardAccessView || !access.CanView || access.CanComment || access.CanEdit || !access.CanDelete || access.CanManageAccess {
		t.Fatalf("archived Work content did not remain read-only with structural restore: %#v", access)
	}

	for _, test := range []struct {
		origin, lifecycle string
		canRestore        bool
	}{
		{domain.WhiteboardOriginStandalone, domain.WhiteboardWorkLifecycleTrash, true},
		{domain.WhiteboardOriginWork, domain.WhiteboardWorkLifecycleArchived, true},
		{domain.WhiteboardOriginWork, domain.WhiteboardWorkLifecycleTrash, false},
	} {
		candidate := BuildWhiteboardEffectiveAccess(domain.WhiteboardAccessView, false, "work_archive")
		applyWhiteboardHubStructuralCapabilities(candidate, test.origin, test.lifecycle, test.canRestore)
		if candidate.CanDelete {
			t.Fatalf("restore capability leaked for origin=%q lifecycle=%q allowed=%v", test.origin, test.lifecycle, test.canRestore)
		}
	}

	normalized := strings.Join(strings.Fields(strings.ToLower(whiteboardHubAccessCTE)), " ")
	for _, invariant := range []string{
		"view_deleted_at is null or archived_at is null then false",
		"environment_deleted_at is not null",
		"work_folder_deleted_at is not null",
		"work_list_deleted_at is not null",
		"else work_target_level='full'",
	} {
		if !strings.Contains(normalized, invariant) {
			t.Fatalf("Hub structural restore gate lost %q: %s", invariant, normalized)
		}
	}
}

func TestWhiteboardHubTreatsRemovedCreatorAsSharedHistory(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	if !whiteboardHubSharedWithActor(nil, actorID) {
		t.Fatal("a historical board with a removed creator disappeared from Compartidas")
	}
	if whiteboardHubSharedWithActor(&actorID, actorID) {
		t.Fatal("the current creator was classified as a shared recipient")
	}
	otherActorID := uuid.New()
	if !whiteboardHubSharedWithActor(&otherActorID, actorID) {
		t.Fatal("a board created by another actor was not classified as shared")
	}
}

func TestWhiteboardHubWorkOriginRequiresRealMembershipForRowsAndCounts(t *testing.T) {
	t.Parallel()
	normalized := strings.Join(strings.Fields(strings.ToLower(whiteboardHubAccessCTE)), " ")
	for _, invariant := range []string{
		"membership.user_id is not null and (",
		"as work_admin",
		"as has_work_modules",
		"work_identity.work_admin,work_identity.has_work_modules",
		"when work_identity.work_admin then 'full'",
		"when work_identity.work_admin then true",
		"when work_identity.work_admin then 'account_admin'",
	} {
		if !strings.Contains(normalized, invariant) {
			t.Fatalf("Hub Work membership gate lost %q: %s", invariant, normalized)
		}
	}
	if strings.Count(normalized, "membership.user_id is not null and (") < 2 {
		t.Fatal("Hub must bind both Work admin recovery and module access to a real membership")
	}
	// Preserve the legacy standalone compatibility predicate. It may admit a
	// standalone board through users.account_id, but the guarded Work identity
	// above must still resolve any contextual row to effective_level='none'.
	if !strings.Contains(normalized, "where board.account_id=$1 and (membership.user_id is not null or account_user.account_id=$1)") {
		t.Fatal("standalone legacy account compatibility changed while fixing Work membership")
	}

	repositorySource := readRepositorySource(t, "whiteboard_repository.go")
	listStart := strings.Index(repositorySource, "func (r *WhiteboardRepository) ListBoards(")
	countStart := strings.Index(repositorySource, "func (r *WhiteboardRepository) CountBoardScopes(")
	countEnd := strings.Index(repositorySource, "func whiteboardHubSharedWithActor(")
	if listStart < 0 || countStart <= listStart || countEnd <= countStart {
		t.Fatal("Hub list/count function bounds changed")
	}
	listBody := repositorySource[listStart:countStart]
	countBody := repositorySource[countStart:countEnd]
	for name, body := range map[string]string{"list": listBody, "count": countBody} {
		if !strings.Contains(body, "whiteboardHubAccessCTE") || !strings.Contains(body, "effective_level<>'none'") {
			t.Fatalf("Hub %s bypasses the membership-gated visible CTE", name)
		}
	}

	actorID := uuid.New()
	state := testWorkWhiteboardListState(actorID)
	state.Membership = false
	state.Permissions = []string{domain.PermTasks, domain.PermWhiteboards}
	access, location, err := resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.CanView || access.Level != domain.WhiteboardAccessNone || location != nil {
		t.Fatalf("canonical resolver admitted legacy admin without membership: access=%#v location=%#v err=%v", access, location, err)
	}
}

func testWorkWhiteboardListState(actorID uuid.UUID) *whiteboardActorAccessState {
	viewID, environmentID, listID := uuid.New(), uuid.New(), uuid.New()
	return &whiteboardActorAccessState{
		CreatedBy: actorIDPtr(actorID), AccessMode: domain.WhiteboardAccessAccount,
		Membership: true, MembershipRole: "user",
		TaskViewID: &viewID, EnvironmentID: &environmentID, ViewListID: &listID, ListID: &listID,
		EnvironmentName: "Entorno permitido", EnvironmentMode: "account", EnvironmentLevel: domain.TaskAccessView,
		ListName: "Lista permitida",
	}
}

func actorIDPtr(value uuid.UUID) *uuid.UUID { return &value }
func stringPtr(value string) *string        { return &value }
func boolPtr(value bool) *bool              { return &value }

func TestWhiteboardWorkAccessMatrixRequiresBothModulesAndMapsContainerLevel(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	levels := []struct {
		task, whiteboard string
	}{
		{domain.TaskAccessView, domain.WhiteboardAccessView},
		{domain.TaskAccessComment, domain.WhiteboardAccessComment},
		{domain.TaskAccessEdit, domain.WhiteboardAccessEdit},
		{domain.TaskAccessFull, domain.WhiteboardAccessManage},
	}
	permissionSets := []struct {
		name        string
		permissions []string
		allowed     bool
	}{
		{"both", []string{domain.PermTasks, domain.PermWhiteboards}, true},
		{"tasks only", []string{domain.PermTasks}, false},
		{"whiteboards only", []string{domain.PermWhiteboards}, false},
		{"neither", nil, false},
	}
	for _, permissionSet := range permissionSets {
		for _, level := range levels {
			state := testWorkWhiteboardListState(actorID)
			state.Permissions = permissionSet.permissions
			state.EnvironmentLevel = level.task
			access, location, err := resolveWhiteboardActorAccessState(state, actorID, true)
			if err != nil {
				t.Fatalf("%s/%s: %v", permissionSet.name, level.task, err)
			}
			if permissionSet.allowed {
				if access.Level != level.whiteboard || location == nil || !access.CanView || access.CanManageAccess {
					t.Fatalf("%s/%s resolved %#v location=%#v", permissionSet.name, level.task, access, location)
				}
			} else if access.Level != domain.WhiteboardAccessNone || access.CanView || location != nil {
				t.Fatalf("module bypass for %s/%s: %#v location=%#v", permissionSet.name, level.task, access, location)
			}
		}
	}
}

func TestWhiteboardWorkIgnoresCreatorGrantAndAccountVisibilityBypasses(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	state := testWorkWhiteboardListState(actorID)
	state.Permissions = []string{domain.PermTasks, domain.PermWhiteboards}
	state.EnvironmentMode = "private"
	state.EnvironmentLevel = domain.TaskAccessNone
	state.GrantLevel = stringPtr(domain.WhiteboardAccessManage)
	state.GrantManage = boolPtr(true)
	state.AccessMode = domain.WhiteboardAccessAccount
	// CreatedBy already points to actorID. All three standalone recovery paths
	// must be ignored once the canonical Work binding exists.
	access, location, err := resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil {
		t.Fatal(err)
	}
	if access.Level != domain.WhiteboardAccessNone || access.CanView || location == nil {
		t.Fatalf("standalone creator/grant/account visibility bypassed Work: %#v location=%#v", access, location)
	}

	state.EnvironmentGrant = stringPtr(domain.TaskAccessView)
	state.ListGrant = stringPtr(domain.TaskAccessFull)
	access, location, err = resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.Level != domain.WhiteboardAccessManage || access.CanManageAccess || location == nil {
		t.Fatalf("real Work grant did not govern access: %#v location=%#v err=%v", access, location, err)
	}

	state.Permissions = []string{domain.PermTasks}
	access, location, err = resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.CanView || location != nil {
		t.Fatalf("Work grant bypassed revoked Whiteboards module: %#v location=%#v err=%v", access, location, err)
	}
}

func TestWhiteboardWorkOriginIsExcludedFromShareAndGuestAuthority(t *testing.T) {
	t.Parallel()
	for name, predicate := range map[string]string{
		"board": whiteboardStandaloneBoardOriginSQL,
		"link":  whiteboardStandaloneShareLinkOriginSQL,
	} {
		normalized := strings.Join(strings.Fields(strings.ToLower(predicate)), " ")
		for _, invariant := range []string{"not exists", "task_location_whiteboard_views", "work_binding.account_id", "work_binding.whiteboard_id"} {
			if !strings.Contains(normalized, invariant) {
				t.Fatalf("%s guest/share origin predicate lost %q: %s", name, invariant, normalized)
			}
		}
	}
}

func TestWhiteboardWorkAdminRecoveryArchiveAndTrashRules(t *testing.T) {
	t.Parallel()
	actorID := uuid.New()
	state := testWorkWhiteboardListState(actorID)
	state.Permissions = nil
	state.EnvironmentMode = "private"
	state.MembershipRole = domain.RoleAdmin

	access, location, err := resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.Level != domain.WhiteboardAccessManage || !access.CanDelete || access.CanManageAccess || location == nil {
		t.Fatalf("account admin recovery failed: %#v location=%#v err=%v", access, location, err)
	}

	now := time.Now().UTC()
	state.EnvironmentArch = &now
	access, location, err = resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.Level != domain.WhiteboardAccessView || access.CanEdit || access.CanDelete || location == nil || location.Lifecycle != domain.WhiteboardWorkLifecycleArchived {
		t.Fatalf("archived parent was not capped to view: %#v location=%#v err=%v", access, location, err)
	}

	state.ViewDeletedAt, state.BoardArchivedAt = &now, &now
	access, location, err = resolveWhiteboardActorAccessState(state, actorID, true)
	if err != nil || access.Level != domain.WhiteboardAccessManage || !access.CanDelete || location == nil || location.Lifecycle != domain.WhiteboardWorkLifecycleTrash {
		t.Fatalf("explicit trash lost historical structural manage: %#v location=%#v err=%v", access, location, err)
	}

	state.EnvironmentTrash = &now
	if _, _, err := resolveWhiteboardActorAccessState(state, actorID, true); !errors.Is(err, ErrWhiteboardNotFound) {
		t.Fatalf("trashed parent did not hide child: %v", err)
	}
}

func TestWhiteboardGenericMetadataMutationRejectsWorkOrigin(t *testing.T) {
	t.Parallel()
	if err := requireStandaloneWhiteboardMutationLock(nil); err != nil {
		t.Fatalf("standalone mutation was rejected: %v", err)
	}
	if err := requireStandaloneWhiteboardMutationLock(&workWhiteboardMutationLock{ViewID: uuid.New()}); !errors.Is(err, ErrWhiteboardInheritsWorkAccess) {
		t.Fatalf("generic Work metadata mutation was not rejected explicitly: %v", err)
	}
}

func TestGenericStandaloneOnlyOperationsAuthorizeVisibilityBeforeOrigin(t *testing.T) {
	t.Parallel()
	tests := []struct {
		file, start, end, visibility, origin, specific string
	}{
		{
			file: "whiteboard_access_repository.go", start: "func (r *WhiteboardRepository) GetBoardAccessPolicy(",
			end: "func (r *WhiteboardRepository) ReplaceBoardAccess(", visibility: "r.RequireAccess(",
			origin: "requireStandaloneWhiteboardWith(", specific: "r.RequireManageAccess(",
		},
		{
			file: "whiteboard_share_repository.go", start: "func (r *WhiteboardRepository) ListShareLinks(",
			end: "func (r *WhiteboardRepository) RevokeShareLink(", visibility: "r.RequireAccess(",
			origin: "requireStandaloneWhiteboardWith(", specific: "r.RequireManageAccess(",
		},
		{
			file: "whiteboard_share_repository.go", start: "func (r *WhiteboardRepository) ListGuestSessions(",
			end: "func (r *WhiteboardRepository) RevokeGuestSession(", visibility: "r.RequireAccess(",
			origin: "requireStandaloneWhiteboardWith(", specific: "r.RequireManageAccess(",
		},
	}
	for _, test := range tests {
		body := whiteboardActorMutationBody(t, test.file, test.start, test.end)
		visibility := strings.Index(body, test.visibility)
		origin := strings.Index(body, test.origin)
		specific := strings.Index(body, test.specific)
		if visibility < 0 || origin <= visibility || specific <= origin {
			t.Fatalf("%s lost Ver -> origin -> action-specific authorization order", test.start)
		}
	}
}

func TestGenericStandaloneOnlyMutationsReauthorizeUnderLocksBeforeOriginAndWrite(t *testing.T) {
	t.Parallel()
	update := whiteboardActorMutationBody(t, "whiteboard_board_mutation_repository.go",
		"func (r *WhiteboardRepository) UpdateBoard(", "func (r *WhiteboardRepository) ArchiveBoard(")
	parent := strings.Index(update, "lockWorkWhiteboardParentViewTx(")
	board := strings.Index(update, "FROM whiteboards")
	boardLock := -1
	if board >= 0 {
		if relative := strings.Index(update[board:], "FOR UPDATE"); relative >= 0 {
			boardLock = board + relative
		}
	}
	view := strings.Index(update, "requireWhiteboardAccessTx(")
	origin := strings.Index(update, "requireStandaloneWhiteboardMutationLock(workLock)")
	edit := strings.LastIndex(update, "requireWhiteboardAccessTx(")
	write := strings.Index(update, "UPDATE whiteboards SET")
	if parent < 0 || board <= parent || boardLock <= board || view <= boardLock || origin <= view || edit <= origin || write <= edit {
		t.Fatal("metadata update lost parent/view -> board -> Ver -> origin -> Editar -> write order")
	}

	duplicate := whiteboardActorMutationBody(t, "whiteboard_duplicate_repository.go",
		"func (r *WhiteboardRepository) DuplicateBoard(", "")
	parent = strings.Index(duplicate, "lockWorkWhiteboardParentViewTx(")
	board = strings.Index(duplicate, "FROM whiteboards WHERE account_id=$1 AND id=$2 FOR SHARE")
	view = strings.Index(duplicate, "requireWhiteboardAccessTx(")
	origin = strings.Index(duplicate, "requireStandaloneWhiteboardMutationLock(workLock)")
	write = strings.Index(duplicate, "INSERT INTO whiteboards(")
	if parent < 0 || board <= parent || view <= board || origin <= view || write <= origin {
		t.Fatal("duplicate lost parent/view -> source -> Ver -> origin -> insert order")
	}

	access := whiteboardActorMutationBody(t, "whiteboard_access_repository.go",
		"func (r *WhiteboardRepository) ReplaceBoardAccess(", "")
	parent = strings.Index(access, "lockWorkWhiteboardParentViewTx(")
	board = strings.Index(access, "SELECT created_by,access_mode,access_revision FROM whiteboards")
	view = strings.Index(access, "requireWhiteboardAccessTx(")
	origin = strings.Index(access, "requireStandaloneWhiteboardMutationLock(workLock)")
	manage := strings.LastIndex(access, "requireWhiteboardAccessTx(")
	write = strings.Index(access, "DELETE FROM whiteboard_grants")
	if parent < 0 || board <= parent || view <= board || origin <= view || manage <= origin || write <= manage {
		t.Fatal("ACL replacement lost parent/view -> board -> Ver -> origin -> manage -> write order")
	}
}

func TestGlobalUserAuthorizationWritesBumpEveryWhiteboardRevisionTransactionally(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, bounds := range []struct{ start, end, mutation string }{
		{"func (r *UserRepository) UpdateWithAuthorityImpact", "func (r *UserRepository) UpdatePassword", "UPDATE users SET username"},
		{"func (r *UserRepository) ToggleActiveWithAuthorityImpact", "func lockUserAuthorizationAccountsTx", "UPDATE users SET is_active"},
	} {
		start := strings.Index(source, bounds.start)
		endOffset := strings.Index(source[start+1:], bounds.end)
		if start < 0 || endOffset < 0 {
			t.Fatalf("cannot bound %s", bounds.start)
		}
		body := source[start : start+1+endOffset]
		membershipLock := strings.Index(body, "lockUserAuthorizationAccountsTx")
		mutation := strings.Index(body, bounds.mutation)
		revision := strings.Index(body, "bumpAllWhiteboardAccessRevisionTx")
		commit := strings.LastIndex(body, "tx.Commit")
		if membershipLock < 0 || revision <= membershipLock || mutation <= revision || commit <= mutation {
			t.Fatalf("%s lost membership -> access_revision -> user -> commit order", bounds.start)
		}
	}
}

func TestWhiteboardArchiveAndRestoreAlwaysAdvanceAccessRevision(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve repository source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_board_mutation_repository.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, bounds := range []struct{ start, end string }{
		{"func (r *WhiteboardRepository) ArchiveBoard(", "func (r *WhiteboardRepository) RestoreBoard("},
		{"func (r *WhiteboardRepository) RestoreBoard(", ""},
	} {
		start := strings.Index(source, bounds.start)
		end := len(source)
		if bounds.end != "" {
			offset := strings.Index(source[start+1:], bounds.end)
			if offset < 0 {
				t.Fatalf("cannot bound %s", bounds.start)
			}
			end = start + 1 + offset
		}
		if start < 0 || end <= start {
			t.Fatalf("cannot bound %s", bounds.start)
		}
		body := source[start:end]
		if !strings.Contains(body, "access_revision=access_revision+1") {
			t.Fatalf("%s does not advance the board access revision", bounds.start)
		}
		if strings.Contains(body, "access_revision=access_revision+CASE") {
			t.Fatalf("%s still limits lifecycle revision changes by origin", bounds.start)
		}
	}
}

func TestWhiteboardActivityAcceptsOnlyBoundedObjectMetadata(t *testing.T) {
	t.Parallel()
	valid := WhiteboardActivityInput{
		AccountID: uuid.New(), BoardID: uuid.New(), Action: WhiteboardActivityUpdated,
		Details: json.RawMessage(`{"changed_fields":["name"]}`),
	}
	if _, err := validateWhiteboardActivityInput(valid); err != nil {
		t.Fatalf("valid activity rejected: %v", err)
	}
	valid.Action = "share.secret.exposed"
	if _, err := validateWhiteboardActivityInput(valid); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("unknown activity accepted: %v", err)
	}
	valid.Action = WhiteboardActivityUpdated
	valid.Details = json.RawMessage(`[]`)
	if _, err := validateWhiteboardActivityInput(valid); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("non-object activity metadata accepted: %v", err)
	}
}

func TestWhiteboardMutationsRequirePositiveExpectedVersion(t *testing.T) {
	t.Parallel()
	for _, version := range []int64{-1, 0} {
		if err := requireWhiteboardExpectedVersion(version); !errors.Is(err, ErrWhiteboardInvalid) {
			t.Fatalf("expected version %d was accepted: %v", version, err)
		}
	}
	if err := checkWhiteboardExpectedVersion(7, 8); !errors.Is(err, ErrWhiteboardConflict) {
		t.Fatalf("stale version was not a conflict: %v", err)
	}
	var conflict *WhiteboardConflictError
	if err := checkWhiteboardExpectedVersion(7, 8); !errors.As(err, &conflict) || conflict.CurrentVersion != 8 {
		t.Fatalf("conflict did not expose canonical version: %#v %v", conflict, err)
	}
	if err := checkWhiteboardExpectedVersion(8, 8); err != nil {
		t.Fatalf("canonical version was rejected: %v", err)
	}
}

func TestSharedLibraryEditorCannotPrivatizeLibrary(t *testing.T) {
	t.Parallel()
	if canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessEdit, domain.WhiteboardAccessAccount, domain.WhiteboardAccessPrivate) {
		t.Fatal("account-library editor could convert a shared library into a private library")
	}
	if !canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessEdit, domain.WhiteboardAccessAccount, domain.WhiteboardAccessAccount) {
		t.Fatal("account-library editor could not preserve visibility while editing content")
	}
	if !canChangeWhiteboardLibraryVisibility(domain.WhiteboardAccessManage, domain.WhiteboardAccessAccount, domain.WhiteboardAccessPrivate) {
		t.Fatal("library manager could not change visibility")
	}
}

func TestWhiteboardLibraryDescriptionIsBounded(t *testing.T) {
	t.Parallel()
	if !validWhiteboardLibraryDescription(string(bytes.Repeat([]byte("á"), 1000))) {
		t.Fatal("description at the documented rune limit was rejected")
	}
	if validWhiteboardLibraryDescription(string(bytes.Repeat([]byte("á"), 1001))) {
		t.Fatal("oversized library description was accepted")
	}
	if validWhiteboardLibraryDescription(string([]byte{0xff})) {
		t.Fatal("invalid UTF-8 library description was accepted")
	}
	if !validWhiteboardLibraryQuery(strings.Repeat("q", 200)) || validWhiteboardLibraryQuery(strings.Repeat("q", 201)) {
		t.Fatal("library search query limit is not enforced")
	}
}

func TestWhiteboardLibrarySummaryOmitsHeavyJSON(t *testing.T) {
	t.Parallel()
	summary := domain.WhiteboardLibrary{Name: "Catálogo", Description: "Resumen", ItemCount: 7, ContentSizeBytes: 8 * 1024 * 1024}
	encoded, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte("library_json")) || !bytes.Contains(encoded, []byte(`"item_count":7`)) {
		t.Fatalf("summary response exposed content or omitted cardinality: %s", encoded)
	}
}

func TestWhiteboardListScopesAreExplicit(t *testing.T) {
	t.Parallel()
	for _, scope := range []string{WhiteboardScopeAll, WhiteboardScopeMine, WhiteboardScopeRecent, WhiteboardScopeShared, WhiteboardScopeTrash, WhiteboardScopeWork} {
		if !validWhiteboardListScope(scope) {
			t.Fatalf("valid scope rejected: %s", scope)
		}
	}
	for _, scope := range []string{"", "archived", "account", "all OR 1=1"} {
		if validWhiteboardListScope(scope) {
			t.Fatalf("invalid scope accepted: %q", scope)
		}
	}
}
