package api

import (
	"context"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// ─── Automation CRUD ──────────────────────────────────────────────────────────

func (s *Server) handleListAutomations(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	automations, err := s.repos.Automation.List(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if automations == nil {
		automations = []*domain.Automation{}
	}
	return c.JSON(fiber.Map{"success": true, "automations": automations})
}

func (s *Server) handleGetAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	a, err := s.repos.Automation.GetByID(c.Context(), id, accountID)
	if err != nil || a == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Not found"})
	}
	stats, _ := s.repos.Automation.GetStats(c.Context(), id)
	return c.JSON(fiber.Map{"success": true, "automation": a, "stats": stats})
}

func (s *Server) handleCreateAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		Name          string                 `json:"name"`
		Description   string                 `json:"description"`
		TriggerType   string                 `json:"trigger"`
		TriggerConfig map[string]interface{} `json:"trigger_config"`
		Config        domain.AutomationGraph `json:"graph"`
		IsActive      bool                   `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.TriggerType == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name and trigger are required"})
	}
	if req.TriggerConfig == nil {
		req.TriggerConfig = map[string]interface{}{}
	}

	a := &domain.Automation{
		AccountID:     accountID,
		Name:          req.Name,
		Description:   req.Description,
		TriggerType:   req.TriggerType,
		TriggerConfig: req.TriggerConfig,
		Config:        req.Config,
		IsActive:      req.IsActive,
	}
	if err := s.repos.Automation.Create(c.Context(), a); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "automation": a})
}

func (s *Server) handleUpdateAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	existing, err := s.repos.Automation.GetByID(c.Context(), id, accountID)
	if err != nil || existing == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Not found"})
	}

	var req struct {
		Name          string                 `json:"name"`
		Description   string                 `json:"description"`
		TriggerType   string                 `json:"trigger"`
		TriggerConfig map[string]interface{} `json:"trigger_config"`
		Config        domain.AutomationGraph `json:"graph"`
		IsActive      bool                   `json:"is_active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	existing.Name = req.Name
	existing.Description = req.Description
	existing.TriggerType = req.TriggerType
	existing.TriggerConfig = req.TriggerConfig
	existing.Config = req.Config
	existing.IsActive = req.IsActive
	if existing.TriggerConfig == nil {
		existing.TriggerConfig = map[string]interface{}{}
	}

	if err := s.repos.Automation.Update(c.Context(), existing); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "automation": existing})
}

func (s *Server) handleDeleteAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	if err := s.repos.Automation.Delete(c.Context(), id, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleToggleAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	var req struct {
		IsActive bool `json:"active"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if err := s.repos.Automation.SetActive(c.Context(), id, accountID, req.IsActive); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// ─── Manual trigger ───────────────────────────────────────────────────────────

func (s *Server) handleTriggerAutomation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}

	var req struct {
		LeadID *string `json:"lead_id"`
	}
	_ = c.BodyParser(&req)

	var leadID *uuid.UUID
	if req.LeadID != nil && *req.LeadID != "" {
		parsed, err := uuid.Parse(*req.LeadID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid lead_id"})
		}
		leadID = &parsed
	}

	if err := s.services.Automation.TriggerManual(c.Context(), id, accountID, leadID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "message": "Automation triggered"})
}

// ─── Execution history ────────────────────────────────────────────────────────

func (s *Server) handleGetAutomationExecutions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid ID"})
	}
	executions, err := s.repos.Automation.GetRecentExecutions(c.Context(), id, accountID, 50)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if executions == nil {
		executions = []*domain.AutomationExecution{}
	}
	return c.JSON(fiber.Map{"success": true, "executions": executions})
}

func (s *Server) handleGetExecutionLogs(c *fiber.Ctx) error {
	execID, err := uuid.Parse(c.Params("execId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid execution ID"})
	}
	logs, err := s.repos.Automation.GetExecutionLogs(c.Context(), execID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if logs == nil {
		logs = []*domain.AutomationExecutionLog{}
	}
	return c.JSON(fiber.Map{"success": true, "logs": logs})
}

// ─── Trigger helpers called by other handlers (tag assign/remove, lead created, stage changed) ──

func (s *Server) triggerAutomationLeadCreated(accountID, leadID uuid.UUID) {
	if s.services.Automation == nil {
		return
	}
	go s.services.Automation.TriggerLeadCreated(context.Background(), accountID, leadID)
}

func (s *Server) triggerAutomationLeadStageChanged(accountID, leadID, stageID uuid.UUID) {
	if s.services.Automation == nil {
		return
	}
	go s.services.Automation.TriggerLeadStageChanged(context.Background(), accountID, leadID, stageID)
}

func (s *Server) triggerAutomationTagAssigned(accountID, leadID, tagID uuid.UUID) {
	if s.services.Automation == nil {
		return
	}
	go s.services.Automation.TriggerTagAssigned(context.Background(), accountID, leadID, tagID)
}

func (s *Server) triggerAutomationTagRemoved(accountID, leadID, tagID uuid.UUID) {
	if s.services.Automation == nil {
		return
	}
	go s.services.Automation.TriggerTagRemoved(context.Background(), accountID, leadID, tagID)
}
