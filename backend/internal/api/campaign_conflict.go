package api

import (
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func writeCampaignMutationError(c *fiber.Ctx, err error, fallbackStatus int) error {
	if errors.Is(err, repository.ErrCampaignConflict) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "campaign_conflict", "error": "La campaña cambió en otra sesión. Recarga antes de continuar."})
	}
	return c.Status(fallbackStatus).JSON(fiber.Map{"success": false, "error": err.Error()})
}
