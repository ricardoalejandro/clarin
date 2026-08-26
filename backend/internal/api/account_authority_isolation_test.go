package api

import (
	"strings"
	"testing"
)

func TestAccountAuthorityMiddlewareRehydratesMembershipAndIgnoresLegacyClaim(t *testing.T) {
	t.Parallel()
	accountAccess := globalAuthorityHandlerSource(t, "account_access.go")
	for _, required := range []string{
		"JOIN user_accounts membership",
		"membership.role",
		"account_user.is_super_admin",
		"domain.HasAccountAdminAuthority(role, globalSuperAdmin)",
		"claims.Permissions = []string{domain.PermAll}",
	} {
		if !strings.Contains(accountAccess, required) {
			t.Fatalf("account claims hydration lost %q", required)
		}
	}
	if strings.Contains(accountAccess, "account_user.is_admin") {
		t.Fatal("account claims hydration reads the legacy users.is_admin mirror")
	}

	server := globalAuthorityHandlerSource(t, "server.go")
	for _, middleware := range []struct{ name, next string }{
		{name: "authMiddleware", next: "whiteboardCollabAuthMiddleware"},
		{name: "whiteboardCollabAuthMiddleware", next: "superAdminMiddleware"},
		{name: "wsUpgrade", next: "handleLogin"},
	} {
		body := boundedGlobalAuthorityHandler(t, server, middleware.name, middleware.next)
		if !strings.Contains(body, "s.hydrateAccountScopedClaims") {
			t.Fatalf("%s trusts the token's stale account authority", middleware.name)
		}
	}
	if strings.Contains(server, "claims.IsAdmin ||") || strings.Contains(server, "|| claims.IsAdmin") {
		t.Fatal("server still treats the legacy JWT is_admin mirror as authorization")
	}
}
