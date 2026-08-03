package api

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

// requireTaskAccessParam is the common server-side gate for every nested task
// surface. Hidden tasks resolve as 404; visible tasks with an insufficient
// level resolve as 403 through taskWorkError.
func (s *Server) requireTaskAccessParam(param, required string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		accountID := c.Locals("account_id").(uuid.UUID)
		userID := c.Locals("user_id").(uuid.UUID)
		taskID, err := uuid.Parse(strings.TrimSpace(c.Params(param)))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
		}
		if _, err := s.repos.TaskWork.RequireTaskAccess(c.Context(), accountID, userID, taskID, required); err != nil {
			return taskWorkError(c, err)
		}
		return c.Next()
	}
}

func (s *Server) requireTaskContainerAccessParam(param, resourceType, required string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		accountID := c.Locals("account_id").(uuid.UUID)
		userID := c.Locals("user_id").(uuid.UUID)
		resourceID, err := uuid.Parse(strings.TrimSpace(c.Params(param)))
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Recurso de Work inválido"})
		}
		if _, err := s.repos.TaskWork.RequireContainerAccess(c.Context(), accountID, userID, resourceID, resourceType, required); err != nil {
			return taskWorkError(c, err)
		}
		return c.Next()
	}
}

func (s *Server) requireTaskIDsAccess(c *fiber.Ctx, taskIDs []uuid.UUID, required string) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	for _, taskID := range taskIDs {
		if _, err := s.repos.TaskWork.RequireTaskAccess(c.Context(), accountID, userID, taskID, required); err != nil {
			return err
		}
	}
	return nil
}
