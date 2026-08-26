package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func globalAuthoritySource(t *testing.T, name string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func boundedGlobalAuthorityFunction(t *testing.T, source, start, end string) string {
	t.Helper()
	startIndex := strings.Index(source, start)
	if startIndex < 0 {
		t.Fatalf("missing function boundary %q", start)
	}
	endIndex := len(source)
	if end != "" {
		offset := strings.Index(source[startIndex+1:], end)
		if offset < 0 {
			t.Fatalf("missing function boundary %q", end)
		}
		endIndex = startIndex + 1 + offset
	}
	return source[startIndex:endIndex]
}

func TestTenantAuthorityBumpLocksViewsThenEveryBoardAndAdvancesBoth(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "whiteboard_global_authority_repository.go")
	body := boundedGlobalAuthorityFunction(t, source,
		"func bumpAllWhiteboardAccessRevisionTx", "")
	viewLock := strings.Index(body, "SELECT id FROM task_location_views")
	boardLock := strings.Index(body, "SELECT id FROM whiteboards")
	viewUpdate := strings.Index(body, "UPDATE task_location_views SET")
	boardUpdate := strings.Index(body, "UPDATE whiteboards SET")
	if viewLock < 0 || boardLock <= viewLock || viewUpdate <= boardLock || boardUpdate <= viewUpdate {
		t.Fatalf("global authority lock/update order changed: viewLock=%d boardLock=%d viewUpdate=%d boardUpdate=%d",
			viewLock, boardLock, viewUpdate, boardUpdate)
	}
	for _, required := range []string{
		"WHERE account_id=$1 ORDER BY id FOR UPDATE",
		"access_revision=access_revision+1",
		"WHERE account_id=$1 AND id=ANY($2::uuid[])",
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("global authority bump lost %q", required)
		}
	}
	if strings.Contains(body, "JOIN task_location_whiteboard_views") {
		t.Fatal("global board invalidation is still restricted to Work bindings")
	}
	if strings.Contains(body, "updated_at") {
		t.Fatal("authority-only revision invalidation must not falsify document recency")
	}
}

func TestEveryGlobalAuthorityRepositoryMutationBumpsBeforeCommit(t *testing.T) {
	t.Parallel()
	repositorySource := globalAuthoritySource(t, "repository.go")
	mutations := []struct {
		start, end, durableWrite string
	}{
		{"func (r *UserRepository) UpdateWithAuthorityImpact", "func (r *UserRepository) UpdatePassword", "UPDATE users SET username"},
		{"func (r *UserRepository) ToggleActiveWithAuthorityImpact", "func lockUserAuthorizationAccountsTx", "UPDATE users SET is_active"},
		{"func (r *UserAccountRepository) AssignAndNormalize", "func assignUserAccountTx", "assignUserAccountTx"},
		{"func (r *AccountRepository) ToggleActive", "func (r *AccountRepository) Delete", "UPDATE accounts SET is_active"},
		{"func (r *RoleRepository) UpdateWithAuthorityImpact", "func (r *RoleRepository) Delete", "UPDATE roles SET"},
		{"func (r *RoleRepository) DeleteWithAuthorityImpact", "func roleAuthorityImpactTx", "DELETE FROM roles"},
	}
	for _, mutation := range mutations {
		body := boundedGlobalAuthorityFunction(t, repositorySource, mutation.start, mutation.end)
		write := strings.Index(body, mutation.durableWrite)
		bump := strings.Index(body, "bumpAllWhiteboardAccessRevisionTx")
		commit := strings.LastIndex(body, "tx.Commit")
		if write < 0 || bump < 0 || commit <= bump {
			t.Fatalf("%s does not atomically write, bump all boards, then commit", mutation.start)
		}
	}

	membershipSource := globalAuthoritySource(t, "task_membership_acl_repository.go")
	removeBody := boundedGlobalAuthorityFunction(t, membershipSource, "func removeTaskMembershipACLTx", "")
	if bump := strings.Index(removeBody, "bumpAllWhiteboardAccessRevisionTx"); bump < 0 || strings.Index(removeBody, "DELETE FROM user_accounts") <= bump {
		t.Fatal("membership removal must bump every board before deleting the assignment")
	}

	createSource := globalAuthoritySource(t, "admin_user_repository.go")
	createBody := boundedGlobalAuthorityFunction(t, createSource, "func (r *UserRepository) CreateWithAccountsAndAuthorityImpact", "")
	if strings.Index(createBody, "bumpAllWhiteboardAccessRevisionTx") < strings.Index(createBody, "INSERT INTO user_accounts") ||
		strings.LastIndex(createBody, "tx.Commit") < strings.Index(createBody, "bumpAllWhiteboardAccessRevisionTx") ||
		strings.LastIndex(createBody, "WhiteboardAuthorityMutationEffect{AccountIDs: accountIDs") < strings.LastIndex(createBody, "tx.Commit") {
		t.Fatal("multi-account user creation does not bump affected boards transactionally")
	}
}

func TestRoleAuthorityImpactIsCapturedAfterRoleLockAndReturnedFromCommit(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "repository.go")
	for _, bounds := range []struct{ start, end, mutation string }{
		{"func (r *RoleRepository) UpdateWithAuthorityImpact", "func (r *RoleRepository) Delete", "UPDATE roles SET"},
		{"func (r *RoleRepository) DeleteWithAuthorityImpact", "func roleAuthorityImpactTx", "DELETE FROM roles"},
	} {
		body := boundedGlobalAuthorityFunction(t, source, bounds.start, bounds.end)
		roleLock := strings.Index(body, "FROM roles WHERE id=$1 FOR UPDATE")
		impact := strings.Index(body, "roleAuthorityImpactTx")
		mutation := strings.Index(body, bounds.mutation)
		commit := strings.Index(body, "tx.Commit")
		returned := strings.LastIndex(body, "WhiteboardAuthorityMutationEffect{AccountIDs: accountIDs, UserIDs: userIDs}")
		if roleLock < 0 || impact <= roleLock || mutation <= impact || commit <= mutation || returned <= commit {
			t.Fatalf("%s lost role lock -> exact impact -> mutation -> commit -> effect order", bounds.start)
		}
	}
}

func TestUserAuthorityMutationsShareTransactionAdvisoryLock(t *testing.T) {
	t.Parallel()
	globalSource := globalAuthoritySource(t, "whiteboard_global_authority_repository.go")
	if !strings.Contains(globalSource, "pg_advisory_xact_lock") || !strings.Contains(globalSource, "hashtextextended") {
		t.Fatal("user authority lock is not transaction-scoped and stable")
	}
	repositorySource := globalAuthoritySource(t, "repository.go")
	for _, marker := range []string{
		"func (r *UserRepository) UpdateWithAuthorityImpact",
		"func (r *UserRepository) ToggleActiveWithAuthorityImpact",
		"func (r *UserRepository) deleteWithTaskACLActor",
		"func (r *UserAccountRepository) AssignAndNormalize",
		"func (r *UserAccountRepository) removeAndNormalize",
	} {
		body := boundedGlobalAuthorityFunction(t, repositorySource, marker, "func ")
		if !strings.Contains(body, "lockUserAuthorityTx") {
			t.Fatalf("%s bypasses the user authority serializer", marker)
		}
	}
}

func TestAccountPurgeCapturesRelocatesAndInvalidatesBeforeCommit(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "account_purge_repository.go")
	body := boundedGlobalAuthorityFunction(t, source, "func (r *AccountRepository) PurgeWithAuthorityImpact", "")
	accountLock := strings.Index(body, "SELECT id,name FROM accounts WHERE id=$1 FOR UPDATE")
	userCapture := strings.Index(body, "SELECT affected.user_id")
	userAuthorityLock := strings.Index(body, "lockUserAuthorityTx")
	membershipLock := strings.Index(body, "ORDER BY membership.account_id FOR UPDATE")
	membershipDefaultClear := strings.Index(body, "UPDATE user_accounts SET is_default=FALSE")
	bump := strings.Index(body, "bumpAllWhiteboardAccessRevisionTx")
	userMirror := strings.Index(body, "UPDATE users SET account_id=$2,role=$3")
	scopedTreePurge := strings.Index(body, "purgeAccountScopedRowsTx")
	membershipDelete := strings.Index(body, "DELETE FROM user_accounts WHERE account_id=$1")
	exclusiveUserDelete := strings.Index(body, "DELETE FROM users WHERE id=ANY($1::uuid[])")
	accountDelete := strings.Index(body, "DELETE FROM accounts WHERE id=$1")
	commit := strings.Index(body, "tx.Commit")
	returned := strings.LastIndex(body, "WhiteboardAuthorityMutationEffect{AccountIDs: accountIDs, UserIDs: userIDs}")
	if accountLock < 0 || userCapture <= accountLock || userAuthorityLock <= userCapture ||
		membershipLock <= userAuthorityLock || membershipDefaultClear <= membershipLock || bump <= membershipDefaultClear ||
		userMirror <= bump || scopedTreePurge <= userMirror || membershipDelete <= scopedTreePurge ||
		exclusiveUserDelete <= membershipDelete || accountDelete <= exclusiveUserDelete || commit <= accountDelete || returned <= commit {
		t.Fatalf("purge authority order changed: account=%d users=%d advisory=%d membership=%d defaultClear=%d bump=%d mirror=%d tree=%d membershipDelete=%d userDelete=%d delete=%d commit=%d return=%d",
			accountLock, userCapture, userAuthorityLock, membershipLock, membershipDefaultClear, bump, userMirror,
			scopedTreePurge, membershipDelete, exclusiveUserDelete, accountDelete, commit, returned)
	}
	if strings.Index(body, "lockedAccountName != expectedName") <= accountLock ||
		!strings.Contains(body, "ErrAccountPurgeConfirmation") {
		t.Fatal("account purge must revalidate the exact confirmation name under the account row lock")
	}
	for _, required := range []string{
		"is_admin=(is_super_admin OR $3::varchar IN ('admin','super_admin'))",
		"UPDATE user_accounts SET is_default=(account_id=$2)",
		"canonicalAuthorityUUIDs(accountIDs)",
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("purge lost relocation invariant %q", required)
		}
	}
	if strings.Contains(body, "is_super_admin=(is_super_admin OR $3::varchar='super_admin')") {
		t.Fatal("an account-scoped super_admin membership must not promote global super-admin authority")
	}
}

func TestAccountScopedResolversNeverAuthorizeFromLegacyUserAdmin(t *testing.T) {
	t.Parallel()
	for _, file := range []string{
		"task_access_repository.go",
		"task_environment_repository.go",
		"task_acl_edge_repository.go",
		"task_location_view_repository.go",
		"work_event_repository.go",
		"whiteboard_work_context_repository.go",
	} {
		source := strings.ToLower(globalAuthoritySource(t, file))
		for _, forbidden := range []string{
			"account_user.is_admin", "actor.is_admin", "environment_user.is_admin",
			"coalesce(account_user.is_admin", "coalesce(actor_user.is_admin",
		} {
			if strings.Contains(source, forbidden) {
				t.Fatalf("%s still authorizes through legacy users.is_admin (%q)", file, forbidden)
			}
		}
	}
}

func TestWhiteboardAuthorityInvalidationsShareAccountBarrier(t *testing.T) {
	t.Parallel()
	globalSource := globalAuthoritySource(t, "whiteboard_global_authority_repository.go")
	barrierBody := boundedGlobalAuthorityFunction(t, globalSource,
		"func lockWhiteboardAuthorityAccountTx", "func lockRoleAuthorityReferenceTx")
	if !strings.Contains(barrierBody, "pg_advisory_xact_lock") ||
		!strings.Contains(barrierBody, "hashtextextended($1::text,731943)") {
		t.Fatal("account authority barrier must be transaction-scoped and namespaced")
	}
	bumpAll := boundedGlobalAuthorityFunction(t, globalSource,
		"func bumpAllWhiteboardAccessRevisionTx", "")
	barrier := strings.Index(bumpAll, "lockWhiteboardAuthorityAccountTx")
	viewEnumeration := strings.Index(bumpAll, "FROM task_location_views")
	boardEnumeration := strings.Index(bumpAll, "FROM whiteboards")
	if barrier < 0 || viewEnumeration <= barrier || boardEnumeration <= viewEnumeration {
		t.Fatal("global invalidation must join the account barrier before enumerating contextual views and boards")
	}

	lifecycleSource := globalAuthoritySource(t, "task_location_whiteboard_lifecycle_repository.go")
	bumpScoped := boundedGlobalAuthorityFunction(t, lifecycleSource,
		"func bumpTaskLocationWhiteboardAccessRevisionReturningIDsTx", "")
	barrier = strings.Index(bumpScoped, "lockWhiteboardAuthorityAccountTx")
	viewEnumeration = strings.Index(bumpScoped, "FROM task_location_views")
	if barrier < 0 || viewEnumeration <= barrier {
		t.Fatal("Work ACL/lifecycle invalidation must join the account barrier before enumerating contextual views")
	}
}

func TestRoleAssignmentsSerializeBeforeRoleImpactSnapshot(t *testing.T) {
	t.Parallel()
	globalSource := globalAuthoritySource(t, "whiteboard_global_authority_repository.go")
	referenceLock := boundedGlobalAuthorityFunction(t, globalSource,
		"func lockRoleAuthorityReferenceTx", "func bumpAllWhiteboardAccessRevisionTx")
	if !strings.Contains(referenceLock, "FROM roles WHERE id=$1 FOR KEY SHARE") {
		t.Fatal("role assignment reference lock must block behind role update/delete")
	}

	repositorySource := globalAuthoritySource(t, "repository.go")
	for _, mutation := range []struct {
		start, end, durableWrite string
	}{
		{"func (r *UserAccountRepository) AssignAndNormalize", "func assignUserAccountTx", "assignUserAccountTx"},
	} {
		body := boundedGlobalAuthorityFunction(t, repositorySource, mutation.start, mutation.end)
		roleLock := strings.Index(body, "lockRoleAuthorityReferenceTx")
		userLock := strings.Index(body, "lockUserAuthorityTx")
		write := strings.Index(body, mutation.durableWrite)
		if roleLock < 0 || userLock <= roleLock || write <= userLock {
			t.Fatalf("%s lost role reference -> user serializer -> membership mutation order", mutation.start)
		}
	}

	impact := boundedGlobalAuthorityFunction(t, repositorySource,
		"func roleAuthorityImpactTx", "")
	if !strings.Contains(impact, "WHERE role_id=$1 ORDER BY account_id,user_id FOR UPDATE") {
		t.Fatal("role authority impact snapshot must lock every affected assignment")
	}
}

func TestSubscriptionAuthorityWriteBumpsEveryBoardInSameTransaction(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "subscription_repository.go")
	body := boundedGlobalAuthorityFunction(t, source, "func (r *SubscriptionRepository) Upsert", "func (r *SubscriptionRepository) SetAccountPlan")
	accountLock := strings.Index(body, "SELECT id FROM accounts WHERE id=$1 FOR UPDATE")
	write := strings.Index(body, "INSERT INTO subscriptions")
	accountMirror := strings.Index(body, "UPDATE accounts SET plan=")
	bump := strings.Index(body, "bumpAllWhiteboardAccessRevisionTx")
	commit := strings.LastIndex(body, "tx.Commit")
	if !strings.Contains(body, "r.db.Begin") || accountLock < 0 || write <= accountLock || accountMirror <= write || bump <= accountMirror || commit <= bump {
		t.Fatal("subscription, account lock, global whiteboard invalidation and commit lost canonical order")
	}
}

func TestWhiteboardCreationLocksAccountThenSubscriptionExplicitly(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "whiteboard_work_context_repository.go")
	body := boundedGlobalAuthorityFunction(t, source,
		"func lockActiveWhiteboardTenantTx", "func requireActiveWhiteboardTenantWith")
	accountLock := strings.Index(body, "FROM accounts account")
	subscriptionLock := strings.Index(body, "FROM subscriptions account_subscription")
	if accountLock < 0 || subscriptionLock <= accountLock {
		t.Fatal("whiteboard creation lost account -> subscription lock order")
	}
	if !strings.Contains(body, "COALESCE(account.is_active,TRUE)\n\t\tFOR SHARE") ||
		!strings.Contains(body, ") FOR SHARE`") || strings.Contains(body, "JOIN subscriptions") ||
		strings.Contains(body, "FOR SHARE OF") {
		t.Fatal("whiteboard creation must use two explicit authority row locks")
	}
}

func TestLegacyUserNormalizationReturnsItsCommittedAuthorityEffect(t *testing.T) {
	t.Parallel()
	source := globalAuthoritySource(t, "repository.go")
	body := boundedGlobalAuthorityFunction(t, source,
		"func (r *UserAccountRepository) NormalizeForUserWithAuthorityImpact", "func normalizeUserAccountsTx")
	normalize := strings.Index(body, "normalizeUserAccountsTx")
	bump := strings.Index(body, "bumpAllWhiteboardAccessRevisionTx")
	commit := strings.Index(body, "tx.Commit")
	effect := strings.LastIndex(body, "WhiteboardAuthorityMutationEffect")
	if normalize < 0 || bump <= normalize || commit <= bump || effect <= commit {
		t.Fatal("legacy normalization must normalize -> bump -> commit -> return its exact effect")
	}

	serviceSource := globalAuthoritySource(t, "../service/service.go")
	if strings.Count(serviceSource, ".NormalizeForUserWithAuthorityImpact(") != 1 ||
		strings.Contains(serviceSource, ".NormalizeForUser(") {
		t.Fatal("lazy normalization gained an unreported service callsite")
	}
	normalizeBody := boundedGlobalAuthorityFunction(t, source,
		"func normalizeUserAccountsTx", "func (r *UserAccountRepository) AssignAndNormalize")
	if strings.Contains(normalizeBody, "CASE WHEN chosen.role='super_admin'") ||
		!strings.Contains(normalizeBody, "account_user.is_super_admin") {
		t.Fatal("account membership normalization must preserve, never derive, global super-admin authority")
	}
	assignmentRead := boundedGlobalAuthorityFunction(t, serviceSource,
		"func (s *AccountService) GetUserAccountAssignments", "// DeviceService")
	if strings.Contains(assignmentRead, "Normalize") {
		t.Fatal("account assignment reads must not perform hidden authority writes")
	}
}

func TestAuthorityEffectsCannotBeSilentlyDiscardedByLegacyWrappers(t *testing.T) {
	t.Parallel()
	repositorySource := globalAuthoritySource(t, "repository.go")
	adminRepositorySource := globalAuthoritySource(t, "admin_user_repository.go")
	serviceSource := globalAuthoritySource(t, "../service/service.go")
	adminServiceSource := globalAuthoritySource(t, "../service/admin_user_service.go")
	for sourceName, check := range map[string]struct {
		source  string
		markers []string
	}{
		"repository": {repositorySource, []string{
			"func (r *UserRepository) ToggleActive(",
			"func (r *UserRepository) Delete(",
			"func (r *UserRepository) DeleteWithActor(",
			"func (r *UserAccountRepository) Assign(",
			"func (r *UserAccountRepository) UpdateRoleID(",
			"func (r *UserAccountRepository) UpdateRole(",
			"func (r *UserAccountRepository) Remove(",
			"func (r *UserAccountRepository) RemoveWithActor(",
			"func (r *UserAccountRepository) SetDefault(",
			"func (r *RoleRepository) Update(",
			"func (r *RoleRepository) Delete(",
		}},
		"admin repository": {adminRepositorySource, []string{"func (r *UserRepository) CreateWithAccounts("}},
		"service": {serviceSource, []string{
			"func (s *AccountService) CreateUser(",
			"func (s *AccountService) ToggleUserActive(",
			"func (s *AccountService) DeleteUser(",
			"func (s *AccountService) DeleteUserAs(",
			"func (s *AccountService) AssignUserAccount(",
			"func (s *AccountService) RemoveUserAccount(",
			"func (s *AccountService) RemoveUserAccountAs(",
			"func (s *RoleService) Update(",
			"func (s *RoleService) Delete(",
		}},
		"admin service": {adminServiceSource, []string{"func (s *AccountService) CreateUserWithAccounts("}},
	} {
		for _, marker := range check.markers {
			if strings.Contains(check.source, marker) {
				t.Fatalf("%s retained effect-discarding authority wrapper %q", sourceName, marker)
			}
		}
	}
}

func TestCanonicalAuthorityEffectsAreSortedAndDeduplicated(t *testing.T) {
	t.Parallel()
	first := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	second := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	got := canonicalAuthorityUUIDs([]uuid.UUID{second, uuid.Nil, first}, []uuid.UUID{second})
	if len(got) != 2 || got[0] != first || got[1] != second {
		t.Fatalf("canonical effects = %#v, want [%s %s]", got, first, second)
	}
}
