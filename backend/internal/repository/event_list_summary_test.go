package repository

import (
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"testing"
)

func TestEventListOrderWhitelistsBeforePaging(t *testing.T) {
	for _, key := range []string{"name", "status", "participants", "formula", "date", "name; DROP TABLE events"} {
		got := eventListOrder(domain.EventFilter{SortBy: key, SortDirection: "asc"})
		if strings.Contains(got, "DROP") || !strings.HasSuffix(got, ", id ASC") {
			t.Fatalf("unsafe/unstable order: %s", got)
		}
	}
	if got := eventListOrder(domain.EventFilter{SortBy: "participants", SortDirection: "desc"}); !strings.Contains(got, "membership_state='active'") || !strings.Contains(got, "p.event_id=events.id") {
		t.Fatal(got)
	}
}
