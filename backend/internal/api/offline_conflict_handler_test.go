package api

import (
	"os"
	"strings"
	"testing"
)

func TestOfflineConflictResolutionDoesNotGrantGlobalSuperadminRead(t *testing.T) {
	raw, err := os.ReadFile("../repository/offline_conflict_repository.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if !strings.Contains(text, "FROM user_accounts ua") || strings.Contains(text, "is_super_admin=TRUE") {
		t.Fatal("offline conflict resolver escaped originating-user/account-membership scope")
	}
	if strings.Contains(text, "ro.account_id") {
		t.Fatal("offline conflict resolver references the nonexistent roles.account_id column")
	}
	if !strings.Contains(text, "ua.account_id=c.account_id") || !strings.Contains(text, "ua.user_id=$2") {
		t.Fatal("offline conflict resolver lost exact account/user membership isolation")
	}
}
