package api

import (
	"errors"
	"log"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgconn"
)

// writeAdminUserMutationError keeps database details out of the public API and
// gives the admin form a stable code/field pair for actionable validation.
func writeAdminUserMutationError(c *fiber.Ctx, err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		if pgErr.Code == "23505" {
			constraint := strings.ToLower(pgErr.ConstraintName)
			switch {
			case strings.Contains(constraint, "username"):
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{
					"success": false,
					"code":    "username_taken",
					"field":   "username",
					"error":   "Este nombre de usuario ya está en uso.",
				})
			case strings.Contains(constraint, "email"):
				return c.Status(fiber.StatusConflict).JSON(fiber.Map{
					"success": false,
					"code":    "email_taken",
					"field":   "email",
					"error":   "Este correo ya está asociado a otro usuario.",
				})
			}
		}
		log.Printf("[AdminUsers] write failed: postgres code=%s constraint=%s", pgErr.Code, pgErr.ConstraintName)
	} else {
		log.Printf("[AdminUsers] write failed: error_type=%T", err)
	}

	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
		"success": false,
		"code":    "user_save_failed",
		"error":   "No se pudo guardar el usuario. Inténtalo nuevamente.",
	})
}
