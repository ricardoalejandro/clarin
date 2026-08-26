package domain

import "testing"

func TestHasAccountAdminAuthorityIsAccountScoped(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name             string
		role             string
		globalSuperAdmin bool
		want             bool
	}{
		{name: "agent in another account has no admin bypass", role: RoleAgent, want: false},
		{name: "account admin", role: RoleAdmin, want: true},
		{name: "account super admin role", role: RoleSuperAdmin, want: true},
		{name: "global super admin", role: RoleAgent, globalSuperAdmin: true, want: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := HasAccountAdminAuthority(test.role, test.globalSuperAdmin); got != test.want {
				t.Fatalf("HasAccountAdminAuthority(%q, %t) = %t, want %t", test.role, test.globalSuperAdmin, got, test.want)
			}
		})
	}
}
