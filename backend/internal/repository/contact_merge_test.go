package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNormalizeAliasValuePhone(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "peru local mobile", in: "987 654 321", want: "51987654321"},
		{name: "already international", in: "+51 987-654-321", want: "51987654321"},
		{name: "jid user", in: "51987654321@s.whatsapp.net", want: "51987654321"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeAliasValue("phone", tt.in); got != tt.want {
				t.Fatalf("normalizeAliasValue() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRecommendedContactToKeepPrefersRelationships(t *testing.T) {
	now := time.Now()
	older := now.Add(-time.Hour)
	a := uuid.New()
	b := uuid.New()
	got := recommendedContactToKeep([]*domain.ContactDuplicateCandidate{
		{Contact: &domain.Contact{ID: a, UpdatedAt: now}, Counts: domain.ContactRelationCounts{Leads: 0, Chats: 0}},
		{Contact: &domain.Contact{ID: b, UpdatedAt: older}, Counts: domain.ContactRelationCounts{Leads: 2, Chats: 1}},
	})
	if got != b {
		t.Fatalf("recommendedContactToKeep() = %s, want %s", got, b)
	}
}

