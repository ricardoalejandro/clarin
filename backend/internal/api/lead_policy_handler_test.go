package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestLeadPolicyRouteCatalogPreservesParallelModules(t *testing.T) {
	for _, path := range []string{"/api/leads", "/api/leads/a", "/api/pipelines/a/stages", "/api/pipeline-templates", "/api/settings/incoming-stage", "/api/contacts/lead-duplicates", "/api/contacts/a/leads", "/api/chats/a/opportunities/active", "/api/events/from-leads", "/api/campaigns/a/recipients/from-leads", "/api/google-contacts/batch/sync-from-leads"} {
		if !leadPolicyRouteRequired("POST", path) {
			t.Errorf("commercial route escaped %s", path)
		}
	}
	for _, path := range []string{"/api/contacts", "/api/contacts/a/interactions", "/api/chats/a/details", "/api/events/pipelines", "/api/events/pipelines/a/stages", "/api/events/a/stages", "/api/programs/a/participants", "/api/tasks", "/api/automations", "/api/settings/lead-policy", "/api/admin/accounts/a/lead-policy", "/api/reports/lead-intelligence", "/api/reports/lead-intelligence/", "/api/reports/lead-intelligence/runs", "/api/reports/lead-intelligence/runs/a/result"} {
		if leadPolicyRouteRequired("POST", path) {
			t.Errorf("parallel module incorrectly blocked %s", path)
		}
	}
}

func TestRetiredLeadIntelligencePolicyBypassesCommercialSuffixes(t *testing.T) {
	for _, suffix := range []string{"/recipients/from-leads", "/batch/sync-from-leads", "/batch/desync-from-leads"} {
		retiredPath := "/api/reports/lead-intelligence/runs/history" + suffix
		if leadPolicyRouteRequired("POST", retiredPath) {
			t.Errorf("retired descendant incorrectly blocked before 410: %s", retiredPath)
		}
		similarPath := "/api/reports/lead-intelligence-other" + suffix
		if !leadPolicyRouteRequired("POST", similarPath) {
			t.Errorf("retirement exception escaped its exact prefix: %s", similarPath)
		}
	}
}

func TestLeadPolicyResponseSerializesAccountAndCanonicalSnapshot(t *testing.T) {
	enabledSince := time.Date(2026, time.October, 23, 12, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name   string
		policy domain.LeadPolicy
	}{
		{"enabled", domain.LeadPolicy{LeadsEnabled: true, LeadAutomationEnabled: true, Version: 7, AutomationEnabledSince: &enabledSince}},
		{"disabled", domain.LeadPolicy{LeadAutomationEnabled: true, Version: 8}},
		{"automation paused", domain.LeadPolicy{LeadsEnabled: true, Version: 9, AutomationEnabledSince: &enabledSince}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			accountID := uuid.New()
			app := fiber.New()
			app.Get("/policy", func(c *fiber.Ctx) error {
				return writeLeadPolicyResponse(c, accountID, &tc.policy)
			})
			res, err := app.Test(httptest.NewRequest("GET", "/policy", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			var body struct {
				Success bool `json:"success"`
				Policy  struct {
					AccountID uuid.UUID `json:"account_id"`
					domain.LeadPolicy
				} `json:"policy"`
			}
			if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != fiber.StatusOK || !body.Success || body.Policy.AccountID != accountID {
				t.Fatalf("missing or wrong account in policy response: status=%d body=%+v", res.StatusCode, body)
			}
			if body.Policy.LeadsEnabled != tc.policy.LeadsEnabled || body.Policy.LeadAutomationEnabled != tc.policy.LeadAutomationEnabled || body.Policy.Version != tc.policy.Version {
				t.Fatalf("policy snapshot changed: got=%+v want=%+v", body.Policy.LeadPolicy, tc.policy)
			}
			if got, want := body.Policy.AutomationEnabledSince, tc.policy.AutomationEnabledSince; (got == nil) != (want == nil) || (got != nil && !got.Equal(*want)) {
				t.Fatalf("automation boundary changed: got=%v want=%v", got, want)
			}
		})
	}
}

func TestLeadPolicyPublicationBindsTargetAccountWithoutChangingAuditJSON(t *testing.T) {
	policy := domain.LeadPolicy{LeadsEnabled: true, Version: 4}
	before, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	for _, accountID := range []uuid.UUID{uuid.New(), uuid.New()} {
		payload := newLeadPolicyResponse(accountID, &policy)
		for _, tc := range []struct {
			name   string
			status int
			body   fiber.Map
		}{
			{"conflict", fiber.StatusConflict, fiber.Map{"success": false, "code": "lead_policy_conflict", "policy": payload}},
			{"capability event", fiber.StatusOK, fiber.Map{"account_id": accountID, "policy": payload}},
		} {
			t.Run(tc.name+"/"+accountID.String(), func(t *testing.T) {
				app := fiber.New()
				app.Get("/publication", func(c *fiber.Ctx) error { return c.Status(tc.status).JSON(tc.body) })
				res, err := app.Test(httptest.NewRequest("GET", "/publication", nil))
				if err != nil {
					t.Fatal(err)
				}
				defer res.Body.Close()
				var body struct {
					Policy struct {
						AccountID uuid.UUID `json:"account_id"`
						Version   int64     `json:"leads_policy_version"`
					} `json:"policy"`
				}
				if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if res.StatusCode != tc.status || body.Policy.AccountID != accountID || body.Policy.Version != policy.Version {
					t.Fatalf("publication lost account/version: status=%d body=%+v", res.StatusCode, body)
				}
			})
		}
	}
	after, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	var audit map[string]json.RawMessage
	if err := json.Unmarshal(after, &audit); err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) || audit["account_id"] != nil {
		t.Fatalf("public account binding changed stored policy: before=%s after=%s", before, after)
	}
}

func TestCommercialTriggerRequiresPreMutationActivityEpoch(t *testing.T) {
	s := &Server{}
	if _, err := s.captureCommercialActivity(context.Background(), uuid.New()); !errors.Is(err, repository.ErrLeadPolicyConflict) {
		t.Fatalf("unbound activity was relabelled: %v", err)
	}
}
