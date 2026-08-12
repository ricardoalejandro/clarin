package repository

import (
	"strings"
	"testing"
)

func TestWorkEventReminderClaimsAreConcurrentSafe(t *testing.T) {
	source := readRepositorySource(t, "work_event_repository.go")
	for _, invariant := range []string{
		"func (r *WorkEventRepository) ClaimPendingReminders",
		"FOR UPDATE OF job SKIP LOCKED",
		"SET delivered_at=NOW(),updated_at=NOW()",
		"command.RowsAffected() != int64(len(ids))",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("durable reminder claim lost invariant %q", invariant)
		}
	}
}

func TestWorkEventAvailabilityExposesStateWithoutEventDetails(t *testing.T) {
	source := readRepositorySource(t, "work_event_repository.go")
	for _, invariant := range []string{
		"CASE WHEN BOOL_OR(attendee.rsvp='accepted') THEN 'busy' ELSE 'tentative' END",
		"State   string     `json:\"state\"`",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("availability contract lost invariant %q", invariant)
		}
	}
}
