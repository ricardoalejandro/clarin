package repository

import (
	"testing"
	"time"
)

func TestTaskTrashEligibilityUsesArchiveTimestampOnly(t *testing.T) {
	now := time.Date(2026, 7, 30, 12, 0, 0, 0, time.UTC)
	days := 30
	archived := now.Add(-30 * 24 * time.Hour)
	next, eligible := trashEligibility(archived, &days, now)
	if next == nil || !next.Equal(now) || !eligible {
		t.Fatalf("boundary eligibility = next %v eligible %v, want exact and eligible", next, eligible)
	}
	archived = archived.Add(time.Second)
	next, eligible = trashEligibility(archived, &days, now)
	if next == nil || eligible {
		t.Fatalf("early eligibility = next %v eligible %v, want not eligible", next, eligible)
	}
}

func TestTaskTrashEligibilityNever(t *testing.T) {
	next, eligible := trashEligibility(time.Now().Add(-10*365*24*time.Hour), nil, time.Now())
	if next != nil || eligible {
		t.Fatalf("never policy = next %v eligible %v", next, eligible)
	}
}
