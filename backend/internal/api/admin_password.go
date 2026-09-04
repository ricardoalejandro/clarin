package api

import (
	"errors"
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type adminPasswordInputError struct {
	Code    string
	Message string
}

func validateAdminPasswordInput(password, confirmation string) *adminPasswordInputError {
	if password == "" {
		return &adminPasswordInputError{Code: "password_required", Message: "Ingresa una contraseña."}
	}
	if confirmation == "" || password != confirmation {
		return &adminPasswordInputError{Code: "password_mismatch", Message: "Las contraseñas no coinciden."}
	}
	if err := service.ValidateStrongPassword(password); err != nil {
		message := "La contraseña no cumple la política de seguridad."
		var policyErr *service.PasswordPolicyError
		if errors.As(err, &policyErr) && policyErr.Message != "" {
			message = policyErr.Message
		}
		return &adminPasswordInputError{Code: "password_policy", Message: message}
	}
	return nil
}

func writeAdminPasswordInputError(c *fiber.Ctx, inputErr *adminPasswordInputError) error {
	return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{
		"success": false,
		"code":    inputErr.Code,
		"field":   "password",
		"error":   inputErr.Message,
	})
}

func writeAdminResetPasswordError(c *fiber.Ctx, err error) error {
	if errors.Is(err, repository.ErrUserNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{
			"success": false,
			"code":    "user_not_found",
			"field":   "password",
			"error":   "El usuario ya no existe.",
		})
	}
	log.Printf("[AdminUsers] password reset failed: error_type=%T", err)
	return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{
		"success": false,
		"code":    "password_save_failed",
		"field":   "password",
		"error":   "No se pudo cambiar la contraseña. Inténtalo nuevamente.",
	})
}
