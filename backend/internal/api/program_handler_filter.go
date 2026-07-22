package api

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func (s *Server) handleGetParticipantsByAttendanceStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}

	status := c.Query("status")
	if status == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Status query parameter is required"})
	}

	participants, err := s.services.Program.GetParticipantsByAttendanceStatus(c.Context(), accountID, programID, sessionID, status)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}

	if participants == nil {
		participants = make([]*domain.ProgramParticipant, 0)
	}

	return c.JSON(participants)
}
