package api

import (
	"errors"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func (s *Server) handleAdminUpdateAccountSessionPolicy(c *fiber.Ctx) error {
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	if claims == nil || !claims.IsSuperAdmin {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Se requiere el permiso de superadministración global."})
	}
	accountID, err := uuid.Parse(c.Params("id"))
	if err != nil || accountID == uuid.Nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "La cuenta no es válida."})
	}
	var request struct {
		Minutes int `json:"session_idle_timeout_minutes"`
	}
	if c.BodyParser(&request) != nil || !domain.ValidSessionIdleTimeoutMinutes(request.Minutes) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
			"success": false, "code": "invalid_session_idle_timeout", "field": "session_idle_timeout_minutes",
			"error": "Ingresa un número entero entre 5 y 1440 minutos.",
		})
	}
	err = s.repos.Account.UpdateSessionIdleTimeout(c.Context(), accountID, claims.UserID, request.Minutes)
	if errors.Is(err, pgx.ErrNoRows) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "La cuenta no existe."})
	}
	if err != nil {
		log.Printf("[SessionPolicy] update failed for account %s: %v", accountID, err)
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"success": false, "error": "No se pudo guardar el tiempo de inactividad. Inténtalo de nuevo."})
	}
	return c.JSON(fiber.Map{"success": true, "session_idle_timeout_minutes": request.Minutes})
}
