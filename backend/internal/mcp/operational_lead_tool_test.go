package mcp

import (
	"testing"
	"time"

	mdmcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/naperu/clarin/internal/service"
)

func TestParseMCPOperationalLeadFilters(t *testing.T) {
	req := mdmcp.CallToolRequest{Params: mdmcp.CallToolParams{Arguments: map[string]any{
		"mode":               "count",
		"pipeline":           "IQUITOS",
		"created_from":       "2026-07-01",
		"created_to":         "2026-07-13",
		"timezone":           "America/Lima",
		"conversation_state": "no_messages",
		"interaction_state":  "none",
		"interaction_types":  []any{"note", "call"},
		"fields":             []any{"id", "name"},
		"is_archived":        false,
		"is_deleted":         false,
	}}}
	filters, err := parseMCPOperationalLeadFilters(req)
	if err != nil {
		t.Fatalf("parse filters: %v", err)
	}
	if filters.Mode != service.OperationalLeadQueryModeCount || filters.Pipeline != "IQUITOS" {
		t.Fatalf("unexpected basic filters: %#v", filters)
	}
	if filters.ConversationState != service.OperationalConversationNoMessages || filters.InteractionState != service.OperationalPresenceNone {
		t.Fatalf("unexpected state filters: %#v", filters)
	}
	if len(filters.InteractionTypes) != 2 || filters.InteractionTypes[0] != "note" || filters.InteractionTypes[1] != "call" {
		t.Fatalf("interaction types = %#v", filters.InteractionTypes)
	}
	if filters.Archived == nil || *filters.Archived || filters.Deleted == nil || *filters.Deleted {
		t.Fatalf("optional booleans were not preserved: %#v", filters)
	}
	if filters.CreatedFrom == nil || filters.CreatedTo == nil {
		t.Fatalf("dates were not parsed: %#v", filters)
	}
	if got := filters.CreatedTo.In(time.FixedZone("PET", -5*60*60)).Format("2006-01-02 15:04"); got != "2026-07-14 00:00" {
		t.Fatalf("created_to = %s, want next local midnight", got)
	}
}

func TestParseMCPOperationalLeadFiltersRejectsInvalidArrayAndDate(t *testing.T) {
	tests := []map[string]any{
		{"interaction_types": []any{"note", 42}},
		{"fields": true},
		{"created_from": "13/07/2026"},
		{"timezone": "Mars/Olympus"},
	}
	for _, args := range tests {
		req := mdmcp.CallToolRequest{Params: mdmcp.CallToolParams{Arguments: args}}
		if _, err := parseMCPOperationalLeadFilters(req); err == nil {
			t.Fatalf("expected error for %#v", args)
		}
	}
}

func TestMCPOperationalDateRFC3339RemainsExclusiveValue(t *testing.T) {
	location, err := time.LoadLocation("America/Lima")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := parseMCPOperationalDate("2026-07-13T17:30:00-05:00", location, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := parsed.Format(time.RFC3339); got != "2026-07-13T17:30:00-05:00" {
		t.Fatalf("parsed = %s", got)
	}
}
