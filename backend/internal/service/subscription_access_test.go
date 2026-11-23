package service

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestInactiveAccountAccessDecisionFailsClosed(t *testing.T) {
	t.Parallel()
	if decision := inactiveAccountAccessDecision(true); decision != nil {
		t.Fatalf("active account was denied: %#v", decision)
	}
	decision := inactiveAccountAccessDecision(false)
	if decision == nil || decision.Allowed || decision.Reason != "account_inactive" || decision.Message == "" {
		t.Fatalf("inactive account was not denied canonically: %#v", decision)
	}
}

func TestProgramTransferContactLimitUsesCanonicalRequestEntitlement(t *testing.T) {
	account := uuid.New()
	service := &SubscriptionService{} // same-account matching requires no pool fallback
	for _, tc := range []struct {
		name  string
		value any
		want  int
	}{
		{name: "JSON number", value: float64(45), want: 45},
		{name: "legacy numeric string", value: "16", want: 16},
		{name: "missing or null"},
		{name: "negative means unlimited", value: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			limit, err := service.ResolveContactLimit(context.Background(), account, &domain.SubscriptionOverview{
				Subscription: &domain.Subscription{AccountID: account},
				Entitlements: map[string]any{"max_contacts": tc.value},
			})
			if err != nil || limit != tc.want {
				t.Fatalf("contact limit=%d, error=%v, expected=%d", limit, err, tc.want)
			}
		})
	}
}
