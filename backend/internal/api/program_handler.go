package api

import (
"time"

"github.com/gofiber/fiber/v2"
"github.com/google/uuid"
"github.com/naperu/clarin/internal/domain"
)

// --- Programs ---

func (s *Server) handleCreateProgram(c *fiber.Ctx) error {
accountID := c.Locals("account_id").(uuid.UUID)
userID := c.Locals("user_id").(uuid.UUID)

var req struct {
Name        string `json:"name"`
Description string `json:"description"`
Color       string `json:"color"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

program := &domain.Program{
AccountID:   accountID,
Name:        req.Name,
Description: &req.Description,
Color:       req.Color,
		CreatedBy:   &userID,
	}

	if err := s.services.Program.CreateProgram(c.Context(), program); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

return c.Status(fiber.StatusCreated).JSON(program)
}

func (s *Server) handleListPrograms(c *fiber.Ctx) error {
accountID := c.Locals("account_id").(uuid.UUID)

programs, err := s.services.Program.ListPrograms(c.Context(), accountID)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(programs)
}

func (s *Server) handleGetProgram(c *fiber.Ctx) error {
accountID := c.Locals("account_id").(uuid.UUID)

id, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

program, err := s.services.Program.GetProgram(c.Context(), accountID, id)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}
if program == nil {
return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
}

return c.JSON(program)
}

func (s *Server) handleUpdateProgram(c *fiber.Ctx) error {
accountID := c.Locals("account_id").(uuid.UUID)

id, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

var req struct {
Name        string `json:"name"`
Description string `json:"description"`
Status      string `json:"status"`
Color       string `json:"color"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

program := &domain.Program{
ID:          id,
AccountID:   accountID,
Name:        req.Name,
Description: &req.Description,
Status:      req.Status,
Color:       req.Color,
}

if err := s.services.Program.UpdateProgram(c.Context(), program); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(program)
}

func (s *Server) handleDeleteProgram(c *fiber.Ctx) error {
accountID := c.Locals("account_id").(uuid.UUID)

id, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

if err := s.services.Program.DeleteProgram(c.Context(), accountID, id); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.SendStatus(fiber.StatusNoContent)
}

// --- Participants ---

func (s *Server) handleAddParticipant(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

var req struct {
		ContactID uuid.UUID `json:"contact_id"`
		Status    string    `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	participant := &domain.ProgramParticipant{
		ProgramID: programID,
		ContactID: req.ContactID,
}

if err := s.services.Program.AddParticipant(c.Context(), participant); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.Status(fiber.StatusCreated).JSON(participant)
}

func (s *Server) handleListParticipants(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

participants, err := s.services.Program.ListParticipants(c.Context(), programID)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(participants)
}

func (s *Server) handleRemoveParticipant(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

participantID, err := uuid.Parse(c.Params("participantId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid participant ID"})
}

if err := s.services.Program.RemoveParticipant(c.Context(), programID, participantID); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.SendStatus(fiber.StatusNoContent)
}

// --- Sessions ---

func (s *Server) handleCreateSession(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

var req struct {
Date  string `json:"date"`
Topic string `json:"topic"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

parsedDate, err := time.Parse("2006-01-02", req.Date)
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid date format, expected YYYY-MM-DD"})
}

session := &domain.ProgramSession{
ProgramID: programID,
Date:      parsedDate,
Topic:     &req.Topic,
}

if err := s.services.Program.CreateSession(c.Context(), session); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.Status(fiber.StatusCreated).JSON(session)
}

func (s *Server) handleListSessions(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

sessions, err := s.services.Program.ListSessions(c.Context(), programID)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(sessions)
}

func (s *Server) handleUpdateSession(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

sessionID, err := uuid.Parse(c.Params("sessionId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
}

var req struct {
Date  string `json:"date"`
Topic string `json:"topic"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

parsedDate, err := time.Parse("2006-01-02", req.Date)
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid date format, expected YYYY-MM-DD"})
}

session := &domain.ProgramSession{
ID:        sessionID,
ProgramID: programID,
Date:      parsedDate,
Topic:     &req.Topic,
}

if err := s.services.Program.UpdateSession(c.Context(), session); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(session)
}

func (s *Server) handleDeleteSession(c *fiber.Ctx) error {
programID, err := uuid.Parse(c.Params("id"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
}

sessionID, err := uuid.Parse(c.Params("sessionId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
}

if err := s.services.Program.DeleteSession(c.Context(), programID, sessionID); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.SendStatus(fiber.StatusNoContent)
}

// --- Attendance ---

func (s *Server) handleMarkAttendance(c *fiber.Ctx) error {
sessionID, err := uuid.Parse(c.Params("sessionId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
}

var req struct {
ParticipantID uuid.UUID `json:"participant_id"`
Status        string    `json:"status"`
Notes         string    `json:"notes"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

attendance := &domain.ProgramAttendance{
SessionID:     sessionID,
ParticipantID: req.ParticipantID,
Status:        req.Status,
Notes:         &req.Notes,
}

if err := s.services.Program.MarkAttendance(c.Context(), attendance); err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(attendance)
}

func (s *Server) handleGetAttendance(c *fiber.Ctx) error {
sessionID, err := uuid.Parse(c.Params("sessionId"))
if err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
}

attendance, err := s.services.Program.GetAttendanceBySession(c.Context(), sessionID)
if err != nil {
return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
}

return c.JSON(attendance)
}
