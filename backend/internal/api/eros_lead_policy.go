package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func quickTaskRequiresLeads(definition service.ErosQuickTaskDefinition) bool {
	switch definition.Action {
	case service.ErosQuickTaskActionOperationalLeadQuery, service.ErosQuickTaskActionLeadCycleSummary,
		service.ErosQuickTaskActionFollowupPriority, service.ErosQuickTaskActionLeadDataQuality,
		service.ErosQuickTaskActionPerformanceOverview:
		return true
	}
	return false
}

func erosTracesRequireLeads(traces []erosToolTrace) bool {
	for _, trace := range traces {
		if domain.ToolRequiresLeadModule(trace.Name, nil) {
			return true
		}
	}
	return false
}

func erosTracesIncludeMixedData(traces []erosToolTrace) bool {
	for _, trace := range traces {
		if domain.ToolMayIncludeLeadData(trace.Name) {
			return true
		}
	}
	return false
}

func erosMetadataLeadRequirement(metadata json.RawMessage) (bool, bool) {
	var values map[string]any
	if json.Unmarshal(metadata, &values) != nil {
		return false, false
	}
	required, present := values["lead_module_required"].(bool)
	return required, present
}

func erosPolicyMetadata(metadata json.RawMessage, required bool, version int64) json.RawMessage {
	values := map[string]any{}
	_ = json.Unmarshal(metadata, &values)
	if values == nil {
		values = map[string]any{}
	}
	values["lead_module_required"], values["leads_policy_version"] = required, version
	encoded, _ := json.Marshal(values)
	return encoded
}

type erosLeadSnapshot struct {
	Version  int64 `json:"leads_policy_version"`
	Enabled  bool  `json:"leads_enabled"`
	Required bool  `json:"lead_module_required"`
}

func (s *Server) erosRunPolicySnapshot(ctx context.Context, run *domain.ErosRun, policy domain.LeadPolicy, required bool) (erosLeadSnapshot, error) {
	var snapshot erosLeadSnapshot
	_ = json.Unmarshal(run.Parameters, &snapshot)
	if snapshot.Version > 0 {
		if required && !snapshot.Required {
			if snapshot.Version != policy.Version {
				return snapshot, repository.ErrLeadPolicyConflict
			}
			snapshot.Required = true
			encoded, _ := json.Marshal(snapshot)
			return snapshot, s.repos.ErosRun.SaveLeadPolicySnapshot(ctx, run, encoded)
		}
		return snapshot, nil
	}
	// A pre-policy durable turn has no recoverable provenance after the first
	// toggle. Do not stamp its existing provider response as new activity.
	if run.CodexTurnID != "" && policy.Version > 1 {
		return snapshot, repository.ErrLeadPolicyConflict
	}
	snapshot = erosLeadSnapshot{Version: policy.Version, Enabled: policy.LeadsEnabled, Required: required}
	encoded, _ := json.Marshal(snapshot)
	return snapshot, s.repos.ErosRun.SaveLeadPolicySnapshot(ctx, run, encoded)
}

func erosResponseLeadRequirement(snapshot erosLeadSnapshot, traces []erosToolTrace) (required, sensitive bool) {
	exclusive, mixed := erosTracesRequireLeads(traces), erosTracesIncludeMixedData(traces)
	return snapshot.Required || exclusive || (snapshot.Enabled && mixed), snapshot.Required || exclusive || mixed
}

func (s *Server) erosMessageRequiresLeads(ctx context.Context, accountID, userID uuid.UUID, message domain.ErosMessage) (bool, error) {
	if message.Role != "assistant" {
		return false, nil
	}
	if required, known := erosMetadataLeadRequirement(message.Metadata); known {
		return required, nil
	}
	var traces []erosToolTrace
	_ = json.Unmarshal(message.ToolCalls, &traces)
	if erosTracesRequireLeads(traces) || erosTracesIncludeMixedData(traces) {
		return true, nil
	}
	if message.RunID == nil {
		return false, nil
	}
	run, err := s.repos.ErosRun.Get(ctx, accountID, userID, *message.RunID)
	if err != nil {
		return false, err
	}
	return s.erosRunRequiresLeads(ctx, run, map[uuid.UUID]bool{})
}

func (s *Server) erosHistoryRequiresLeads(ctx context.Context, accountID, userID uuid.UUID, messages []domain.ErosMessage) bool {
	for _, message := range messages {
		required, err := s.erosMessageRequiresLeads(ctx, accountID, userID, message)
		if err != nil || required {
			return true
		}
	}
	return false
}

func leadResultSet(set domain.ErosResultSet) bool {
	return set.EntityType == "lead" || domain.ToolRequiresLeadModule(set.SourceTool, nil)
}

func visibleErosResultMemory(sets []domain.ErosResultSet, leadsEnabled bool) []domain.ErosResultSet {
	visible := make([]domain.ErosResultSet, 0, len(sets))
	for _, set := range sets {
		if leadsEnabled || !leadResultSet(set) {
			visible = append(visible, set)
		}
	}
	return visible
}

// Conversation history remains readable. A new disabled-module turn receives
// only independent context, rather than reusing an old commercial result.
func (s *Server) erosHistoryForPolicy(ctx context.Context, accountID, userID uuid.UUID, messages []domain.ErosMessage, leadsEnabled bool) []aiChatMessage {
	history := make([]aiChatMessage, 0, len(messages))
	for _, message := range messages {
		if !leadsEnabled && message.Role == "assistant" {
			commercial, err := s.erosMessageRequiresLeads(ctx, accountID, userID, message)
			if err != nil || commercial {
				continue
			}
		}
		history = append(history, aiChatMessage{Role: message.Role, Content: message.Content})
	}
	return history
}

// Export provenance follows the original run, including a previous export. It
// never treats an unrelated document as commercial based on words in its text.
func (s *Server) erosRunRequiresLeads(ctx context.Context, run *domain.ErosRun, seen map[uuid.UUID]bool) (bool, error) {
	if run == nil {
		return false, errors.New("missing export provenance")
	}
	if seen[run.ID] || len(seen) >= 10 {
		return false, errors.New("invalid export provenance")
	}
	seen[run.ID] = true
	if run.Message == nil {
		s.enrichErosRun(ctx, run)
	}
	if run.Message != nil {
		if required, known := erosMetadataLeadRequirement(run.Message.Metadata); known {
			return required, nil
		}
	}
	var snapshot erosLeadSnapshot
	_ = json.Unmarshal(run.Parameters, &snapshot)
	if snapshot.Required {
		return true, nil
	}
	if definition, found := service.ErosQuickTaskByID(run.TaskKey); found {
		if quickTaskRequiresLeads(definition) {
			return true, nil
		}
		if definition.Action == service.ErosQuickTaskActionExportCurrentResult {
			value, _ := decodeStoredRunParameters(run).Task["source_run_id"].(string)
			id, err := uuid.Parse(strings.TrimSpace(value))
			if err != nil {
				return false, err
			}
			source, err := s.repos.ErosRun.Get(ctx, run.AccountID, run.UserID, id)
			if err != nil {
				return false, err
			}
			return s.erosRunRequiresLeads(ctx, source, seen)
		}
	}
	var result struct {
		ResultSet domain.ErosResultSet `json:"result_set"`
	}
	_ = json.Unmarshal(run.Result, &result)
	if leadResultSet(result.ResultSet) {
		return true, nil
	}
	if run.Message != nil {
		var traces []erosToolTrace
		_ = json.Unmarshal(run.Message.ToolCalls, &traces)
		return erosTracesRequireLeads(traces) || erosTracesIncludeMixedData(traces), nil
	}
	return false, nil
}

func (s *Server) bindErosLeadPolicy(ctx context.Context, run *domain.ErosRun) (context.Context, error) {
	requires, err := s.erosRunRequiresLeads(ctx, run, map[uuid.UUID]bool{})
	if err != nil || !requires {
		return ctx, err
	}
	policy, err := s.repos.Account.GetLeadPolicy(ctx, run.AccountID)
	if err != nil {
		return ctx, err
	}
	if !policy.LeadsEnabled {
		return ctx, repository.ErrLeadsDisabled
	}
	return repository.WithLeadPolicyVersion(ctx, policy.Version), nil
}
