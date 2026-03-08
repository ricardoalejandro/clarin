package api

import (
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

// ── Logbook Handlers ──────────────────────────────────────────────────

// handleGetEventLogbooks returns all logbooks for an event.
func (s *Server) handleGetEventLogbooks(c *fiber.Ctx) error {
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid event id"})
	}

	logbooks, err := s.repos.Logbook.GetByEventID(c.Context(), eventID)
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

	var body struct {
		Date            string   `json:"date"`            // "2006-01-02"
		Title           string   `json:"title"`
		GeneralNotes    string   `json:"general_notes"`
		CaptureNow      bool     `json:"capture_now"`     // if true, immediately capture snapshot
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
	hasFilter := body.StageIDs != "" || len(body.TagNames) > 0 || len(body.ExcludeTagNames) > 0 || body.TagFormula != "" || body.HasPhone || body.DateField != ""
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
		}
		filterJSON, _ := json.Marshal(filter)
		lb.SavedFilter = filterJSON
	}

	if err := s.repos.Logbook.Create(c.Context(), lb); err != nil {
		log.Printf("[API] Error creating logbook for event %s: %v", eventID, err)
		if strings.Contains(err.Error(), "duplicate key") || strings.Contains(err.Error(), "23505") {
			return c.Status(409).JSON(fiber.Map{"error": "Ya existe una bitácora para esta fecha"})
		}
		return c.Status(500).JSON(fiber.Map{"error": "could not create logbook"})
	}

	// If capture_now, immediately take snapshot
	if body.CaptureNow {
		captured, err := s.repos.Logbook.CaptureSnapshot(c.Context(), lb.ID, filter)
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
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}

	lb, err := s.repos.Logbook.GetByID(c.Context(), logbookID)
	if err != nil {
		log.Printf("[API] Error getting logbook %s: %v", logbookID, err)
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}
	return c.JSON(lb)
}

// handleUpdateEventLogbook updates a logbook's title, notes, etc.
func (s *Server) handleUpdateEventLogbook(c *fiber.Ctx) error {
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	lb, err := s.repos.Logbook.GetByID(c.Context(), logbookID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}

	var body struct {
		Title        *string `json:"title"`
		GeneralNotes *string `json:"general_notes"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	if body.Title != nil {
		lb.Title = *body.Title
	}
	if body.GeneralNotes != nil {
		lb.GeneralNotes = *body.GeneralNotes
	}

	if err := s.repos.Logbook.Update(c.Context(), lb); err != nil {
		log.Printf("[API] Error updating logbook %s: %v", logbookID, err)
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
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
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

	lb, err := s.repos.Logbook.GetByID(c.Context(), logbookID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}

	if err := s.repos.Logbook.Delete(c.Context(), logbookID); err != nil {
		log.Printf("[API] Error deleting logbook %s: %v", logbookID, err)
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
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
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)

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
	}
	_ = c.BodyParser(&body) // ignore error — body is optional

	var filter *repository.SnapshotFilter
	if body.StageIDs != "" || len(body.TagNames) > 0 || len(body.ExcludeTagNames) > 0 || body.TagFormula != "" || body.HasPhone || body.DateField != "" {
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
		}
	}

	lb, err := s.repos.Logbook.CaptureSnapshot(c.Context(), logbookID, filter)
	if err != nil {
		log.Printf("[API] Error capturing snapshot for logbook %s: %v", logbookID, err)
		return c.Status(500).JSON(fiber.Map{"error": "could not capture snapshot"})
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
	eventID, _ := uuid.Parse(c.Params("id"))

	var body struct {
		Notes string `json:"notes"`
	}
	if err := c.BodyParser(&body); err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid body"})
	}

	if err := s.repos.Logbook.UpdateEntryNotes(c.Context(), entryID, body.Notes); err != nil {
		log.Printf("[API] Error updating logbook entry %s: %v", entryID, err)
		return c.Status(500).JSON(fiber.Map{"error": "internal error"})
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
	if err != nil || event == nil {
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
		return c.Status(500).JSON(fiber.Map{"error": "could not auto-create logbooks"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{
			"action":   "auto_created",
			"event_id": eventID,
		})
	}

	return c.JSON(fiber.Map{
		"created": len(created),
		"logbooks": created,
	})
}

// handleLogbookPreview returns a dynamic preview of participants matching the saved filter.
func (s *Server) handleLogbookPreview(c *fiber.Ctx) error {
	logbookID, err := uuid.Parse(c.Params("lid"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"error": "invalid logbook id"})
	}

	lb, err := s.repos.Logbook.GetByID(c.Context(), logbookID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"error": "logbook not found"})
	}
	if lb.Status != domain.LogbookStatusPending {
		return c.Status(400).JSON(fiber.Map{"error": "preview only available for pending logbooks"})
	}
	if len(lb.SavedFilter) == 0 {
		return c.JSON(fiber.Map{"participants": []interface{}{}, "total": 0})
	}

	participants, err := s.repos.Logbook.PreviewParticipants(c.Context(), logbookID)
	if err != nil {
		log.Printf("[API] Error previewing logbook %s: %v", logbookID, err)
		return c.Status(500).JSON(fiber.Map{"error": "could not preview participants"})
	}

	return c.JSON(fiber.Map{
		"participants": participants,
		"total":        len(participants),
	})
}
