package api

import (
	"testing"

	"github.com/google/uuid"
)

func TestLeadInteractionsCacheKeysStayAccountScoped(t *testing.T) {
	accountID := uuid.MustParse("11111111-1111-1111-1111-111111111111")
	leadID := uuid.MustParse("22222222-2222-2222-2222-222222222222")

	key := leadInteractionsCacheKey(accountID, leadID, 100, 0)
	pattern := leadInteractionsCachePattern(accountID, leadID)

	if want := "lead_interactions:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:100:0"; key != want {
		t.Fatalf("leadInteractionsCacheKey() = %q, want %q", key, want)
	}
	if want := "lead_interactions:11111111-1111-1111-1111-111111111111:22222222-2222-2222-2222-222222222222:*"; pattern != want {
		t.Fatalf("leadInteractionsCachePattern() = %q, want %q", pattern, want)
	}
}
