package service

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestAccountSessionAuthorityNeverCarriesLegacyAdminAcrossAccounts(t *testing.T) {
	t.Parallel()
	legacyDefaultAdmin := &domain.User{IsAdmin: true}
	agentInOtherAccount := &domain.UserAccount{
		Role: domain.RoleAgent, Permissions: []string{domain.PermContacts},
	}
	isAdmin, permissions := accountSessionAuthority(legacyDefaultAdmin, agentInOtherAccount)
	if isAdmin {
		t.Fatal("legacy users.is_admin leaked administrator authority into another account")
	}
	if !reflect.DeepEqual(permissions, []string{domain.PermContacts}) {
		t.Fatalf("agent permissions = %#v, want only account role permissions", permissions)
	}
	for _, permission := range permissions {
		if permission == domain.PermAll {
			t.Fatal("legacy users.is_admin leaked wildcard permission")
		}
	}
}

func TestLoginSwitchAndRefreshUseAccountMembershipAuthority(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "service.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	if strings.Count(source, "accountSessionAuthority(user, membership)") != 3 {
		t.Fatal("Login, SwitchAccount and RefreshToken must all derive authority from the selected membership")
	}
	for _, bounds := range []struct{ start, end string }{
		{"func (s *AuthService) Login", "func (s *AuthService) SwitchAccount"},
		{"func (s *AuthService) SwitchAccount", "func (s *AuthService) GetUserAccounts"},
		{"func (s *AuthService) RefreshToken", "func (s *AuthService) createSession"},
	} {
		start := strings.Index(source, bounds.start)
		endOffset := strings.Index(source[start+1:], bounds.end)
		if start < 0 || endOffset < 0 {
			t.Fatalf("cannot bound %s", bounds.start)
		}
		body := source[start : start+1+endOffset]
		if strings.Contains(body, "user.IsAdmin") {
			t.Fatalf("%s still trusts the default-account legacy admin mirror", bounds.start)
		}
	}
}

func TestAccountSessionAuthorityAllowsMembershipAdminAndGlobalSuperAdmin(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		user       *domain.User
		membership *domain.UserAccount
	}{
		{name: "account admin", user: &domain.User{}, membership: &domain.UserAccount{Role: domain.RoleAdmin}},
		{name: "global super admin", user: &domain.User{IsSuperAdmin: true}, membership: &domain.UserAccount{Role: domain.RoleAgent}},
	} {
		t.Run(test.name, func(t *testing.T) {
			isAdmin, permissions := accountSessionAuthority(test.user, test.membership)
			if !isAdmin || !reflect.DeepEqual(permissions, []string{domain.PermAll}) {
				t.Fatalf("authority = (%t, %#v), want admin wildcard", isAdmin, permissions)
			}
		})
	}
}
