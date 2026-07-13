package service

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestValidateOperationalLeadFiltersDefaultsAndBounds(t *testing.T) {
	accountID := uuid.New()
	filters, cursor, err := validateOperationalLeadFilters(OperationalLeadFilters{AccountID: accountID, Limit: 999})
	if err != nil {
		t.Fatalf("validate filters: %v", err)
	}
	if cursor != nil {
		t.Fatal("expected nil cursor")
	}
	if filters.Mode != OperationalLeadQueryModeList {
		t.Fatalf("mode = %q, want list", filters.Mode)
	}
	if filters.ConversationState != OperationalConversationAny || filters.InteractionState != OperationalPresenceAny || filters.TaskState != OperationalTaskAny {
		t.Fatalf("unexpected state defaults: %#v", filters)
	}
	if filters.Limit != 500 {
		t.Fatalf("limit = %d, want 500", filters.Limit)
	}
	if len(filters.Fields) == 0 {
		t.Fatal("expected default fields")
	}
}

func TestValidateOperationalLeadFiltersRejectsUnknownValues(t *testing.T) {
	base := OperationalLeadFilters{AccountID: uuid.New()}
	tests := []struct {
		name    string
		mutate  func(*OperationalLeadFilters)
		message string
	}{
		{"conversation", func(f *OperationalLeadFilters) { f.ConversationState = "missing" }, "conversation_state"},
		{"interaction", func(f *OperationalLeadFilters) { f.InteractionState = "missing" }, "interaction_state"},
		{"interaction type", func(f *OperationalLeadFilters) { f.InteractionTypes = []string{"sql"} }, "interaction type"},
		{"task", func(f *OperationalLeadFilters) { f.TaskState = "missing" }, "task_state"},
		{"status", func(f *OperationalLeadFilters) { f.Status = "deleted' OR TRUE" }, "status"},
		{"field", func(f *OperationalLeadFilters) { f.Fields = []string{"password_hash"} }, "field"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			filters := base
			test.mutate(&filters)
			_, _, err := validateOperationalLeadFilters(filters)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("error = %v, want message containing %q", err, test.message)
			}
		})
	}
}

func TestOperationalLeadCursorRoundTrip(t *testing.T) {
	want := operationalLeadCursor{CreatedAt: time.Date(2026, 7, 13, 12, 34, 56, 0, time.UTC), ID: uuid.New()}
	encoded, err := encodeOperationalLeadCursor(want)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	got, err := decodeOperationalLeadCursor(encoded)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if !got.CreatedAt.Equal(want.CreatedAt) || got.ID != want.ID {
		t.Fatalf("cursor = %#v, want %#v", got, want)
	}
}

func TestBuildOperationalLeadNeverReviewedSQLIsScopedAndParameterized(t *testing.T) {
	accountID := uuid.New()
	archived, blocked, deleted := false, false, false
	filters, cursor, err := validateOperationalLeadFilters(OperationalLeadFilters{
		AccountID:         accountID,
		Pipeline:          "IQUITOS",
		Status:            "open",
		Archived:          &archived,
		Blocked:           &blocked,
		Deleted:           &deleted,
		ConversationState: OperationalConversationNoMessages,
		InteractionState:  OperationalPresenceNone,
		InteractionTypes:  []string{"note", "call"},
		Fields:            []string{"id", "name", "created_at"},
		Limit:             25,
	})
	if err != nil {
		t.Fatalf("validate filters: %v", err)
	}
	query, args := buildOperationalLeadListSQL(filters, cursor)

	checks := []string{
		"l.account_id = $1",
		"JOIN contacts c ON c.id = l.contact_id AND c.account_id = l.account_id",
		"NOT EXISTS (SELECT 1 FROM chats",
		"NOT EXISTS (SELECT 1 FROM interactions",
		"filter_i.type = ANY(",
		"l.is_archived =",
		"COALESCE(c.do_not_contact, false) =",
		"l.deleted_at IS NULL",
		"ORDER BY l.created_at DESC, l.id DESC",
	}
	for _, check := range checks {
		if !strings.Contains(query, check) {
			t.Errorf("query missing %q:\n%s", check, query)
		}
	}
	if strings.Contains(query, "IQUITOS") || strings.Contains(query, "note,call") {
		t.Fatalf("filter values were interpolated into SQL: %s", query)
	}
	if len(args) < 7 || args[0] != accountID {
		t.Fatalf("unexpected args: %#v", args)
	}
	if got := args[len(args)-1]; got != 26 {
		t.Fatalf("limit arg = %#v, want 26", got)
	}
}

func TestBuildOperationalLeadCountDoesNotBindUnusedInteractionTypes(t *testing.T) {
	filters, _, err := validateOperationalLeadFilters(OperationalLeadFilters{
		AccountID:        uuid.New(),
		Mode:             OperationalLeadQueryModeCount,
		InteractionState: OperationalPresenceAny,
		InteractionTypes: []string{"note", "call"},
	})
	if err != nil {
		t.Fatalf("validate filters: %v", err)
	}
	query, args := buildOperationalLeadCountSQL(filters)
	if len(args) != 1 {
		t.Fatalf("args = %#v, want only account_id", args)
	}
	if strings.Contains(query, "filter_i.type") {
		t.Fatalf("query unexpectedly filters interaction types: %s", query)
	}
}

func TestOperationalLeadSnapshotUsesOnlyIDsAndPreservesOrder(t *testing.T) {
	ids := []uuid.UUID{uuid.New(), uuid.New(), uuid.New()}
	filters, cursor, err := validateOperationalLeadFilters(OperationalLeadFilters{AccountID: uuid.New(), IDs: ids, PreserveIDOrder: true, Fields: []string{"id", "phone"}, Limit: len(ids)})
	if err != nil {
		t.Fatal(err)
	}
	query, args := buildOperationalLeadListSQL(filters, cursor)
	if !strings.Contains(query, "l.id = ANY(") || !strings.Contains(query, "array_position(") {
		t.Fatalf("snapshot query does not use ordered IDs: %s", query)
	}
	if strings.Contains(query, "pipeline") && strings.Contains(query, "LOWER(COALESCE(p.name") {
		t.Fatalf("snapshot unexpectedly repeated prior filters: %s", query)
	}
	if got := args[len(args)-1]; got != len(ids)+1 {
		t.Fatalf("limit=%v want %d", got, len(ids)+1)
	}
}

func TestOperationalLeadUnansweredSQLUsesRealMessages(t *testing.T) {
	filters, _, err := validateOperationalLeadFilters(OperationalLeadFilters{
		AccountID:         uuid.New(),
		Mode:              OperationalLeadQueryModeCount,
		ConversationState: OperationalConversationUnanswered,
	})
	if err != nil {
		t.Fatalf("validate filters: %v", err)
	}
	query, _ := buildOperationalLeadCountSQL(filters)
	for _, check := range []string{"NOT filter_in.is_from_me", "filter_out.is_from_me", "filter_out.timestamp > filter_in.timestamp", "NOT COALESCE(filter_in.is_revoked, false)"} {
		if !strings.Contains(query, check) {
			t.Errorf("query missing %q: %s", check, query)
		}
	}
}

func TestErosQuickTaskCatalogIsStableAndDefensive(t *testing.T) {
	catalog := ErosQuickTaskCatalog()
	if len(catalog) != 9 {
		t.Fatalf("catalog length = %d, want 9", len(catalog))
	}
	seen := make(map[string]bool, len(catalog))
	for _, definition := range catalog {
		if definition.ID == "" || seen[definition.ID] {
			t.Fatalf("invalid or duplicate id %q", definition.ID)
		}
		seen[definition.ID] = true
		if !definition.ReadOnly || definition.Action == "" {
			t.Fatalf("task is not a read-only allowlisted action: %#v", definition)
		}
		if definition.ID != ErosQuickTaskExportCurrentResult && definition.Permission == "" {
			t.Fatalf("task is missing its permission gate: %#v", definition)
		}
	}
	if !seen[ErosQuickTaskLeadUnmanaged] || !seen[ErosQuickTaskExportCurrentResult] {
		t.Fatalf("catalog missing stable ids: %#v", seen)
	}

	catalog[0].InputSchema["type"] = "mutated"
	fresh := ErosQuickTaskCatalog()
	if fresh[0].InputSchema["type"] != "object" {
		t.Fatal("catalog returned shared mutable schema")
	}
	if _, ok := ErosQuickTaskByID("does_not_exist"); ok {
		t.Fatal("unexpected quick task lookup match")
	}
}

func TestOperationalLeadFiltersForQuickTaskLocksUnmanagedSemantics(t *testing.T) {
	accountID := uuid.New()
	filters, err := OperationalLeadFiltersForQuickTask(ErosQuickTaskLeadUnmanaged, accountID, map[string]any{
		"pipeline": "IQUITOS",
		"limit":    float64(30),
	})
	if err != nil {
		t.Fatalf("build quick task filters: %v", err)
	}
	if filters.AccountID != accountID || filters.Pipeline != "IQUITOS" || filters.Limit != 30 {
		t.Fatalf("unexpected basic filters: %#v", filters)
	}
	if filters.ConversationState != OperationalConversationNoMessages || filters.InteractionState != OperationalPresenceNone {
		t.Fatalf("unmanaged semantics missing: %#v", filters)
	}
	if len(filters.InteractionTypes) != 2 || filters.InteractionTypes[0] != "note" || filters.InteractionTypes[1] != "call" {
		t.Fatalf("interaction types = %#v", filters.InteractionTypes)
	}
	if filters.Archived == nil || *filters.Archived || filters.Blocked == nil || *filters.Blocked || filters.Deleted == nil || *filters.Deleted {
		t.Fatalf("active lead defaults missing: %#v", filters)
	}

	if _, err := OperationalLeadFiltersForQuickTask(ErosQuickTaskLeadUnmanaged, accountID, map[string]any{"conversation_state": "any"}); err == nil {
		t.Fatal("preset accepted an attempt to weaken its fixed semantics")
	}
	if _, err := OperationalLeadFiltersForQuickTask(ErosQuickTaskPerformanceOverview, accountID, nil); err == nil {
		t.Fatal("non-operational task unexpectedly resolved as an operational query")
	}
}
