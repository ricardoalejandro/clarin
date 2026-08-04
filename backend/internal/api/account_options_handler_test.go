package api

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestMyAccountCursorRoundTripAndLimits(t *testing.T) {
	accountID := uuid.MustParse("10000000-0000-0000-0000-000000000001")
	raw := encodeMyAccountCursor(&domain.UserAccount{AccountID: accountID, AccountName: "Filial Iquitos"})
	cursor, err := decodeMyAccountCursor(raw)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if cursor.ID != accountID || cursor.Name != "filial iquitos" {
		t.Fatalf("unexpected cursor: %#v", cursor)
	}
	if _, err := decodeMyAccountCursor("not-base64"); !errors.Is(err, errInvalidAccountOptionsPage) {
		t.Fatalf("invalid cursor should fail, got %v", err)
	}
	for _, value := range []string{"0", "51", "abc"} {
		if _, err := parseMyAccountLimit(value); !errors.Is(err, errInvalidAccountOptionsPage) {
			t.Fatalf("limit %q should fail, got %v", value, err)
		}
	}
	if limit, err := parseMyAccountLimit(""); err != nil || limit != 50 {
		t.Fatalf("unexpected default limit=%d err=%v", limit, err)
	}
}
