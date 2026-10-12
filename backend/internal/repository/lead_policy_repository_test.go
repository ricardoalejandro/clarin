package repository

import (
	"context"
	"errors"
	"github.com/naperu/clarin/internal/domain"
	"testing"
	"time"
)

func TestLeadPolicyContextRejectsStaleAndPausedWork(t *testing.T) {
	now := time.Now().UTC()
	enabled := domain.LeadPolicy{LeadsEnabled: true, LeadAutomationEnabled: true, Version: 3, AutomationEnabledSince: &now}
	for _, tc := range []struct {
		name   string
		ctx    context.Context
		policy domain.LeadPolicy
		want   error
	}{
		{"manual current", WithLeadPolicyVersion(context.Background(), 3), enabled, nil},
		{"manual old", WithLeadPolicyVersion(context.Background(), 2), enabled, ErrLeadPolicyConflict},
		{"automatic old epoch", WithLeadAutomationPolicy(context.Background(), 2, now.Add(time.Second)), enabled, ErrLeadPolicyConflict},
		{"automatic old event", WithLeadAutomationPolicy(context.Background(), 3, now.Add(-time.Second)), enabled, ErrLeadAutomationDisabled},
		{"automatic fresh", WithLeadAutomationPolicy(context.Background(), 3, now), enabled, nil},
		{"module off", context.Background(), domain.LeadPolicy{Version: 3}, ErrLeadsDisabled},
		{"manual while automation paused", context.Background(), domain.LeadPolicy{LeadsEnabled: true, Version: 3}, nil},
		{"inference stale", context.WithValue(context.Background(), "clarin.lead_automation_version", int64(2)), enabled, ErrLeadAutomationDisabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateLeadPolicy(tc.ctx, tc.policy); !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
}
