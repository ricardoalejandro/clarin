package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func (s *Server) handleListOfflineConflicts(c *fiber.Ctx) error {
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	userID, userOK := c.Locals("user_id").(uuid.UUID)
	if !accountOK || !userOK {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	items, err := s.repos.Offline.ListConflictsForResolver(c.Context(), accountID, userID, c.QueryInt("limit", 100))
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "conflicts": items})
}

func (s *Server) handleResolveOfflineConflict(c *fiber.Ctx) error {
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	userID, userOK := c.Locals("user_id").(uuid.UUID)
	conflictID, parseErr := uuid.Parse(c.Params("id"))
	if !accountOK || !userOK {
		return c.SendStatus(fiber.StatusUnauthorized)
	}
	if parseErr != nil {
		return c.SendStatus(fiber.StatusBadRequest)
	}
	var request struct {
		Strategy string `json:"strategy"`
		Note     string `json:"note"`
	}
	if err := c.BodyParser(&request); err != nil || request.Strategy != "server" || len([]rune(strings.TrimSpace(request.Note))) > 1000 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "only the canonical server version can be accepted in this rollout"})
	}
	if err := s.repos.Offline.ResolveConflictWithServer(c.Context(), accountID, userID, conflictID, strings.TrimSpace(request.Note)); errors.Is(err, repository.ErrOfflineConflictNotFound) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "conflict not found"})
	} else if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"success": true, "status": "resolved_server"})
}
