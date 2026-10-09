package api

import (
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

// ── Logbook Handlers ──────────────────────────────────────────────────

func writeLogbookError(c *fiber.Ctx, err error) error {
	var postgresError *pgconn.PgError
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return c.Status(404).JSON(fiber.Map{"error": "Bitácora o entrada no encontrada"})
	case errors.Is(err, repository.ErrEventMembershipFrozen):
		return writeEventMembershipError(c, err)
	case errors.Is(err, repository.ErrLogbookNotesOutsideSnapshot):
		return c.Status(409).JSON(fiber.Map{"code": "LOGBOOK_NOTES_OUTSIDE_SNAPSHOT", "error": "No se aplicó la recaptura: hay notas en participantes fuera de la nueva selección. Conserva esos participantes o sus notas antes de volver a capturar."})
	case errors.Is(err, repository.ErrLogbookInvalid):
		return c.Status(422).JSON(fiber.Map{"error": "La fecha o el estado de la bitácora no es válido"})
	case errors.As(err, &postgresError) && postgresError.Code == "23505":
		return c.Status(409).JSON(fiber.Map{"error": "Ya existe una bitácora para esta fecha"})
	default:
		return c.Status(500).JSON(fiber.Map{"error": "No se pudo guardar la bitácora"})
	}
}

func logbookEventID(c *fiber.Ctx) (uuid.UUID, error) {
	return uuid.Parse(c.Params("id"))
}

// handleGetEventLogbooks returns all logbooks for an event.
func (s *Server) handleGetEventLogbooks(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	if ev, _ := s.services.Event.GetByID(c.Context(), eventID); ev == nil || ev.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"error": "event not found"})
	}

	logbooks, err := s.repos.Logbook.GetByEventIDForAccount(c.Context(), accountID, eventID)
	if err != nil {
		log.Printf("[API] Error getting logbooks for event %s: %v", eventID, err)
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
	}
	if logbooks == nil {
		logbooks = []*domain.EventLogbook{}
	}
	return c.JSON(logbooks)
}

// handleCreateEventLogbook creates a new logbook for a specific date.
func (s *Server) handleCreateEventLogbook(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	if ev, _ := s.services.Event.GetByID(c.Context(), eventID); ev == nil || ev.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"error": "event not found"})
	}

	var body struct {
		Date         string `json:"date"` // "2006-01-02"
		Title        string `json:"title"`
		GeneralNotes string `json:"general_notes"`
		CaptureNow   bool   `json:"capture_now"` // if true, immediately capture snapshot
		// Filter params (only used when capture_now=true)
		StageIDs        string   `json:"stage_ids"`
		TagNames        []string `json:"tag_names"`
		TagMode         string   `json:"tag_mode"`
		ExcludeTagNames []string `json:"exclude_tag_names"`
		TagFormula      string   `json:"tag_formula"`
		HasPhone        bool     `json:"has_phone"`
		DateField       string   `json:"date_field"`
		DateFrom        string   `json:"date_from"`
		DateTo          string   `json:"date_to"`
		TextSearch      string   `json:"text_search"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	if body.Date == "" {
		return c.Status(400).JSON(fiber.Map{"error": "date is required"})
	}

	date, err := time.Parse("2006-01-02", body.Date)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid date format, use YYYY-MM-DD"})
	}

	title := body.Title
	if title == "" {
		title = date.Format("02/01/2006")
	}

	lb := &domain.EventLogbook{
		EventID:       eventID,
		AccountID:     accountID,
		Date:          date,
		Title:         title,
		Status:        domain.LogbookStatusPending,
		GeneralNotes:  body.GeneralNotes,
		CreatedBy:     &userID,
		StageSnapshot: make(map[string]interface{}),
	}

	// Always save the filter if any filter params are provided
	hasFilter := body.StageIDs != "" || len(body.TagNames) > 0 || len(body.ExcludeTagNames) > 0 || body.TagFormula != "" || body.HasPhone || body.DateField != "" || body.TextSearch != ""
	var filter *repository.SnapshotFilter
	if hasFilter {
		filter = &repository.SnapshotFilter{
			StageIDs:        body.StageIDs,
			TagNames:        body.TagNames,
			TagMode:         body.TagMode,
			ExcludeTagNames: body.ExcludeTagNames,
			TagFormula:      body.TagFormula,
			HasPhone:        body.HasPhone,
			DateField:       body.DateField,
			DateFrom:        body.DateFrom,
			DateTo:          body.DateTo,
			TextSearch:      body.TextSearch,
		}
		filterJSON, _ := json.Marshal(filter)
		lb.SavedFilter = filterJSON
	}

	if err := s.repos.Logbook.Create(c.Context(), lb); err != nil {
		log.Printf("[API] Error creating logbook for event %s: %v", eventID, err)
		return writeLogbookError(c, err)
	}

	// If capture_now, immediately take snapshot
	if body.CaptureNow {
		captured, err := s.repos.Logbook.CaptureSnapshot(c.Context(), accountID, eventID, lb.ID, filter)
		if err != nil {
			log.Printf("[API] Error capturing snapshot for logbook %s: %v", lb.ID, err)
			// Return the pending logbook anyway
		} else {
			lb = captured
		}
	}

	// Broadcast
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "created",
			"event_id": eventID,
		})
	}

	return c.Status(201).JSON(lb)
}

// handleGetEventLogbook returns a single logbook with entries.
func (s *Server) handleGetEventLogbook(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}

	lb, err := s.repos.Logbook.GetByIDForEvent(c.Context(), accountID, eventID, logbookID)
	if err != nil || lb == nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}
	return c.JSON(lb)
}

// handleUpdateEventLogbook updates a logbook's title, notes, etc.
func (s *Server) handleUpdateEventLogbook(c *fiber.Ctx) error {
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	var body struct {
		Title        *string         `json:"title"`
		GeneralNotes *string         `json:"general_notes"`
		Date         *string         `json:"date"`
		SavedFilter  json.RawMessage `json:"saved_filter"`
		Status       *string         `json:"status"` // pending, active, completed
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(c.Body(), &fields); err != nil || fields == nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}
	for _, field := range []string{"title", "general_notes", "date", "status"} {
		if value, supplied := fields[field]; supplied && string(value) == "null" {
			return c.Status(400).JSON(fiber.Map{"error": "La fecha, el estado, el título y las notas deben tener un valor válido"})
		}
	}
	patch := repository.LogbookPatch{Title: body.Title, GeneralNotes: body.GeneralNotes, Status: body.Status}
	if body.Date != nil {
		d, err := time.Parse("2006-01-02", *body.Date)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"error": "Fecha inválida; usa YYYY-MM-DD"})
		}
		patch.Date = &d
	}
	if body.SavedFilter != nil {
		patch.SavedFilterPresent = true
		if string(body.SavedFilter) != "null" {
			patch.SavedFilter = body.SavedFilter
		}
	}

	lb, err := s.repos.Logbook.Update(c.Context(), accountID, eventID, logbookID, patch)
	if err != nil {
		log.Printf("[API] Error updating logbook %s: %v", logbookID, err)
		return writeLogbookError(c, err)
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "updated",
			"event_id": lb.EventID,
		})
	}

	return c.JSON(lb)
}

// handleDeleteEventLogbook deletes a logbook and its entries.
func (s *Server) handleDeleteEventLogbook(c *fiber.Ctx) error {
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	lb, err := s.repos.Logbook.GetByIDForEvent(c.Context(), accountID, eventID, logbookID)
	if err != nil || lb == nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}

	if err := s.repos.Logbook.Delete(c.Context(), accountID, eventID, logbookID); err != nil {
		log.Printf("[API] Error deleting logbook %s: %v", logbookID, err)
		return writeLogbookError(c, err)
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "deleted",
			"event_id": lb.EventID,
		})
	}

	return c.Status(204).Send(nil)
}

// handleCaptureLogbookSnapshot takes a snapshot of participants' current state.
// Accepts optional filter params in the JSON body to capture only filtered participants.
func (s *Server) handleCaptureLogbookSnapshot(c *fiber.Ctx) error {
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	if lbCheck, _ := s.repos.Logbook.GetByIDForEvent(c.Context(), accountID, eventID, logbookID); lbCheck == nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}

	// Parse optional filter body
	var body struct {
		StageIDs        string   `json:"stage_ids"`
		TagNames        []string `json:"tag_names"`
		TagMode         string   `json:"tag_mode"`
		ExcludeTagNames []string `json:"exclude_tag_names"`
		TagFormula      string   `json:"tag_formula"`
		HasPhone        bool     `json:"has_phone"`
		DateField       string   `json:"date_field"`
		DateFrom        string   `json:"date_from"`
		DateTo          string   `json:"date_to"`
		TextSearch      string   `json:"text_search"`
	}
	_ = c.BodyParser(&body) // ignore error — body is optional

	var filter *repository.SnapshotFilter
	if body.StageIDs != "" || len(body.TagNames) > 0 || len(body.ExcludeTagNames) > 0 || body.TagFormula != "" || body.HasPhone || body.DateField != "" || body.TextSearch != "" {
		filter = &repository.SnapshotFilter{
			StageIDs:        body.StageIDs,
			TagNames:        body.TagNames,
			TagMode:         body.TagMode,
			ExcludeTagNames: body.ExcludeTagNames,
			TagFormula:      body.TagFormula,
			HasPhone:        body.HasPhone,
			DateField:       body.DateField,
			DateFrom:        body.DateFrom,
			DateTo:          body.DateTo,
			TextSearch:      body.TextSearch,
		}
	}

	// If no filter provided in body, fall back to logbook's saved_filter
	if filter == nil {
		lb, err := s.repos.Logbook.GetByIDForEvent(c.Context(), accountID, eventID, logbookID)
		if err == nil && lb.SavedFilter != nil && len(lb.SavedFilter) > 2 {
			var sf repository.SnapshotFilter
			if err := json.Unmarshal(lb.SavedFilter, &sf); err == nil {
				if sf.StageIDs != "" || len(sf.TagNames) > 0 || len(sf.ExcludeTagNames) > 0 || sf.TagFormula != "" || sf.HasPhone || sf.DateField != "" || sf.TextSearch != "" {
					filter = &sf
				}
			}
		}
	}

	lb, err := s.repos.Logbook.CaptureSnapshot(c.Context(), accountID, eventID, logbookID, filter)
	if err != nil {
		log.Printf("[API] Error capturing snapshot for logbook %s: %v", logbookID, err)
		return writeLogbookError(c, err)
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "captured",
			"event_id": lb.EventID,
		})
	}

	return c.JSON(lb)
}

// handleUpdateLogbookEntry updates a single entry's notes.
func (s *Server) handleUpdateLogbookEntry(c *fiber.Ctx) error {
	entryID, err := uuid.Parse(c.Params("eid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid entry id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}

	var body struct {
		Notes string `json:"notes"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	if err := s.repos.Logbook.UpdateEntryNotes(c.Context(), accountID, eventID, logbookID, entryID, body.Notes); err != nil {
		log.Printf("[API] Error updating logbook entry %s: %v", entryID, err)
		return writeLogbookError(c, err)
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "entry_updated",
			"event_id": eventID,
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

// handleAutoCreateLogbooks auto-creates pending logbooks from the event's date range.
func (s *Server) handleAutoCreateLogbooks(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	// Get event to find date range
	event, err := s.repos.Event.GetByID(c.Context(), eventID)
	if err != nil || event == nil || event.AccountID != accountID {
		return c.Status(404).JSON(fiber.Map{"error": "event not found"})
	}

	if event.EventDate == nil {
		return c.Status(400).JSON(fiber.Map{"error": "event has no start date"})
	}

	endDate := event.EventDate
	if event.EventEnd != nil {
		endDate = event.EventEnd
	}

	created, err := s.repos.Logbook.AutoCreateFromDateRange(c.Context(), eventID, accountID, *event.EventDate, *endDate, &userID)
	if err != nil {
		log.Printf("[API] Error auto-creating logbooks for event %s: %v", eventID, err)
		return writeLogbookError(c, err)
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "auto_created",
			"event_id": eventID,
		})
	}

	return c.JSON(fiber.Map{
		"created":  len(created),
		"logbooks": created,
	})
}

// handleLogbookPreview returns a dynamic preview of participants matching the saved filter.
func (s *Server) handleLogbookPreview(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := logbookEventID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}

	lb, err := s.repos.Logbook.GetByIDForEvent(c.Context(), accountID, eventID, logbookID)
	if err != nil || lb == nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}
	if lb.Status != domain.LogbookStatusPending {
		return c.Status(400).JSON(fiber.Map{"error": "preview only available for pending logbooks"})
	}
	if len(lb.SavedFilter) == 0 {
		return c.JSON(fiber.Map{"participants": []interface{}{}, "total": 0})
	}

	participants, err := s.repos.Logbook.PreviewParticipants(c.Context(), accountID, eventID, logbookID)
	if err != nil {
		log.Printf("[API] Error previewing logbook %s: %v", logbookID, err)
		return c.Status(500).JSON(fiber.Map{"error": "could not preview participants"})
	}

	return c.JSON(fiber.Map{
		"participants": participants,
		"total":        len(participants),
	})
}
