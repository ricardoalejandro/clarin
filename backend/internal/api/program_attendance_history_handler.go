package api

import (
	"errors"
	"log"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func parseProgramAttendanceHistoryLimit(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 25, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > 50 {
		return 0, service.ErrProgramInput
	}
	return limit, nil
}

func (s *Server) handleGetProgramParticipantAttendanceHistory(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid participant ID"})
	}
	limit, err := parseProgramAttendanceHistoryLimit(c.Query("limit"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El límite debe estar entre 1 y 50"})
	}
	history, err := s.services.Program.GetParticipantAttendanceHistory(
		c.Context(), accountID, programID, participantID, c.Query("cursor"), limit,
	)
	if err != nil {
		switch {
		case errors.Is(err, repository.ErrProgramParticipantNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program participant not found"})
		case errors.Is(err, service.ErrProgramInput):
			return writeAcademicAPIError(c, err)
		default:
			log.Printf("[programs] attendance history load failed account=%s program=%s participant=%s: %v", accountID, programID, participantID, err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo cargar el historial de asistencia"})
		}
	}
	return c.JSON(history)
}
