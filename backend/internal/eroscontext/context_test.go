package eroscontext

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestContextBindsRunAccountUserAndPermissions(t *testing.T) {
	secret := "test-secret-with-enough-entropy"
	runID, accountID, userID := uuid.New(), uuid.New(), uuid.New()
	raw, err := Sign(secret, runID, accountID, userID, []string{"leads"}, false, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := Parse(secret, raw)
	if err != nil {
		t.Fatal(err)
	}
	if claims.RunID != runID.String() || claims.AccountID != accountID.String() || claims.UserID != userID.String() {
		t.Fatalf("unexpected bound claims: %#v", claims)
	}
	if !HasPermission(claims, "leads") || HasPermission(claims, "chats") {
		t.Fatalf("unexpected permissions: %#v", claims.Permissions)
	}
	if _, err := Parse("different-secret", raw); err == nil {
		t.Fatal("expected modified signature to be rejected")
	}
}

func TestExpiredContextIsRejected(t *testing.T) {
	raw, err := Sign("secret", uuid.New(), uuid.New(), uuid.New(), []string{"*"}, false, time.Nanosecond)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(time.Millisecond)
	if _, err := Parse("secret", raw); err == nil {
		t.Fatal("expected expired context to be rejected")
	}
}
