package repository

import (
	"errors"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestErosPublicationPolicyKeepsIndependentMixedResults(t *testing.T) {
	for _, tc := range []struct {
		name              string
		enabled, required bool
		current, captured int64
		want              error
	}{
		{"enabled commercial", true, true, 3, 3, nil},
		{"disabled independent", false, false, 3, 3, nil},
		{"disabled commercial", false, true, 3, 3, ErrLeadsDisabled},
		{"mixed policy changed", true, false, 4, 3, ErrLeadPolicyConflict},
		{"reenabled old commercial", true, true, 5, 3, ErrLeadPolicyConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateErosPublicationPolicy(domain.LeadPolicy{LeadsEnabled: tc.enabled, Version: tc.current}, tc.captured, tc.required)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v want %v", err, tc.want)
			}
		})
	}
}
