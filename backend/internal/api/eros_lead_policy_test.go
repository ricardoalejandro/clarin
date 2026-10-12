package api

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"testing"
)

func TestQuickTaskPolicyFollowsAction(t *testing.T) {
	for _, task := range service.ErosQuickTaskCatalog() {
		want := task.Action != service.ErosQuickTaskActionExportCurrentResult
		if got := quickTaskRequiresLeads(task); got != want {
			t.Errorf("%s: got %v want %v", task.ID, got, want)
		}
	}
	if quickTaskRequiresLeads(service.ErosQuickTaskDefinition{Action: "future_independent_task"}) {
		t.Fatal("unrelated action was classified by default")
	}
}

func TestErosResponseProvenanceIncludesMixedOutputsAndCommercialInputs(t *testing.T) {
	for _, tc := range []struct {
		name                string
		enabled, input      bool
		tools               []erosToolTrace
		required, sensitive bool
	}{
		{"independent", true, false, []erosToolTrace{{Name: "list_events"}}, false, false},
		{"history without new tools", true, true, nil, true, true},
		{"mixed enabled", true, false, []erosToolTrace{{Name: "get_crm_stats"}}, true, true},
		{"mixed disabled", false, false, []erosToolTrace{{Name: "get_contact_detail"}}, false, true},
		{"chat export disabled", false, false, []erosToolTrace{{Name: "export_messages_for_analysis"}}, false, true},
		{"explicit lead", false, false, []erosToolTrace{{Name: "search_leads"}}, true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			required, sensitive := erosResponseLeadRequirement(erosLeadSnapshot{Version: 4, Enabled: tc.enabled, Required: tc.input}, tc.tools)
			if required != tc.required || sensitive != tc.sensitive {
				t.Fatalf("got %v/%v", required, sensitive)
			}
		})
	}
}

func TestErosMetadataPreservesIndependentMixedHistoryAndExport(t *testing.T) {
	s := &Server{}
	metadata := erosPolicyMetadata(json.RawMessage(`{"execution":"model"}`), false, 4)
	message := domain.ErosMessage{Role: "assistant", Content: "Contact only", Metadata: metadata, ToolCalls: json.RawMessage(`[{"name":"get_contact_detail"}]`)}
	history := s.erosHistoryForPolicy(context.Background(), uuid.New(), uuid.New(), []domain.ErosMessage{message}, false)
	if len(history) != 1 {
		t.Fatal("independent mixed output was hidden")
	}
	run := &domain.ErosRun{ID: uuid.New(), Message: &message}
	required, err := s.erosRunRequiresLeads(context.Background(), run, map[uuid.UUID]bool{})
	if err != nil || required {
		t.Fatalf("independent export: %v %v", required, err)
	}
	message.Metadata = nil
	required, err = s.erosRunRequiresLeads(context.Background(), run, map[uuid.UUID]bool{})
	if err != nil || !required {
		t.Fatal("legacy mixed export must retain commercial provenance")
	}
	message.Metadata = erosPolicyMetadata(nil, true, 4)
	message.ToolCalls = nil
	if !s.erosHistoryRequiresLeads(context.Background(), uuid.New(), uuid.New(), []domain.ErosMessage{message}) {
		t.Fatal("tool-free derivative lost provenance")
	}
}

func TestErosRecoveryRetainsOriginalEpoch(t *testing.T) {
	s := &Server{}
	run := &domain.ErosRun{CodexTurnID: "prior-turn", Parameters: json.RawMessage(`{"leads_policy_version":2,"leads_enabled":true,"lead_module_required":true}`)}
	snapshot, err := s.erosRunPolicySnapshot(context.Background(), run, domain.LeadPolicy{LeadsEnabled: true, Version: 4}, false)
	if err != nil || snapshot.Version != 2 || !snapshot.Required {
		t.Fatalf("old provider response relabelled: %+v %v", snapshot, err)
	}
	run.Parameters = nil
	if _, err = s.erosRunPolicySnapshot(context.Background(), run, domain.LeadPolicy{LeadsEnabled: true, Version: 4}, false); !errors.Is(err, repository.ErrLeadPolicyConflict) {
		t.Fatalf("legacy turn: %v", err)
	}
}

func TestErosLeadPolicyKeepsIndependentResultMemory(t *testing.T) {
	sets := []domain.ErosResultSet{
		{EntityType: "lead", SourceTool: "query_leads_operational"},
		{EntityType: "contact", SourceTool: "list_contacts"},
		{EntityType: "event", SourceTool: "list_events"},
		{EntityType: "task", SourceTool: "get_tasks"},
		{EntityType: "selection", SourceTool: "search_leads"},
	}
	got := visibleErosResultMemory(sets, false)
	if len(got) != 3 || got[0].EntityType != "contact" || got[1].EntityType != "event" || got[2].EntityType != "task" {
		t.Fatalf("independent memory changed: %+v", got)
	}
	if len(visibleErosResultMemory(sets, true)) != 5 || len(sets) != 5 {
		t.Fatal("enabled or original memory was changed")
	}
}

func TestErosCommercialTraceOwnership(t *testing.T) {
	if !erosTracesRequireLeads([]erosToolTrace{{Name: "query_leads_operational"}}) {
		t.Fatal("lead tool bypass")
	}
	if erosTracesRequireLeads([]erosToolTrace{{Name: "list_contacts"}, {Name: "list_events"}, {Name: "render_file"}}) {
		t.Fatal("independent tools blocked")
	}
}

func TestDisabledErosHistoryKeepsUserAndIndependentMessages(t *testing.T) {
	s := &Server{}
	messages := []domain.ErosMessage{
		{Role: "user", Content: "Previous question"},
		{Role: "assistant", Content: "Commercial", ToolCalls: []byte(`[{"name":"query_leads_operational"}]`)},
		{Role: "assistant", Content: "Old CRM totals", ToolCalls: []byte(`[{"name":"get_crm_stats"}]`)},
		{Role: "assistant", Content: "Independent document"},
	}
	history := s.erosHistoryForPolicy(context.Background(), uuid.New(), uuid.New(), messages, false)
	if len(history) != 2 || history[1].Content != "Independent document" {
		t.Fatalf("unexpected context: %+v", history)
	}
	if len(messages) != 4 {
		t.Fatal("stored conversation was changed")
	}
}
