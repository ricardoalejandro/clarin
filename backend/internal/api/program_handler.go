package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

// --- Programs ---

type migratedProgramEventLookup func(context.Context, uuid.UUID, uuid.UUID) (*uuid.UUID, bool, error)

func migratedProgramConflictPayload(migratedEventID *uuid.UUID) fiber.Map {
	response := fiber.Map{
		"code":  "PROGRAM_EVENT_MIGRATED",
		"error": "Este evento ya se administra desde el módulo Eventos. El registro de Programas es histórico y no puede modificarse.",
	}
	if migratedEventID != nil {
		response["migrated_event_id"] = *migratedEventID
	}
	return response
}

func (s *Server) rejectMigratedProgramMutation(c *fiber.Ctx, accountID, programID uuid.UUID) (bool, error) {
	migratedEventID, migrated, err := s.services.Program.GetMigratedEventTarget(c.Context(), accountID, programID)
	if err != nil {
		log.Printf("[programs] migrated source mutation validation failed account=%s program=%s: %v", accountID, programID, err)
		return true, c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo validar el programa"})
	}
	if !migrated {
		return false, nil
	}
	return true, c.Status(fiber.StatusConflict).JSON(migratedProgramConflictPayload(migratedEventID))
}

// guardMigratedProgramMutations protects the archived Program record and every
// descendant write after a legacy event has moved to Events. Registering this
// once above /:id routes also covers future participant/session mutations.
func guardMigratedProgramMutations(lookup migratedProgramEventLookup) fiber.Handler {
	return func(c *fiber.Ctx) error {
		switch c.Method() {
		case fiber.MethodGet, fiber.MethodHead, fiber.MethodOptions:
			return c.Next()
		}

		programID, err := uuid.Parse(c.Params("id"))
		if err != nil {
			return c.Next()
		}
		accountID, ok := c.Locals("account_id").(uuid.UUID)
		if !ok || accountID == uuid.Nil {
			return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"error": "Account context is required"})
		}
		migratedEventID, migrated, err := lookup(c.Context(), accountID, programID)
		if err != nil {
			log.Printf("[programs] migrated source mutation guard failed account=%s program=%s: %v", accountID, programID, err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo validar el programa"})
		}
		if !migrated {
			return c.Next()
		}

		return c.Status(fiber.StatusConflict).JSON(migratedProgramConflictPayload(migratedEventID))
	}
}

func (s *Server) handleCreateProgram(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Name              string     `json:"name"`
		Description       string     `json:"description"`
		Color             string     `json:"color"`
		Type              string     `json:"type"`
		ScheduleStartDate *string    `json:"schedule_start_date"`
		ScheduleEndDate   *string    `json:"schedule_end_date"`
		ScheduleDays      []int      `json:"schedule_days"`
		ScheduleStartTime *string    `json:"schedule_start_time"`
		ScheduleEndTime   *string    `json:"schedule_end_time"`
		PipelineID        *uuid.UUID `json:"pipeline_id"`
		TagFormula        string     `json:"tag_formula"`
		TagFormulaMode    string     `json:"tag_formula_mode"`
		TagFormulaType    string     `json:"tag_formula_type"`
		EventDate         *string    `json:"event_date"`
		EventEnd          *string    `json:"event_end"`
		Location          *string    `json:"location"`
		FolderID          *uuid.UUID `json:"folder_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	requestedType := strings.TrimSpace(req.Type)
	if requestedType != "" && requestedType != "course" {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"code":  "PROGRAM_EVENT_TYPE_RETIRED",
			"error": "Los programas son grupos de clases. Crea los eventos desde el módulo Eventos.",
		})
	}

	program := &domain.Program{
		AccountID:         accountID,
		Type:              "course",
		Name:              req.Name,
		Description:       &req.Description,
		Color:             req.Color,
		CreatedBy:         &userID,
		FolderID:          req.FolderID,
		ScheduleDays:      req.ScheduleDays,
		ScheduleStartTime: req.ScheduleStartTime,
		ScheduleEndTime:   req.ScheduleEndTime,
		PipelineID:        req.PipelineID,
		TagFormula:        req.TagFormula,
		TagFormulaMode:    req.TagFormulaMode,
		TagFormulaType:    req.TagFormulaType,
		Location:          req.Location,
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
	if req.EventDate != nil && *req.EventDate != "" {
		if t, err := time.Parse(time.RFC3339, *req.EventDate); err == nil {
			program.EventDate = &t
		} else if t2, err2 := time.Parse("2006-01-02", *req.EventDate); err2 == nil {
			program.EventDate = &t2
		}
	}
	if req.EventEnd != nil && *req.EventEnd != "" {
		if t, err := time.Parse(time.RFC3339, *req.EventEnd); err == nil {
			program.EventEnd = &t
		} else if t2, err2 := time.Parse("2006-01-02", *req.EventEnd); err2 == nil {
			program.EventEnd = &t2
		}
	}

	if err := s.services.Program.CreateProgram(c.Context(), program); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	s.invalidateProgramsCache(accountID)
	return c.Status(fiber.StatusCreated).JSON(program)
}

func (s *Server) handleListPrograms(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	status := strings.TrimSpace(c.Query("status"))
	if status != "" && status != "active" && status != "completed" && status != "archived" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program status"})
	}

	// Redis cache — 30s TTL
	programsCacheKey := ""
	if s.cache != nil {
		cacheStatus := status
		if cacheStatus == "" {
			cacheStatus = "all"
		}
		programsCacheKey = fmt.Sprintf("programs:%s:%s", accountID.String(), cacheStatus)
		if cached, err := s.cache.Get(c.Context(), programsCacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	programs, err := s.services.Program.ListPrograms(c.Context(), accountID, status)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	if programsCacheKey != "" && s.cache != nil {
		if data, err := json.Marshal(programs); err == nil {
			_ = s.cache.Set(c.Context(), programsCacheKey, data, 30*time.Second)
		}
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
		Type              string     `json:"type"`
		ScheduleStartDate *string    `json:"schedule_start_date"`
		ScheduleEndDate   *string    `json:"schedule_end_date"`
		ScheduleDays      []int      `json:"schedule_days"`
		ScheduleStartTime *string    `json:"schedule_start_time"`
		ScheduleEndTime   *string    `json:"schedule_end_time"`
		PipelineID        *uuid.UUID `json:"pipeline_id"`
		TagFormula        string     `json:"tag_formula"`
		TagFormulaMode    string     `json:"tag_formula_mode"`
		TagFormulaType    string     `json:"tag_formula_type"`
		EventDate         *string    `json:"event_date"`
		EventEnd          *string    `json:"event_end"`
		Location          *string    `json:"location"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	// Load existing to preserve type/folder when not provided
	existing, err := s.services.Program.GetProgram(c.Context(), accountID, id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if existing == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}
	if existing.MigratedEventID != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"code":              "PROGRAM_EVENT_MIGRATED",
			"error":             "Este evento ya se administra desde el módulo Eventos.",
			"migrated_event_id": existing.MigratedEventID,
		})
	}
	programType, err := resolveProgramTypeForUpdate(existing.Type, req.Type)
	if err != nil {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"code":  "PROGRAM_TYPE_IMMUTABLE",
			"error": err.Error(),
		})
	}

	program := &domain.Program{
		ID:                id,
		AccountID:         accountID,
		Type:              programType,
		FolderID:          existing.FolderID,
		Name:              req.Name,
		Description:       &req.Description,
		Status:            req.Status,
		Color:             req.Color,
		ScheduleDays:      req.ScheduleDays,
		ScheduleStartTime: req.ScheduleStartTime,
		ScheduleEndTime:   req.ScheduleEndTime,
		PipelineID:        req.PipelineID,
		TagFormula:        req.TagFormula,
		TagFormulaMode:    req.TagFormulaMode,
		TagFormulaType:    req.TagFormulaType,
		Location:          req.Location,
	}
	if program.Type == "event" {
		if program.PipelineID == nil {
			program.PipelineID = existing.PipelineID
		}
		if program.TagFormulaMode == "" {
			program.TagFormulaMode = existing.TagFormulaMode
		}
		if program.TagFormulaType == "" {
			program.TagFormulaType = existing.TagFormulaType
		}
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
	if req.EventDate != nil && *req.EventDate != "" {
		if t, err := time.Parse(time.RFC3339, *req.EventDate); err == nil {
			program.EventDate = &t
		} else if t2, err2 := time.Parse("2006-01-02", *req.EventDate); err2 == nil {
			program.EventDate = &t2
		}
	}
	if req.EventEnd != nil && *req.EventEnd != "" {
		if t, err := time.Parse(time.RFC3339, *req.EventEnd); err == nil {
			program.EventEnd = &t
		} else if t2, err2 := time.Parse("2006-01-02", *req.EventEnd); err2 == nil {
			program.EventEnd = &t2
		}
	}

	if err := s.services.Program.UpdateProgram(c.Context(), program); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	s.invalidateProgramsCache(accountID)
	return c.JSON(program)
}

func resolveProgramTypeForUpdate(existingType, requestedType string) (string, error) {
	existingType = strings.TrimSpace(existingType)
	if existingType == "" {
		existingType = "course"
	}
	requestedType = strings.TrimSpace(requestedType)
	if requestedType == "" || requestedType == existingType {
		return existingType, nil
	}
	return "", fmt.Errorf("el tipo de un programa no se puede cambiar; crea los eventos desde el módulo Eventos")
}

func (s *Server) handleDeleteProgram(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}

	if err := s.services.Program.DeleteProgram(c.Context(), accountID, id); err != nil {
		if errors.Is(err, service.ErrProgramInput) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{
				"code":  "LEGACY_EVENT_PROGRAM_PROTECTED",
				"error": "El registro histórico del evento se conserva para auditoría y no puede eliminarse desde Programas.",
			})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	s.invalidateProgramsCache(accountID)
	return c.SendStatus(fiber.StatusNoContent)
}

// --- Participants ---

func (s *Server) handleAddParticipant(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}

	var req struct {
		ContactID uuid.UUID  `json:"contact_id"`
		Status    string     `json:"status"`
		StageID   *uuid.UUID `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.ContactID == uuid.Nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Se requiere contact_id"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}
	if program.Status != "active" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Solo puedes agregar participantes a un programa activo"})
	}
	if program.Type != "event" && req.StageID != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "Las etapas solo corresponden a eventos heredados"})
	}
	contact, err := s.services.Contact.GetByID(c.Context(), req.ContactID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo validar el contacto"})
	}
	if contact == nil || contact.AccountID != accountID {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Contact not found"})
	}

	participant := &domain.ProgramParticipant{
		ProgramID: programID,
		ContactID: req.ContactID,
		StageID:   req.StageID,
		Status:    "active",
	}

	if err := s.services.Program.AddParticipant(c.Context(), accountID, participant); err != nil {
		if errors.Is(err, repository.ErrProgramParticipantAlreadyExists) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "El contacto ya pertenece a este programa. Una reincorporación debe registrarse de forma explícita."})
		}
		if errors.Is(err, repository.ErrProgramParticipantStageInvalid) {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "La etapa no pertenece al pipeline y cuenta de este evento"})
		}
		log.Printf("[programs] participant add failed for account %s, program %s: %v", accountID, programID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo agregar el participante"})
	}

	s.invalidateProgramsCache(accountID)
	return c.Status(fiber.StatusCreated).JSON(participant)
}

func (s *Server) handleAddProgramParticipantsBulk(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}

	var req struct {
		ContactIDs []uuid.UUID `json:"contact_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid request body"})
	}
	if len(req.ContactIDs) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Selecciona al menos un contacto"})
	}
	if len(req.ContactIDs) > 500 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Puedes agregar hasta 500 contactos por operación"})
	}

	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el programa"})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	if program.Status != "active" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Solo puedes agregar participantes a un programa activo"})
	}

	result, err := s.services.Program.AddParticipantsByContactIDs(c.Context(), accountID, programID, req.ContactIDs)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron agregar los contactos"})
	}
	s.invalidateProgramsCache(accountID)
	return c.JSON(fiber.Map{"success": true, "summary": result})
}

func (s *Server) handleListParticipants(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	participants, err := s.services.Program.ListParticipants(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudieron cargar los participantes"})
	}
	if participants == nil {
		participants = make([]*domain.ProgramParticipant, 0)
	}

	return c.JSON(participants)
}

func (s *Server) handleRemoveParticipant(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid participant ID"})
	}

	if err := s.services.Program.RemoveParticipant(c.Context(), accountID, programID, participantID); err != nil {
		switch {
		case errors.Is(err, repository.ErrProgramParticipantNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Participante no encontrado"})
		case errors.Is(err, repository.ErrProgramParticipantHasActivity):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Esta inscripción ya tiene historial. Retira al participante para conservar su asistencia y observaciones."})
		default:
			log.Printf("[programs] participant enrollment annul failed account=%s program=%s participant=%s: %v", accountID, programID, participantID, err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo anular la inscripción"})
		}
	}

	s.invalidateProgramsCache(accountID)
	return c.SendStatus(fiber.StatusNoContent)
}

// --- Sessions ---

type programSessionTopicRequest struct {
	Kind          string     `json:"kind"`
	CourseTopicID *uuid.UUID `json:"course_topic_id"`
	Title         string     `json:"title"`
}

func mapProgramSessionTopics(input []programSessionTopicRequest) []*domain.ProgramSessionTopic {
	topics := make([]*domain.ProgramSessionTopic, 0, len(input))
	for position, item := range input {
		topics = append(topics, &domain.ProgramSessionTopic{
			Kind:               item.Kind,
			CourseTopicID:      item.CourseTopicID,
			TopicTitleSnapshot: item.Title,
			Position:           position,
		})
	}
	return topics
}

func (s *Server) handleCreateSession(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	var req struct {
		Date          string                       `json:"date"`
		Title         *string                      `json:"title"`
		Topic         string                       `json:"topic"`
		CourseTopicID *uuid.UUID                   `json:"course_topic_id"`
		Topics        []programSessionTopicRequest `json:"topics"`
		SessionType   string                       `json:"session_type"`
		StartTime     *string                      `json:"start_time"`
		EndTime       *string                      `json:"end_time"`
		Location      *string                      `json:"location"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	parsedDate, err := time.Parse("2006-01-02", req.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid date format, expected YYYY-MM-DD"})
	}

	session := &domain.ProgramSession{
		ProgramID:     programID,
		Date:          parsedDate,
		Topic:         &req.Topic,
		CourseTopicID: req.CourseTopicID,
		Topics:        mapProgramSessionTopics(req.Topics),
		SessionType:   req.SessionType,
		StartTime:     req.StartTime,
		EndTime:       req.EndTime,
		Location:      req.Location,
	}
	if req.Title != nil {
		session.Title = *req.Title
		session.TitleProvided = true
	}

	if err := s.services.Program.CreateSession(c.Context(), accountID, session); err != nil {
		return writeAcademicAPIError(c, err)
	}

	return c.Status(fiber.StatusCreated).JSON(session)
}

func (s *Server) handleListSessions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	sessions, err := s.services.Program.ListSessions(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if sessions == nil {
		sessions = make([]*domain.ProgramSession, 0)
	}

	return c.JSON(sessions)
}

func (s *Server) handleUpdateSession(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}

	var req struct {
		Date          string                       `json:"date"`
		Title         *string                      `json:"title"`
		Topic         string                       `json:"topic"`
		CourseTopicID *uuid.UUID                   `json:"course_topic_id"`
		Topics        []programSessionTopicRequest `json:"topics"`
		SessionType   string                       `json:"session_type"`
		StartTime     *string                      `json:"start_time"`
		EndTime       *string                      `json:"end_time"`
		Location      *string                      `json:"location"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	parsedDate, err := time.Parse("2006-01-02", req.Date)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid date format, expected YYYY-MM-DD"})
	}

	session := &domain.ProgramSession{
		ID:            sessionID,
		ProgramID:     programID,
		Date:          parsedDate,
		Topic:         &req.Topic,
		CourseTopicID: req.CourseTopicID,
		Topics:        mapProgramSessionTopics(req.Topics),
		SessionType:   req.SessionType,
		StartTime:     req.StartTime,
		EndTime:       req.EndTime,
		Location:      req.Location,
	}
	if req.Title != nil {
		session.Title = *req.Title
		session.TitleProvided = true
	}

	if err := s.services.Program.UpdateSession(c.Context(), accountID, session); err != nil {
		return writeAcademicAPIError(c, err)
	}

	return c.JSON(session)
}

func (s *Server) handleDeleteSession(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}

	if err := s.services.Program.DeleteSession(c.Context(), accountID, programID, sessionID); err != nil {
		return writeAcademicAPIError(c, err)
	}

	return c.SendStatus(fiber.StatusNoContent)
}

// --- Attendance ---

func (s *Server) handleMarkAttendance(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}
	var sessionOK bool
	if err := s.repos.DB().QueryRow(c.Context(), `
SELECT EXISTS(
  SELECT 1 FROM program_sessions ps
  JOIN programs p ON p.id = ps.program_id
  WHERE p.account_id = $1 AND ps.program_id = $2 AND ps.id = $3
	)`, accountID, programID, sessionID).Scan(&sessionOK); err != nil {
		log.Printf("program attendance context lookup failed account=%s program=%s session=%s: %v", accountID, programID, sessionID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo cargar la asistencia"})
	}
	if !sessionOK {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Session not found"})
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

	if err := s.services.Program.MarkAttendance(c.Context(), accountID, userID, programID, sessionID, attendance); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(attendance)
}

func (s *Server) handleBatchMarkAttendance(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}
	var sessionOK bool
	if err := s.repos.DB().QueryRow(c.Context(), `
SELECT EXISTS(
  SELECT 1 FROM program_sessions ps
  JOIN programs p ON p.id = ps.program_id
  WHERE p.account_id = $1 AND ps.program_id = $2 AND ps.id = $3
)`, accountID, programID, sessionID).Scan(&sessionOK); err != nil {
		log.Printf("program attendance context lookup failed account=%s program=%s session=%s: %v", accountID, programID, sessionID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo cargar la asistencia"})
	}
	if !sessionOK {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Session not found"})
	}

	var req struct {
		Records []struct {
			ParticipantID uuid.UUID `json:"participant_id"`
			Status        string    `json:"status"`
			Notes         string    `json:"notes"`
		} `json:"records"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}
	if len(req.Records) == 0 {
		return c.JSON(fiber.Map{"success": true, "count": 0})
	}

	var attendances []*domain.ProgramAttendance
	for _, r := range req.Records {
		notes := r.Notes
		attendances = append(attendances, &domain.ProgramAttendance{
			SessionID:     sessionID,
			ParticipantID: r.ParticipantID,
			Status:        r.Status,
			Notes:         &notes,
		})
	}

	if err := s.services.Program.BatchMarkAttendance(c.Context(), accountID, userID, programID, sessionID, attendances); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true, "count": len(attendances)})
}

func (s *Server) handleGetAttendance(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid session ID"})
	}
	var sessionOK bool
	if err := s.repos.DB().QueryRow(c.Context(), `
SELECT EXISTS(
  SELECT 1 FROM program_sessions ps
  JOIN programs p ON p.id = ps.program_id
  WHERE p.account_id = $1 AND ps.program_id = $2 AND ps.id = $3
)`, accountID, programID, sessionID).Scan(&sessionOK); err != nil {
		log.Printf("program attendance context lookup failed account=%s program=%s session=%s: %v", accountID, programID, sessionID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo cargar la asistencia"})
	}
	if !sessionOK {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Session not found"})
	}

	attendance, err := s.services.Program.GetAttendanceBySession(c.Context(), accountID, sessionID)
	if err != nil {
		log.Printf("program attendance load failed account=%s program=%s session=%s: %v", accountID, programID, sessionID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo cargar la asistencia"})
	}

	return c.JSON(attendance)
}

func parseAttendanceObservationPath(c *fiber.Ctx) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	sessionID, err := uuid.Parse(c.Params("sessionId"))
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return uuid.Nil, uuid.Nil, uuid.Nil, err
	}
	return programID, sessionID, participantID, nil
}

func (s *Server) handleListAttendanceObservations(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, sessionID, participantID, err := parseAttendanceObservationPath(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid attendance context"})
	}
	observations, err := s.services.Program.ListAttendanceObservations(c.Context(), accountID, programID, sessionID, participantID)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "observations": observations})
}

func (s *Server) handleCreateAttendanceObservation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	programID, sessionID, participantID, err := parseAttendanceObservationPath(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid attendance context"})
	}
	var req struct {
		Notes string `json:"notes"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid request body"})
	}
	observation, err := s.services.Program.CreateAttendanceObservation(c.Context(), accountID, userID, programID, sessionID, participantID, req.Notes)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "observation": observation})
}

func (s *Server) handleDeleteAttendanceObservation(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, sessionID, participantID, err := parseAttendanceObservationPath(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid attendance context"})
	}
	observationID, err := uuid.Parse(c.Params("observationId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid observation ID"})
	}
	if err := s.services.Program.DeleteAttendanceObservation(c.Context(), accountID, programID, sessionID, participantID, observationID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Observation not found"})
		}
		return writeAcademicAPIError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

// handleGenerateSessions generates recurring sessions based on schedule config
func (s *Server) handleGenerateSessions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}

	var req struct {
		StartDate          string  `json:"start_date"`
		EndDate            string  `json:"end_date"`
		DaysOfWeek         []int   `json:"days_of_week"`
		StartTime          string  `json:"start_time"`
		EndTime            string  `json:"end_time"`
		TitlePrefix        string  `json:"title_prefix"`
		TopicPrefix        string  `json:"topic_prefix"`
		Location           *string `json:"location"`
		AssignCourseTopics bool    `json:"assign_course_topics"`
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

	titlePrefix := resolveSessionTitlePrefix(req.TitlePrefix, req.TopicPrefix)

	result, err := s.services.Program.GenerateSessions(
		c.Context(), accountID, programID, startDate, endDate,
		req.DaysOfWeek, req.StartTime, req.EndTime, titlePrefix, req.Location, req.AssignCourseTopics,
	)
	if err != nil {
		return writeAcademicAPIError(c, err)
	}

	response := fiber.Map{
		"success":              true,
		"sessions":             result.Sessions,
		"count":                len(result.Sessions),
		"assigned_topic_count": result.AssignedTopicCount,
		"fallback_count":       result.FallbackCount,
	}
	if result.Warning != "" {
		response["warning"] = result.Warning
	}
	return c.Status(fiber.StatusCreated).JSON(response)
}

func resolveSessionTitlePrefix(titlePrefix, legacyTopicPrefix string) string {
	if value := strings.TrimSpace(titlePrefix); value != "" {
		return value
	}
	if value := strings.TrimSpace(legacyTopicPrefix); value != "" {
		return value
	}
	return "Sesión"
}

// handleCreateCampaignFromProgram creates a campaign with program participants as recipients
func (s *Server) handleCreateCampaignFromProgram(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if program == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
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

	// Operational campaigns use only the current roster. Historical
	// participants remain available in the program detail but are never added
	// silently as campaign recipients.
	participants, err := s.services.Program.ListParticipants(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	activeParticipants := make([]*domain.ProgramParticipant, 0, len(participants))
	for _, participant := range participants {
		if participant.Status == "active" {
			activeParticipants = append(activeParticipants, participant)
		}
	}
	if len(activeParticipants) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "No hay participantes activos en este programa"})
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
	// Set created_by from authenticated user
	if userID, ok := c.Locals("user_id").(uuid.UUID); ok {
		campaign.CreatedBy = &userID
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
	for _, p := range activeParticipants {
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
	s.invalidateCampaignsCache(accountID)

	return c.Status(201).JSON(fiber.Map{
		"success":          true,
		"campaign":         campaign,
		"recipients_count": len(recipients),
	})
}

// =================== Program Folders ===================

func (s *Server) handleGetProgramFolders(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programStatus := strings.TrimSpace(c.Query("status"))
	if programStatus != "" && programStatus != "active" && programStatus != "completed" && programStatus != "archived" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program status"})
	}
	folders, err := s.services.Program.GetFolders(c.Context(), accountID, programStatus)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if folders == nil {
		folders = make([]*domain.ProgramFolder, 0)
	}
	return c.JSON(fiber.Map{"success": true, "folders": folders})
}

func (s *Server) handleCreateProgramFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		ParentID *string `json:"parent_id"`
		Name     string  `json:"name"`
		Color    string  `json:"color"`
		Icon     string  `json:"icon"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}
	folder := &domain.ProgramFolder{
		AccountID: accountID,
		Name:      req.Name,
		Color:     req.Color,
		Icon:      req.Icon,
	}
	if req.ParentID != nil && *req.ParentID != "" {
		pid, err := uuid.Parse(*req.ParentID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid parent folder ID"})
		}
		folder.ParentID = &pid
	}
	if err := s.services.Program.CreateFolder(c.Context(), folder); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "folder": folder})
}

func (s *Server) handleUpdateProgramFolder(c *fiber.Ctx) error {
	fid, err := uuid.Parse(c.Params("fid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
	}
	folder, err := s.services.Program.GetFolderByID(c.Context(), fid)
	if err != nil || folder == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Folder not found"})
	}
	var req struct {
		Name  *string `json:"name"`
		Color *string `json:"color"`
		Icon  *string `json:"icon"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name != nil {
		folder.Name = *req.Name
	}
	if req.Color != nil {
		folder.Color = *req.Color
	}
	if req.Icon != nil {
		folder.Icon = *req.Icon
	}
	if err := s.services.Program.UpdateFolder(c.Context(), folder); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "folder": folder})
}

func (s *Server) handleDeleteProgramFolder(c *fiber.Ctx) error {
	fid, err := uuid.Parse(c.Params("fid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
	}
	if err := s.services.Program.DeleteFolder(c.Context(), fid); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleMoveProgramToFolder(c *fiber.Ctx) error {
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	var req struct {
		FolderID *string `json:"folder_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	var folderID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		fid, err := uuid.Parse(*req.FolderID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid folder ID"})
		}
		folderID = &fid
	}
	if err := s.services.Program.MoveProgramToFolder(c.Context(), programID, folderID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

// =================== Attendance Stats ===================

func (s *Server) handleGetAttendanceStats(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if program == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	months, err := parseAttendanceStatsMonths(c.Query("months", ""))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "months must be a comma-separated list in YYYY-MM format"})
	}
	sessionStats, participantStats, err := s.services.Program.GetAttendanceStats(c.Context(), accountID, programID, months)
	if err != nil {
		log.Printf("program attendance stats failed account=%s program=%s: %v", accountID, programID, err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Could not load attendance statistics"})
	}
	if sessionStats == nil {
		sessionStats = make([]*domain.ProgramSessionAttendanceStat, 0)
	}
	if participantStats == nil {
		participantStats = make([]*domain.ProgramParticipantAttendanceStat, 0)
	}
	return c.JSON(fiber.Map{
		"success":           true,
		"session_stats":     sessionStats,
		"participant_stats": participantStats,
	})
}

func parseAttendanceStatsMonths(value string) ([]time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	seen := make(map[string]struct{})
	months := make([]time.Time, 0)
	for _, raw := range strings.Split(value, ",") {
		month := strings.TrimSpace(raw)
		parsed, err := time.Parse("2006-01", month)
		if err != nil || parsed.Format("2006-01") != month {
			return nil, fmt.Errorf("invalid month %q", month)
		}
		if _, ok := seen[month]; ok {
			continue
		}
		seen[month] = struct{}{}
		months = append(months, parsed)
	}
	return months, nil
}

func parseProgramOptionalTime(value string) (*time.Time, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}
	if t, err := time.Parse(time.RFC3339, value); err == nil {
		return &t, nil
	}
	t, err := time.Parse("2006-01-02", value)
	if err != nil {
		return nil, err
	}
	return &t, nil
}

func (s *Server) handleGetProgramsDashboard(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	from, err := parseProgramOptionalTime(c.Query("from", ""))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid from date"})
	}
	to, err := parseProgramOptionalTime(c.Query("to", ""))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid to date"})
	}
	dashboard, err := s.services.Program.GetProgramsDashboard(c.Context(), accountID, from, to)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "dashboard": dashboard})
}

func (s *Server) handleGetGlobalProgramGoals(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	goals, err := s.services.Program.GetProgramGoals(c.Context(), accountID, nil)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "goals": goals})
}

func (s *Server) handleUpsertGlobalProgramGoals(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		AttendanceGoalPercent int `json:"attendance_goal_percent"`
		TransferGoalPercent   int `json:"transfer_goal_percent"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	goals := &domain.ProgramGoal{
		AccountID:             accountID,
		AttendanceGoalPercent: req.AttendanceGoalPercent,
		TransferGoalPercent:   req.TransferGoalPercent,
	}
	if err := s.services.Program.UpsertProgramGoals(c.Context(), goals); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "goals": goals})
}

func (s *Server) handleGetProgramGoals(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if program == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	goals, err := s.services.Program.GetProgramGoals(c.Context(), accountID, &programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "goals": goals})
}

func (s *Server) handleUpsertProgramGoals(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	var req struct {
		AttendanceGoalPercent int `json:"attendance_goal_percent"`
		TransferGoalPercent   int `json:"transfer_goal_percent"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	goals := &domain.ProgramGoal{
		AccountID:             accountID,
		ProgramID:             &programID,
		AttendanceGoalPercent: req.AttendanceGoalPercent,
		TransferGoalPercent:   req.TransferGoalPercent,
	}
	if err := s.services.Program.UpsertProgramGoals(c.Context(), goals); err != nil {
		if err == pgx.ErrNoRows {
			return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true, "goals": goals})
}

func (s *Server) handleGetProgramHealth(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	health, err := s.services.Program.GetProgramHealth(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if health == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	return c.JSON(fiber.Map{"success": true, "health": health})
}

func (s *Server) handleUpdateProgramParticipantOutcome(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	var req struct {
		Status             string `json:"status"`
		DroppedAt          string `json:"dropped_at"`
		DropReason         string `json:"drop_reason"`
		DropNotes          string `json:"drop_notes"`
		CompletedAt        string `json:"completed_at"`
		TransferredToLevel string `json:"transferred_to_level"`
		TransferredAt      string `json:"transferred_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	droppedAt, err := parseProgramOptionalTime(req.DroppedAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid dropped_at"})
	}
	completedAt, err := parseProgramOptionalTime(req.CompletedAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid completed_at"})
	}
	transferredAt, err := parseProgramOptionalTime(req.TransferredAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid transferred_at"})
	}
	if err := s.services.Program.UpdateParticipantOutcome(c.Context(), accountID, programID, participantID, req.Status, droppedAt, req.DropReason, req.DropNotes, completedAt, req.TransferredToLevel, transferredAt); err != nil {
		switch {
		case errors.Is(err, repository.ErrProgramParticipantNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Participante no encontrado"})
		case errors.Is(err, repository.ErrProgramParticipantAlreadyEnded):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La participación ya está en el historial. No se reactivó ni se reemplazó automáticamente."})
		case errors.Is(err, repository.ErrProgramParticipantEndBeforeEnrollment):
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La fecha de retiro o finalización no puede ser anterior a la incorporación"})
		case errors.Is(err, service.ErrProgramParticipantEndInFuture):
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La fecha de retiro, finalización o transferencia no puede estar en el futuro"})
		default:
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
	}
	s.invalidateProgramsCache(accountID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUpdateProgramParticipantEnrollment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Programa inválido"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Participante inválido"})
	}
	var req struct {
		EnrolledAt string `json:"enrolled_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	enrolledAt, err := time.Parse("2006-01-02", strings.TrimSpace(req.EnrolledAt))
	if err != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La fecha de incorporación debe tener el formato AAAA-MM-DD"})
	}
	updated, err := s.services.Program.UpdateParticipantEnrollmentDate(c.Context(), accountID, programID, participantID, enrolledAt)
	switch {
	case errors.Is(err, repository.ErrProgramParticipantNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Participante no encontrado"})
	case errors.Is(err, repository.ErrProgramParticipantEnrollmentAfterEnd):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La fecha de incorporación no puede ser posterior al retiro o finalización"})
	case errors.Is(err, service.ErrProgramInput):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La fecha de incorporación no puede estar en el futuro"})
	case err != nil:
		log.Printf("[programs] enrollment date update failed account=%s program=%s participant=%s: %v", accountID, programID, participantID, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo actualizar la fecha de incorporación"})
	}
	return c.JSON(fiber.Map{"success": true, "enrolled_at": updated.Format("2006-01-02")})
}

func (s *Server) handleListProgramParticipantNotes(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if program == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	notes, err := s.services.Program.ListParticipantNotes(c.Context(), accountID, programID, &participantID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if notes == nil {
		notes = make([]*domain.ProgramParticipantNote, 0)
	}
	return c.JSON(fiber.Map{"success": true, "notes": notes})
}

func (s *Server) handleCreateProgramParticipantNote(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	var req struct {
		SessionID  *uuid.UUID `json:"session_id"`
		Type       string     `json:"type"`
		Note       string     `json:"note"`
		Outcome    string     `json:"outcome"`
		FollowUpAt string     `json:"follow_up_at"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if program == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Program not found"})
	}
	participants, err := s.services.Program.ListParticipants(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	var participant *domain.ProgramParticipant
	for _, p := range participants {
		if p.ID == participantID {
			participant = p
			break
		}
	}
	if participant == nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Participant not found"})
	}
	followUpAt, err := parseProgramOptionalTime(req.FollowUpAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid follow_up_at"})
	}
	note := &domain.ProgramParticipantNote{
		AccountID:     accountID,
		ProgramID:     programID,
		ParticipantID: participantID,
		ContactID:     participant.ContactID,
		SessionID:     req.SessionID,
		Type:          req.Type,
		Note:          req.Note,
		Outcome:       req.Outcome,
		FollowUpAt:    followUpAt,
		CreatedBy:     &userID,
	}
	if err := s.services.Program.CreateParticipantNote(c.Context(), note); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "note": note})
}

// --- Participant Stage (Kanban drag) ---

func (s *Server) handleUpdateProgramParticipantStage(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	programID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid program ID"})
	}
	participantID, err := uuid.Parse(c.Params("participantId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid participant ID"})
	}

	// Verify the program belongs to this account and is of type 'event'
	program, err := s.services.Program.GetProgram(c.Context(), accountID, programID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if program == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Program not found"})
	}
	if program.Type != "event" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Stages only apply to event-type programs"})
	}

	var req struct {
		StageID *uuid.UUID `json:"stage_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if err := s.services.Program.UpdateParticipantStage(c.Context(), accountID, programID, participantID, req.StageID); err != nil {
		if errors.Is(err, repository.ErrProgramParticipantNotFound) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Participant not found"})
		}
		if errors.Is(err, repository.ErrProgramParticipantStageInvalid) {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"error": "La etapa no pertenece al pipeline y cuenta de este evento"})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	return c.JSON(fiber.Map{"success": true})
}
