package api

import (
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

type updateSubscriptionRequest struct {
	PlanCode           string         `json:"plan_code"`
	Status             string         `json:"status"`
	TrialStartedAt     *string        `json:"trial_started_at"`
	TrialEndsAt        *string        `json:"trial_ends_at"`
	CurrentPeriodStart *string        `json:"current_period_start"`
	CurrentPeriodEnd   *string        `json:"current_period_end"`
	GraceEndsAt        *string        `json:"grace_ends_at"`
	BillingProvider    string         `json:"billing_provider"`
	ProviderCustomerID string         `json:"provider_customer_id"`
	ProviderSubID      string         `json:"provider_subscription_id"`
	Metadata           map[string]any `json:"metadata"`
}

func (s *Server) handleListPlans(c *fiber.Ctx) error {
	includePrivate := false
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok && claims.IsSuperAdmin {
		includePrivate = true
	}
	plans, err := s.services.Subscription.ListPlans(c.Context(), includePrivate)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load plans"})
	}
	if plans == nil {
		plans = []*domain.Plan{}
	}
	return c.JSON(fiber.Map{"success": true, "plans": plans})
}

func (s *Server) handleGetSubscription(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	overview, err := s.services.Subscription.GetOverview(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subscription"})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func (s *Server) handleAdminGetAccountSubscription(c *fiber.Ctx) error {
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	overview, err := s.services.Subscription.GetOverview(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subscription"})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func (s *Server) handleAdminUpdateAccountSubscription(c *fiber.Ctx) error {
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	var req updateSubscriptionRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	overview, err := s.services.Subscription.GetOverview(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subscription"})
	}
	sub := overview.Subscription
	if req.PlanCode != "" {
		sub.PlanCode = req.PlanCode
	}
	if req.Status != "" {
		sub.Status = req.Status
		applySubscriptionTransitionTimestamps(sub)
	}
	if req.TrialStartedAt != nil {
		sub.TrialStartedAt, err = parseSubscriptionTime(*req.TrialStartedAt)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid trial_started_at"})
		}
	}
	if req.TrialEndsAt != nil {
		sub.TrialEndsAt, err = parseSubscriptionTime(*req.TrialEndsAt)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid trial_ends_at"})
		}
	}
	if req.CurrentPeriodStart != nil {
		sub.CurrentPeriodStart, err = parseSubscriptionTime(*req.CurrentPeriodStart)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid current_period_start"})
		}
	}
	if req.CurrentPeriodEnd != nil {
		sub.CurrentPeriodEnd, err = parseSubscriptionTime(*req.CurrentPeriodEnd)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid current_period_end"})
		}
	}
	if req.GraceEndsAt != nil {
		sub.GraceEndsAt, err = parseSubscriptionTime(*req.GraceEndsAt)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid grace_ends_at"})
		}
	}
	if req.BillingProvider != "" {
		sub.BillingProvider = req.BillingProvider
	}
	if req.ProviderCustomerID != "" {
		sub.ProviderCustomerID = req.ProviderCustomerID
	}
	if req.ProviderSubID != "" {
		sub.ProviderSubscriptionID = req.ProviderSubID
	}
	if req.Metadata != nil {
		metadata, err := json.Marshal(req.Metadata)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid metadata"})
		}
		sub.Metadata = json.RawMessage(metadata)
	}

	if err := s.services.Subscription.Upsert(c.Context(), sub); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	overview, err = s.services.Subscription.GetOverview(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subscription"})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func (s *Server) handleAdminExtendTrial(c *fiber.Ctx) error {
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	var req struct {
		Days int `json:"days"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Days == 0 {
		req.Days = 7
	}
	overview, err := s.services.Subscription.ExtendTrial(c.Context(), accountID, req.Days)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func (s *Server) handleAdminSuspendSubscription(c *fiber.Ctx) error {
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	overview, err := s.services.Subscription.Suspend(c.Context(), accountID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func (s *Server) handleAdminReactivateSubscription(c *fiber.Ctx) error {
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	overview, err := s.services.Subscription.Reactivate(c.Context(), accountID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "subscription": overview})
}

func parseSubscriptionTime(value string) (*time.Time, error) {
	if value == "" {
		return nil, nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		return &parsed, nil
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return nil, err
	}
	parsed = parsed.Add(23*time.Hour + 59*time.Minute + 59*time.Second)
	return &parsed, nil
}

func applySubscriptionTransitionTimestamps(sub *domain.Subscription) {
	now := time.Now()
	switch sub.Status {
	case domain.SubscriptionStatusSuspended:
		sub.SuspendedAt = &now
	case domain.SubscriptionStatusCanceled:
		sub.CanceledAt = &now
	case domain.SubscriptionStatusActive, domain.SubscriptionStatusTrialing, domain.SubscriptionStatusGrace:
		sub.SuspendedAt = nil
		sub.CanceledAt = nil
	}
}
