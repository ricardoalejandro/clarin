package repository

import (
	"strings"
	"testing"
)

func TestOfflineConflictResolverPredicateUsesAccountMembershipAndGlobalRoleCatalog(t *testing.T) {
	if strings.Contains(offlineConflictResolverPredicate, "ro.account_id") {
		t.Fatal("global roles do not have an account_id column")
	}
	for _, required := range []string{
		"c.user_id=$2",
		"ua.account_id=c.account_id",
		"ua.user_id=$2",
		"ro.id=ua.role_id",
	} {
		if !strings.Contains(offlineConflictResolverPredicate, required) {
			t.Fatalf("resolver predicate is missing %q", required)
		}
	}
}
