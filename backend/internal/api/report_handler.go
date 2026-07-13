package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/service"
)

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
	return c.JSON(fiber.Map{"success": true, "report": report})
}

func writeWhatsAppReportError(c *fiber.Ctx, err error) error {
	switch {
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
