package repository

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestWhatsAppCoveragePublicationPolicy(t *testing.T) {
	account := uuid.New()
	for _, tc := range []struct {
		name   string
		policy domain.LeadPolicy
		report *domain.WhatsAppGroupCoverageReport
		want   error
	}{
		{"enabled", domain.LeadPolicy{LeadsEnabled: true, Version: 1}, &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsEnabled: true, LeadsPolicyVersion: 1}, nil},
		{"disabled independent", domain.LeadPolicy{Version: 2}, &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsPolicyVersion: 2}, nil},
		{"toggle during provider", domain.LeadPolicy{Version: 2}, &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsEnabled: true, LeadsPolicyVersion: 1}, ErrLeadPolicyConflict},
		{"reenabled old result", domain.LeadPolicy{LeadsEnabled: true, Version: 3}, &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsEnabled: true, LeadsPolicyVersion: 1}, ErrLeadPolicyConflict},
		{"wrong account", domain.LeadPolicy{Version: 2}, &domain.WhatsAppGroupCoverageReport{AccountID: uuid.New(), LeadsPolicyVersion: 2}, ErrLeadPolicyConflict},
		{"inconsistent state", domain.LeadPolicy{Version: 2}, &domain.WhatsAppGroupCoverageReport{AccountID: account, LeadsEnabled: true, LeadsPolicyVersion: 2}, ErrLeadPolicyConflict},
		{"missing", domain.LeadPolicy{Version: 2}, nil, ErrLeadPolicyConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := validateWhatsAppCoveragePublication(account, tc.policy, tc.report); !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
}
