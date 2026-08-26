package service

import "testing"

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
