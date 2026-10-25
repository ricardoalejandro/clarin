package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func (s *Server) registerReportRoutes(protected fiber.Router) {
	// Reporting access remains independent from the commercial Leads policy.
	reports := protected.Group("/reports", s.requirePermission(domain.PermReports))
	reports.Get("/whatsapp-group-coverage/groups", s.handleListWhatsAppReportGroups)
	reports.Post("/whatsapp-group-coverage/generate", s.handleGenerateWhatsAppGroupCoverage)
	reports.Post("/whatsapp-group-coverage/validate", s.handleValidateWhatsAppCoverageSnapshot)
	reports.All("/lead-intelligence", s.handleLeadIntelligenceReportRetired)
	reports.All("/lead-intelligence/*", s.handleLeadIntelligenceReportRetired)
}

func (s *Server) handleLeadIntelligenceReportRetired(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Status(fiber.StatusGone).JSON(fiber.Map{
		"success": false,
		"code":    "report_retired",
		"error":   "El reporte de análisis inteligente de leads fue retirado. Utiliza el reporte de WhatsApp por grupos.",
	})
}

func (s *Server) handleListWhatsAppReportGroups(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	accountID := c.Locals("account_id").(uuid.UUID)
	deviceID, err := uuid.Parse(strings.TrimSpace(c.Query("device_id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_device_id", "error": "El dispositivo seleccionado no es válido",
		})
	}
	groups, err := s.services.Report.ListWhatsAppGroups(c.Context(), accountID, deviceID)
	if err != nil {
		return writeWhatsAppReportError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "groups": groups})
}

func (s *Server) handleGenerateWhatsAppGroupCoverage(c *fiber.Ctx) error {
	c.Set(fiber.HeaderCacheControl, "no-store")
	var req struct {
		DeviceID string `json:"device_id"`
		GroupID  string `json:"group_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_request", "error": "No se pudo leer la solicitud",
		})
	}
	deviceID, err := uuid.Parse(strings.TrimSpace(req.DeviceID))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_device_id", "error": "El dispositivo seleccionado no es válido",
		})
	}
	if strings.TrimSpace(req.GroupID) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_group_id", "error": "Selecciona un grupo de WhatsApp",
		})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	report, err := s.services.Report.GenerateWhatsAppGroupCoverage(c.Context(), accountID, deviceID, req.GroupID)
	if err != nil {
		return writeWhatsAppReportError(c, err)
	}
	release, err := s.repos.Report.AcquireWhatsAppCoveragePublication(c.Context(), accountID, report)
	if err != nil {
		return writeWhatsAppReportError(c, err)
	}
	defer release()
	if err = s.services.Report.ValidateWhatsAppCoverageSnapshot(c.Context(), accountID, service.CoverageSnapshotCheckFromReport(report)); err != nil {
		return writeWhatsAppReportError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "report": report})
}

func writeWhatsAppReportError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, service.ErrReportSnapshotChanged):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "report_snapshot_changed", "error": "Los datos del grupo o de sus integrantes cambiaron. Genera nuevamente el reporte."})
	case errors.Is(err, repository.ErrLeadPolicyConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "lead_policy_conflict", "error": "La configuración de la cuenta cambió. Genera nuevamente el reporte."})
	case errors.Is(err, service.ErrReportDeviceNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "code": "device_not_found", "error": "Dispositivo no encontrado"})
	case errors.Is(err, service.ErrReportUnsupportedDevice):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "unsupported_device_provider", "error": "Este reporte requiere un dispositivo conectado mediante WhatsApp Web"})
	case errors.Is(err, service.ErrReportDeviceNotConnected):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "device_not_connected", "error": "El dispositivo ya no está conectado"})
	case errors.Is(err, service.ErrReportInvalidGroup):
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "code": "invalid_group_id", "error": "El grupo seleccionado no es válido"})
	case errors.Is(err, service.ErrReportGroupNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "code": "group_not_found", "error": "El dispositivo ya no forma parte de este grupo"})
	case errors.Is(err, service.ErrReportWhatsAppUnavailable):
		return c.Status(fiber.StatusBadGateway).JSON(fiber.Map{"success": false, "code": "whatsapp_unavailable", "error": "WhatsApp no pudo entregar la información del grupo. Intenta nuevamente"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "code": "report_failed", "error": "No se pudo generar el reporte"})
	}
}
