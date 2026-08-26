package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestAdminSessionRefreshRequiredOnlyForCurrentUser(t *testing.T) {
	actorID := uuid.New()
	if !adminSessionRefreshRequired(actorID, actorID) {
		t.Fatal("expected a self-assignment to require a session refresh")
	}
	if adminSessionRefreshRequired(actorID, uuid.New()) {
		t.Fatal("changing another user must not refresh the operator session")
	}
	if adminSessionRefreshRequired(uuid.Nil, uuid.Nil) {
		t.Fatal("missing actor context must fail closed")
	}
}

func TestAdminRemovingOwnActiveAccount(t *testing.T) {
	actorID := uuid.New()
	activeAccountID := uuid.New()
	if !adminRemovingOwnActiveAccount(actorID, actorID, activeAccountID, activeAccountID) {
		t.Fatal("expected removal of the current user's active account to be blocked")
	}
	if adminRemovingOwnActiveAccount(actorID, actorID, activeAccountID, uuid.New()) {
		t.Fatal("a different inactive account may be removed")
	}
	if adminRemovingOwnActiveAccount(actorID, uuid.New(), activeAccountID, activeAccountID) {
		t.Fatal("the operator may remove another user's assignment")
	}
}

func TestAdminUserAccountListPreservesCanonicalEmptyAndRoles(t *testing.T) {
	if got := adminUserAccountList(nil); got == nil || len(got) != 0 {
		t.Fatalf("empty assignments = %#v, want a canonical empty array", got)
	}

	accountID := uuid.New()
	roleID := uuid.New()
	items := adminUserAccountList([]*domain.UserAccount{{
		AccountID:   accountID,
		AccountName: "Proyectos",
		Role:        domain.RoleSuperAdmin,
		RoleID:      &roleID,
		RoleName:    "Super Admin",
		IsDefault:   false,
	}})
	if len(items) != 1 {
		t.Fatalf("assignments length = %d, want 1", len(items))
	}
	if items[0]["account_id"] != accountID || items[0]["role"] != domain.RoleSuperAdmin || items[0]["role_id"] != &roleID {
		t.Fatalf("assignment mapping lost canonical values: %#v", items[0])
	}
}

func TestAdminGlobalUserHandlersUseCommittedEffectAndAccountSignal(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "server.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	functions := []struct {
		name, next, mutation string
	}{
		{"handleAdminCreateUser", "handleAdminUpdateUser", "s.services.Account.CreateUserWithAccountsAndAuthorityImpact"},
		{"handleAdminUpdateUser", "attachAdminUserAccounts", "s.services.Account.UpdateUserWithAuthorityImpact"},
		{"handleAdminToggleUser", "handleAdminResetPassword", "s.services.Account.ToggleUserActiveWithAuthorityImpact"},
		{"handleAdminDeleteUser", "notifyWhiteboardAuthorityEffect", "s.services.Account.DeleteUserAsWithAuthorityImpact"},
	}
	for _, item := range functions {
		start := strings.Index(source, "func (s *Server) "+item.name)
		end := strings.Index(source[start+1:], "func (s *Server) "+item.next)
		if start < 0 || end < 0 {
			t.Fatalf("cannot bound %s", item.name)
		}
		body := source[start : start+1+end]
		mutation := strings.Index(body, item.mutation)
		notification := "s.invalidateAndNotifyUserAuthority"
		if item.name == "handleAdminCreateUser" {
			notification = "s.notifyWhiteboardAuthorityEffect"
		}
		notify := strings.Index(body, notification)
		if mutation < 0 || notify <= mutation {
			t.Fatalf("%s must notify the exact committed authority effect", item.name)
		}
		if strings.Contains(body, "WhiteboardIDsForAccount") || strings.Contains(body, "WhiteboardAccessTargetsForUser") ||
			strings.Contains(body, "revokeWhiteboardUserSockets") || strings.Contains(body, "access_revoked") {
			t.Fatalf("%s must revalidate authority instead of forcing a revocation", item.name)
		}
	}
}
