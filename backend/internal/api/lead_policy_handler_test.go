package api

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	"testing"
)

func TestLeadPolicyRouteCatalogPreservesParallelModules(t *testing.T) {
	for _, path := range []string{"/api/leads", "/api/leads/a", "/api/pipelines/a/stages", "/api/pipeline-templates", "/api/reports/lead-intelligence/runs", "/api/settings/incoming-stage", "/api/contacts/lead-duplicates", "/api/contacts/a/leads", "/api/chats/a/opportunities/active", "/api/events/from-leads", "/api/campaigns/a/recipients/from-leads", "/api/google-contacts/batch/sync-from-leads"} {
		if !leadPolicyRouteRequired("POST", path) {
			t.Errorf("commercial route escaped %s", path)
		}
	}
	for _, path := range []string{"/api/contacts", "/api/contacts/a/interactions", "/api/chats/a/details", "/api/events/pipelines", "/api/events/pipelines/a/stages", "/api/events/a/stages", "/api/programs/a/participants", "/api/tasks", "/api/automations", "/api/settings/lead-policy", "/api/admin/accounts/a/lead-policy"} {
		if leadPolicyRouteRequired("POST", path) {
			t.Errorf("parallel module incorrectly blocked %s", path)
		}
	}
}

func TestCommercialTriggerRequiresPreMutationActivityEpoch(t *testing.T) {
	s := &Server{}
	if _, err := s.captureCommercialActivity(context.Background(), uuid.New()); !errors.Is(err, repository.ErrLeadPolicyConflict) {
		t.Fatalf("unbound activity was relabelled: %v", err)
	}
}
