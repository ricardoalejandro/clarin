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
	case errors.Is(err, repository.ErrLogbookCompleted):
		return c.Status(409).JSON(fiber.Map{"code": "LOGBOOK_COMPLETED", "error": "Esta bitácora está completada. Reábrela explícitamente para corregirla."})
	case errors.Is(err, repository.ErrLogbookVersion):
		return c.Status(409).JSON(fiber.Map{"code": "LOGBOOK_VERSION_CONFLICT", "error": "La bitácora cambió en otra sesión. Revisa la versión actual antes de guardar; tu borrador sigue disponible."})
	case errors.Is(err, repository.ErrLogbookTransition):
		return c.Status(422).JSON(fiber.Map{"code": "LOGBOOK_INVALID_TRANSITION", "error": "Captura primero la bitácora y utiliza Completar o Reabrir para cambiar su estado."})
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

func logbookIDs(c *fiber.Ctx) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	account := c.Locals("account_id").(uuid.UUID)
	event, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return account, event, uuid.Nil, repository.ErrLogbookInvalid
	}
	id := uuid.Nil
	if c.Params("lid") != "" {
		id, err = uuid.Parse(c.Params("lid"))
	}
	if err != nil {
		return account, event, id, repository.ErrLogbookInvalid
	}
	return account, event, id, nil
}
func logbookPageOptions(c *fiber.Ctx) repository.LogbookPageOptions {
	return repository.LogbookPageOptions{Limit: c.QueryInt("limit", 50), Cursor: c.Query("cursor"), Search: c.Query("q"), Status: c.Query("status"), StageKey: c.Query("stage_key"), NotesOnly: c.QueryBool("notes_only")}
}
func logbookWriteOptions(c *fiber.Ctx, version int64) (repository.LogbookWriteOptions, error) {
	if version < 1 {
		return repository.LogbookWriteOptions{}, repository.ErrLogbookVersion
	}
	actor := c.Locals("user_id").(uuid.UUID)
	return repository.LogbookWriteOptions{ExpectedVersion: version, ActorID: &actor}, nil
}
func (s *Server) broadcastLogbook(c *fiber.Ctx, action string, lb *domain.EventLogbook) {
	if s.hub != nil {
		s.hub.BroadcastToAccount(lb.AccountID, ws.EventLogbookUpdate, fiber.Map{"action": action, "event_id": lb.EventID, "logbook_id": lb.ID, "version": lb.Version, "logbook": lb})
	}
}
func (s *Server) handleGetEventLogbooks(c *fiber.Ctx) error {
	account, event, _, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if ev, _ := s.repos.Event.GetByID(c.Context(), event); ev == nil || ev.AccountID != account {
		return c.SendStatus(404)
	}
	page, err := s.repos.Logbook.ListPage(c.Context(), account, event, logbookPageOptions(c))
	if err != nil {
		return writeLogbookError(c, err)
	}
	return c.JSON(page)
}
func (s *Server) handleCreateEventLogbook(c *fiber.Ctx) error {
	account, event, _, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var body struct {
		Date         string          `json:"date"`
		Title        string          `json:"title"`
		GeneralNotes string          `json:"general_notes"`
		CaptureNow   bool            `json:"capture_now"`
		SavedFilter  json.RawMessage `json:"saved_filter"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	date, err := time.Parse("2006-01-02", body.Date)
	if err != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	if body.Title == "" {
		body.Title = date.Format("02/01/2006")
	}
	actor := c.Locals("user_id").(uuid.UUID)
	lb := &domain.EventLogbook{EventID: event, AccountID: account, Date: date, Title: body.Title, GeneralNotes: body.GeneralNotes, Status: domain.LogbookStatusPending, CreatedBy: &actor, SavedFilter: body.SavedFilter}
	if err = s.repos.Logbook.CreateWithCapture(c.Context(), lb, body.CaptureNow); err != nil {
		log.Printf("[API] create logbook: %v", err)
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, "created", lb)
	return c.Status(201).JSON(lb)
}
func (s *Server) handleGetEventLogbook(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	lb, err := s.repos.Logbook.Summary(c.Context(), account, event, id)
	if err != nil {
		return writeLogbookError(c, err)
	}
	return c.JSON(lb)
}
func (s *Server) handleUpdateEventLogbook(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var body struct {
		Title           *string         `json:"title"`
		Date            *string         `json:"date"`
		GeneralNotes    *string         `json:"general_notes"`
		SavedFilter     json.RawMessage `json:"saved_filter"`
		Status          *string         `json:"status"`
		ExpectedVersion int64           `json:"expected_version"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	options, err := logbookWriteOptions(c, body.ExpectedVersion)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(c.Body(), &fields) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	for _, key := range []string{"title", "date", "general_notes", "status"} {
		if value, present := fields[key]; present && string(value) == "null" {
			return writeLogbookError(c, repository.ErrLogbookInvalid)
		}
	}
	patch := repository.LogbookPatch{Title: body.Title, GeneralNotes: body.GeneralNotes, Status: body.Status, ExpectedVersion: options.ExpectedVersion, ActorID: options.ActorID}
	if body.Date != nil {
		date, err := time.Parse("2006-01-02", *body.Date)
		if err != nil {
			return writeLogbookError(c, repository.ErrLogbookInvalid)
		}
		patch.Date = &date
	}
	if body.SavedFilter != nil {
		patch.SavedFilterPresent = true
		if string(body.SavedFilter) != "null" {
			patch.SavedFilter = body.SavedFilter
		}
	}
	lb, err := s.repos.Logbook.Update(c.Context(), account, event, id, patch)
	if err != nil {
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, "updated", lb)
	return c.JSON(lb)
}
func (s *Server) handleDeleteEventLogbook(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var body struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	option, err := logbookWriteOptions(c, body.ExpectedVersion)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if err = s.repos.Logbook.Delete(c.Context(), account, event, id, option); err != nil {
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, "deleted", &domain.EventLogbook{ID: id, AccountID: account, EventID: event, Version: option.ExpectedVersion + 1})
	return c.SendStatus(204)
}
func (s *Server) handleCaptureLogbookSnapshot(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var body struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	option, err := logbookWriteOptions(c, body.ExpectedVersion)
	if err != nil {
		return writeLogbookError(c, err)
	}
	lb, err := s.repos.Logbook.CaptureSnapshot(c.Context(), account, event, id, nil, option)
	if err != nil {
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, "captured", lb)
	return c.JSON(lb)
}
func (s *Server) handleUpdateLogbookEntry(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	entry, err := uuid.Parse(c.Params("eid"))
	if err != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	var body struct {
		Notes           string `json:"notes"`
		ExpectedVersion int64  `json:"expected_version"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	option, err := logbookWriteOptions(c, body.ExpectedVersion)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if err = s.repos.Logbook.UpdateEntryNotes(c.Context(), account, event, id, entry, body.Notes, option); err != nil {
		return writeLogbookError(c, err)
	}
	lb, err := s.repos.Logbook.Summary(c.Context(), account, event, id)
	if err != nil {
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, "entry_updated", lb)
	return c.JSON(lb)
}
func (s *Server) handleAutoCreateLogbooks(c *fiber.Ctx) error {
	account, event, _, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	ev, err := s.repos.Event.GetByID(c.Context(), event)
	if err != nil || ev == nil || ev.AccountID != account {
		return c.SendStatus(404)
	}
	if ev.EventDate == nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	end := ev.EventDate
	if ev.EventEnd != nil {
		end = ev.EventEnd
	}
	actor := c.Locals("user_id").(uuid.UUID)
	if c.QueryBool("preview") {
		preview, err := s.repos.Logbook.AutoCreatePreview(c.Context(), account, event, *ev.EventDate, *end)
		if err != nil {
			return writeLogbookError(c, err)
		}
		return c.JSON(preview)
	}
	created, err := s.repos.Logbook.AutoCreateFromDateRange(c.Context(), event, account, *ev.EventDate, *end, &actor)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if s.hub != nil {
		s.hub.BroadcastToAccount(account, ws.EventLogbookUpdate, fiber.Map{"action": "auto_created", "event_id": event})
	}
	return c.JSON(fiber.Map{"created": len(created)})
}
func (s *Server) handleLogbookPreview(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	page, err := s.repos.Logbook.PreviewPage(c.Context(), account, event, id, logbookPageOptions(c))
	if err != nil {
		return writeLogbookError(c, err)
	}
	return c.JSON(page)
}
func (s *Server) handleLogbookEntries(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if _, err = s.repos.Logbook.Summary(c.Context(), account, event, id); err != nil {
		return writeLogbookError(c, err)
	}
	page, err := s.repos.Logbook.EntriesPage(c.Context(), account, event, id, logbookPageOptions(c))
	if err != nil {
		return writeLogbookError(c, err)
	}
	return c.JSON(page)
}
func (s *Server) transitionLogbook(c *fiber.Ctx, action string) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	var body struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if c.BodyParser(&body) != nil {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	option, err := logbookWriteOptions(c, body.ExpectedVersion)
	if err != nil {
		return writeLogbookError(c, err)
	}
	lb, err := s.repos.Logbook.Transition(c.Context(), account, event, id, action, option)
	if err != nil {
		return writeLogbookError(c, err)
	}
	s.broadcastLogbook(c, action, lb)
	return c.JSON(lb)
}
func (s *Server) handleCompleteLogbook(c *fiber.Ctx) error { return s.transitionLogbook(c, "complete") }
func (s *Server) handleReopenLogbook(c *fiber.Ctx) error   { return s.transitionLogbook(c, "reopen") }
func (s *Server) handleLogbookHistory(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if _, err = s.repos.Logbook.Summary(c.Context(), account, event, id); err != nil {
		return writeLogbookError(c, err)
	}
	items, err := s.repos.Logbook.History(c.Context(), account, event, id, c.QueryInt("before_version", 0))
	if err != nil {
		return writeLogbookError(c, err)
	}
	return c.JSON(items)
}
