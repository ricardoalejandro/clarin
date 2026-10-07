package api

import (
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func deviceActionFailure(c *fiber.Ctx, err error) error {
	status, code, message := fiber.StatusInternalServerError, "device_action_failed", "No se pudo completar la acción del dispositivo; recarga su estado antes de reintentar"
	if errors.Is(err, repository.ErrDeviceDeleting) {
		status, code, message = fiber.StatusConflict, "device_deleting", "El dispositivo se está eliminando; la baja se reintentará automáticamente"
	} else if errors.Is(err, repository.ErrDeviceNotFound) {
		status, code, message = fiber.StatusNotFound, "device_not_found", "Dispositivo no encontrado"
	} else if errors.Is(err, repository.ErrDeviceSessionConflict) {
		status, code, message = fiber.StatusConflict, "device_session_identity_conflict", "La identidad de la sesión cambió; no se completó la acción"
	}
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
