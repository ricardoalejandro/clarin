package api

import (
"github.com/gofiber/fiber/v2"
"github.com/google/uuid"
)

func (s *Server) handleGetParticipantsByAttendanceStatus(c *fiber.Ctx) error {
sessionID, err := uuid.Parse(c.Params("sessionId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
}

status := c.Query("status")
if status == "" {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Status query parameter is required"})
}

participants, err := s.services.Program.GetParticipantsByAttendanceStatus(c.Context(), sessionID, status)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(participants)
}
