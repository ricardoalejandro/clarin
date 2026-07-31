package api

import (
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
