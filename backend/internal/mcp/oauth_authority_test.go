package mcp

import (
	"os"
	"strings"
	"testing"
)

func TestOAuthAuthorizationRehydratesGlobalSuperAdminAuthority(t *testing.T) {
	t.Parallel()

	source, err := os.ReadFile("oauth.go")
	if err != nil {
		t.Fatalf("read oauth.go: %v", err)
	}
	body := string(source)
	start := strings.Index(body, "func (s *MCPServer) currentOAuthUser(")
	end := strings.Index(body[start:], "type serviceJWTClaims struct")
	if start < 0 || end < 0 {
		t.Fatal("currentOAuthUser source boundary not found")
	}
	body = body[start : start+end]
	for _, required := range []string{
		"s.services.Auth.ValidateToken(",
		"SELECT is_active,COALESCE(is_super_admin,FALSE)",
		"FROM users WHERE id=$1",
		"if !active",
		"IsSuperAdmin: globalSuperAdmin",
	} {
		if !strings.Contains(body, required) {
			t.Fatalf("OAuth current-user validation lost %q", required)
		}
	}
	for _, forbidden := range []string{"claims.Role", "claims.IsSuperAdmin"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("OAuth authorization still trusts stale JWT authority via %q", forbidden)
		}
	}
}
