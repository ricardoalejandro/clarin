package api

import (
"strings"
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
Name              string     `json:"name"`
Description       string     `json:"description"`
Color             string     `json:"color"`
ScheduleStartDate *string    `json:"schedule_start_date"`
ScheduleEndDate   *string    `json:"schedule_end_date"`
ScheduleDays      []int      `json:"schedule_days"`
ScheduleStartTime *string    `json:"schedule_start_time"`
ScheduleEndTime   *string    `json:"schedule_end_time"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

program := &domain.Program{
AccountID:         accountID,
Name:              req.Name,
Description:       &req.Description,
Color:             req.Color,
		CreatedBy:         &userID,
		ScheduleDays:      req.ScheduleDays,
		ScheduleStartTime: req.ScheduleStartTime,
		ScheduleEndTime:   req.ScheduleEndTime,
	}

	if req.ScheduleStartDate != nil {
		if t, err := time.Parse("2006-01-02", *req.ScheduleStartDate); err == nil {
			program.ScheduleStartDate = &t
		}
	}
	if req.ScheduleEndDate != nil {
		if t, err := time.Parse("2006-01-02", *req.ScheduleEndDate); err == nil {
			program.ScheduleEndDate = &t
		}
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
Name              string     `json:"name"`
Description       string     `json:"description"`
Status            string     `json:"status"`
Color             string     `json:"color"`
ScheduleStartDate *string    `json:"schedule_start_date"`
ScheduleEndDate   *string    `json:"schedule_end_date"`
ScheduleDays      []int      `json:"schedule_days"`
ScheduleStartTime *string    `json:"schedule_start_time"`
ScheduleEndTime   *string    `json:"schedule_end_time"`
}
if err := c.BodyParser(&req); err != nil {
return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
}

program := &domain.Program{
ID:                id,
AccountID:         accountID,
Name:              req.Name,
Description:       &req.Description,
Status:            req.Status,
Color:             req.Color,
ScheduleDays:      req.ScheduleDays,
ScheduleStartTime: req.ScheduleStartTime,
ScheduleEndTime:   req.ScheduleEndTime,
}

if req.ScheduleStartDate != nil {
	if t, err := time.Parse("2006-01-02", *req.ScheduleStartDate); err == nil {
		program.ScheduleStartDate = &t
	}
}
if req.ScheduleEndDate != nil {
	if t, err := time.Parse("2006-01-02", *req.ScheduleEndDate); err == nil {
		program.ScheduleEndDate = &t
	}
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
Date      string  `json:"date"`
Topic     string  `json:"topic"`
StartTime *string `json:"start_time"`
EndTime   *string `json:"end_time"`
Location  *string `json:"location"`
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
StartTime: req.StartTime,
EndTime:   req.EndTime,
Location:  req.Location,
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
Date      string  `json:"date"`
Topic     string  `json:"topic"`
StartTime *string `json:"start_time"`
EndTime   *string `json:"end_time"`
Location  *string `json:"location"`
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
StartTime: req.StartTime,
EndTime:   req.EndTime,
Location:  req.Location,
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

// handleGenerateSessions generates recurring sessions based on schedule config
func (s *Server) handleGenerateSessions(c *fiber.Ctx) error {
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}

	var req struct {
		StartDate   string  `json:"start_date"`
		EndDate     string  `json:"end_date"`
		DaysOfWeek  []int   `json:"days_of_week"`
		StartTime   string  `json:"start_time"`
		EndTime     string  `json:"end_time"`
		TopicPrefix string  `json:"topic_prefix"`
		Location    *string `json:"location"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	startDate, err := time.Parse("2006-01-02", req.StartDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid start_date format"})
	}
	endDate, err := time.Parse("2006-01-02", req.EndDate)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid end_date format"})
	}

	if req.TopicPrefix == "" {
		req.TopicPrefix = "Sesión"
	}

	sessions, err := s.services.Program.GenerateSessions(
		c.Context(), programID, startDate, endDate,
		req.DaysOfWeek, req.StartTime, req.EndTime, req.TopicPrefix, req.Location,
	)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success":  true,
		"sessions": sessions,
		"count":    len(sessions),
	})
}

// handleCreateCampaignFromProgram creates a campaign with program participants as recipients
func (s *Server) handleCreateCampaignFromProgram(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}

	var req struct {
		Name            string                 `json:"name"`
		DeviceID        string                 `json:"device_id"`
		MessageTemplate string                 `json:"message_template"`
		ScheduledAt     *time.Time             `json:"scheduled_at"`
		Settings        map[string]interface{} `json:"settings"`
		Attachments     []struct {
			MediaURL  string `json:"media_url"`
			MediaType string `json:"media_type"`
			Caption   string `json:"caption"`
			FileName  string `json:"file_name"`
			FileSize  int64  `json:"file_size"`
			Position  int    `json:"position"`
		} `json:"attachments"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" || req.DeviceID == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "name and device_id are required"})
	}
	if req.MessageTemplate == "" && len(req.Attachments) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_template or attachments required"})
	}

	deviceID, err := uuid.Parse(req.DeviceID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid device ID"})
	}

	// Get all participants with phone
	participants, err := s.services.Program.ListParticipants(c.Context(), programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	if len(participants) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No hay participantes en este programa"})
	}

	// Create campaign
	source := "program"
	campaign := &domain.Campaign{
		AccountID:       accountID,
		DeviceID:        deviceID,
		Name:            req.Name,
		MessageTemplate: req.MessageTemplate,
		ScheduledAt:     req.ScheduledAt,
		Settings:        req.Settings,
		Source:          &source,
	}
	if err := s.services.Campaign.Create(c.Context(), campaign); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	// Save attachments
	if len(req.Attachments) > 0 {
		var attachments []*domain.CampaignAttachment
		for _, a := range req.Attachments {
			attachments = append(attachments, &domain.CampaignAttachment{
				MediaURL:  a.MediaURL,
				MediaType: a.MediaType,
				Caption:   a.Caption,
				FileName:  a.FileName,
				FileSize:  a.FileSize,
				Position:  a.Position,
			})
		}
		if err := s.repos.CampaignAttachment.CreateBatch(c.Context(), campaign.ID, attachments); err != nil {
			// non-fatal
			_ = err
		}
		campaign.Attachments = attachments
	}

	// Add participants as recipients
	var recipients []*domain.CampaignRecipient
	for _, p := range participants {
		if p.ContactPhone == nil || *p.ContactPhone == "" {
			continue
		}
		phone := strings.TrimPrefix(*p.ContactPhone, "+")
		jid := phone + "@s.whatsapp.net"
		rec := &domain.CampaignRecipient{
			CampaignID: campaign.ID,
			ContactID:  &p.ContactID,
			JID:        jid,
			Name:       &p.ContactName,
			Phone:      p.ContactPhone,
		}
		recipients = append(recipients, rec)
	}

	if len(recipients) > 0 {
		if err := s.services.Campaign.AddRecipients(c.Context(), recipients); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}

	return c.Status(201).JSON(fiber.Map{
		"success":          true,
		"campaign":         campaign,
		"recipients_count": len(recipients),
	})
}
