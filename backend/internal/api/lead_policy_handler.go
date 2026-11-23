package api

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// Bind public snapshots to their account without changing persisted policy JSON.
type leadPolicyResponse struct {
	AccountID uuid.UUID `json:"account_id"`
	domain.LeadPolicy
}

func newLeadPolicyResponse(accountID uuid.UUID, policy *domain.LeadPolicy) *leadPolicyResponse {
	if policy == nil {
		return nil
	}
	return &leadPolicyResponse{AccountID: accountID, LeadPolicy: *policy}
}

func writeLeadPolicyResponse(c *fiber.Ctx, accountID uuid.UUID, policy *domain.LeadPolicy) error {
	return c.JSON(fiber.Map{"success": true, "policy": newLeadPolicyResponse(accountID, policy)})
}

func writeLeadPolicyError(c *fiber.Ctx, err error) error {
	status, code, message := fiber.StatusServiceUnavailable, "lead_policy_unavailable", "No pudimos comprobar la configuración de Leads. Inténtalo nuevamente."
	switch {
	case errors.Is(err, repository.ErrLeadsDisabled):
		status, code, message = 403, "leads_disabled", err.Error()
	case errors.Is(err, repository.ErrLeadAutomationDisabled):
		status, code, message = 403, "lead_automation_paused", err.Error()
	case errors.Is(err, repository.ErrLeadPolicyConflict):
		status, code, message = 409, "lead_policy_conflict", err.Error()
	case errors.Is(err, pgx.ErrNoRows):
		status, code, message = 404, "account_not_found", "La cuenta no está disponible."
	}
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
func (s *Server) handleGetLeadPolicy(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	p, err := s.repos.Account.GetLeadPolicy(c.Context(), accountID)
	if err != nil {
		return writeLeadPolicyError(c, err)
	}
	return writeLeadPolicyResponse(c, accountID, p)
}
func (s *Server) handleAdminGetLeadPolicy(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.SendStatus(400)
	}
	p, err := s.repos.Account.GetLeadPolicy(c.Context(), id)
	if err != nil {
		return writeLeadPolicyError(c, err)
	}
	return writeLeadPolicyResponse(c, id, p)
}
func (s *Server) handleAdminUpdateLeadPolicy(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.SendStatus(400)
	}
	var req struct {
		LeadsEnabled      *bool `json:"leads_enabled"`
		AutomationEnabled *bool `json:"lead_automation_enabled"`
		ExpectedVersion   int64 `json:"expected_version"`
	}
	if c.BodyParser(&req) != nil || req.LeadsEnabled == nil || req.AutomationEnabled == nil || req.ExpectedVersion < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Revisa las opciones y la versión de configuración."})
	}
	p, err := s.repos.Account.UpdateLeadPolicy(c.Context(), id, c.Locals("user_id").(uuid.UUID), req.ExpectedVersion, *req.LeadsEnabled, *req.AutomationEnabled)
	if errors.Is(err, repository.ErrLeadPolicyConflict) {
		return c.Status(409).JSON(fiber.Map{"success": false, "code": "lead_policy_conflict", "error": err.Error(), "policy": newLeadPolicyResponse(id, p)})
	}
	if err != nil {
		return writeLeadPolicyError(c, err)
	}
	s.invalidateLeadsCache(id)
	if s.services.Automation != nil && !p.AutomationEnabled() {
		s.services.Automation.CancelCommercialAccount(id)
	}
	if s.hub != nil {
		s.hub.BroadcastToAccount(id, "account_capabilities_changed", fiber.Map{"account_id": id, "policy": newLeadPolicyResponse(id, p)})
	}
	return writeLeadPolicyResponse(c, id, p)
}

// This gate uses an explicit resource catalog. In particular, /events/pipelines
// belongs to Eventos and must not inherit the commercial pipeline policy.
func leadPolicyRouteRequired(method, path string) bool {
	path = strings.TrimSuffix(strings.TrimPrefix(path, "/api"), "/")
	if path == "/reports/lead-intelligence" || strings.HasPrefix(path, "/reports/lead-intelligence/") {
		return false
	}
	for _, prefix := range []string{"/leads", "/pipelines", "/pipeline-templates"} {
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	if strings.HasPrefix(path, "/tags/entity/lead/") || path == "/settings/incoming-stage" || path == "/contacts/lead-duplicates" || path == "/events/from-leads" || strings.HasSuffix(path, "/recipients/from-leads") || strings.HasSuffix(path, "/batch/sync-from-leads") || strings.HasSuffix(path, "/batch/desync-from-leads") {
		return true
	}
	return strings.HasPrefix(path, "/contacts/") && strings.HasSuffix(path, "/leads") || strings.HasPrefix(path, "/chats/") && strings.Contains(path, "/opportunities/")
}
func (s *Server) leadPolicyRouteMiddleware(c *fiber.Ctx) error {
	if !leadPolicyRouteRequired(c.Method(), c.Path()) {
		return c.Next()
	}
	id, ok := c.Locals("account_id").(uuid.UUID)
	if !ok {
		return c.SendStatus(401)
	}
	p, err := s.repos.Account.GetLeadPolicy(c.Context(), id)
	if err != nil {
		return writeLeadPolicyError(c, err)
	}
	if !p.LeadsEnabled {
		return writeLeadPolicyError(c, repository.ErrLeadsDisabled)
	}
	c.Context().SetUserValue("clarin.leads_policy_version", p.Version)
	c.Context().SetUserValue("clarin.leads_activity_at", time.Now().UTC())
	return c.Next()
}

func (s *Server) requireLeadsForActivity(c *fiber.Ctx, accountID uuid.UUID) error {
	p, err := s.repos.Account.GetLeadPolicy(c.Context(), accountID)
	if err != nil {
		return err
	}
	if !p.LeadsEnabled {
		return repository.ErrLeadsDisabled
	}
	c.Context().SetUserValue("clarin.leads_policy_version", p.Version)
	c.Context().SetUserValue("clarin.leads_activity_at", time.Now().UTC())
	return nil
}

func (s *Server) leadAutomationAvailable(c *fiber.Ctx, accountID uuid.UUID) bool {
	p, err := s.repos.Account.GetLeadPolicy(c.Context(), accountID)
	if err == nil && p.AutomationEnabled() {
		c.Context().SetUserValue("clarin.lead_automation_version", p.Version)
	}
	return err == nil && p.AutomationEnabled()
}
