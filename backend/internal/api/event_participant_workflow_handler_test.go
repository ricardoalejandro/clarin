package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestParseCSVUUIDQueryDeduplicates(t *testing.T) {
	first, second := uuid.New(), uuid.New()
	ids, err := parseCSVUUIDQuery(first.String() + ", " + second.String() + "," + first.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != first || ids[1] != second {
		t.Fatalf("unexpected IDs: %#v", ids)
	}
}

func TestEventMembershipFrozen(t *testing.T) {
	if !eventMembershipFrozen(domain.EventStatusCompleted) || !eventMembershipFrozen(domain.EventStatusCancelled) {
		t.Fatal("completed and cancelled events must reject membership writes")
	}
	if eventMembershipFrozen(domain.EventStatusActive) || eventMembershipFrozen(domain.EventStatusDraft) {
		t.Fatal("active and draft events must remain writable")
	}
}

func TestAllowedEventStatusTransition(t *testing.T) {
	tests := []struct {
		from, to string
		allowed  bool
	}{
		{domain.EventStatusDraft, domain.EventStatusActive, true},
		{domain.EventStatusDraft, domain.EventStatusCancelled, true},
		{domain.EventStatusActive, domain.EventStatusCompleted, true},
		{domain.EventStatusActive, domain.EventStatusCancelled, true},
		{domain.EventStatusCompleted, domain.EventStatusActive, false},
		{domain.EventStatusCancelled, domain.EventStatusActive, false},
		{domain.EventStatusActive, domain.EventStatusDraft, false},
		{domain.EventStatusCompleted, domain.EventStatusCompleted, true},
	}
	for _, tt := range tests {
		if got := allowedEventStatusTransition(tt.from, tt.to); got != tt.allowed {
			t.Fatalf("transition %s -> %s = %v, want %v", tt.from, tt.to, got, tt.allowed)
		}
	}
	if validEventLifecycleStatus("invented") {
		t.Fatal("unknown lifecycle status must be rejected")
	}
}

func TestParseStrictUniqueUUIDsRejectsMalformedBatch(t *testing.T) {
	valid := uuid.New()
	if _, err := parseStrictUniqueUUIDs([]string{valid.String(), "not-a-uuid"}); err == nil {
		t.Fatal("mixed valid/malformed batch must be rejected")
	}
	ids, err := parseStrictUniqueUUIDs([]string{valid.String(), valid.String()})
	if err != nil || len(ids) != 1 || ids[0] != valid {
		t.Fatalf("deduplicated IDs = %#v, err=%v", ids, err)
	}
}

func TestParseCSVUUIDQueryRejectsInvalidID(t *testing.T) {
	if _, err := parseCSVUUIDQuery("not-a-uuid"); err == nil {
		t.Fatal("expected invalid UUID error")
	}
}
