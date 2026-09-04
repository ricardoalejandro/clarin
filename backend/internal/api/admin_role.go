package api

import (
	"errors"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func writeAdminRoleMutationError(c *fiber.Ctx, err error) error {
	if errors.Is(err, repository.ErrRoleNameTaken) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"success": false,
			"code":    "role_name_taken",
			"field":   "name",
			"error":   "Ya existe un rol con ese nombre.",
		})
	}
	status := fiber.StatusInternalServerError
	if errors.Is(err, repository.ErrRoleNotFound) {
		status = fiber.StatusNotFound
	}
	log.Printf("[AdminRoles] write failed: error_type=%T", err)
	return c.Status(status).JSON(fiber.Map{
		"success": false,
		"code":    "role_save_failed",
		"error":   "No se pudo guardar el rol. Inténtalo nuevamente.",
	})
}
