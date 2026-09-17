package api

import (
	"testing"

	"github.com/google/uuid"
)

func TestOfflineReauthContextIsCompleteOrAbsent(t *testing.T) {
	userID, accountID, empty := uuid.New(), uuid.New(), uuid.Nil
	for _, test := range []struct {
		userID, accountID *uuid.UUID
		valid             bool
		count             int
	}{
		{nil, nil, true, 0}, {&userID, &accountID, true, 1}, {nil, &accountID, false, 0}, {&userID, nil, false, 0}, {&empty, &accountID, false, 0}, {&userID, &empty, false, 0},
	} {
		actual, err := offlineReauthRestrictions(test.userID, test.accountID)
		if (err == nil) != test.valid || len(actual) != test.count {
			t.Fatalf("unexpected restriction result: count=%d error=%v", len(actual), err)
		}
		if len(actual) == 1 && (actual[0].UserID != userID || actual[0].AccountID != accountID) {
			t.Fatal("changed requested identity")
		}
	}
}
