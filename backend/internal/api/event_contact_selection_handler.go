package api

import (
	"context"
	"errors"
	"log"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

func eventSelectionScope(c *fiber.Ctx) (uuid.UUID, uuid.UUID, uuid.UUID, error) {
	accountID, accountOK := c.Locals("account_id").(uuid.UUID)
	actorID, actorOK := c.Locals("user_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if !accountOK || !actorOK || accountID == uuid.Nil || actorID == uuid.Nil {
		return accountID, actorID, eventID, fiber.NewError(401, "Sesión no disponible")
	}
	if err != nil {
		return accountID, actorID, eventID, fiber.NewError(400, "Evento inválido")
	}
	return accountID, actorID, eventID, nil
}
func eventSelectionError(c *fiber.Ctx, err error) error {
	var pgErr *pgconn.PgError
	status, code, message := 500, "EVENT_SELECTION_UNAVAILABLE", "No pudimos completar la operación. Puedes reintentar con la misma selección."
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		status, code, message = 404, "EVENT_SELECTION_NOT_FOUND", "La selección o el evento ya no está disponible."
	case errors.Is(err, repository.ErrEventSelectionInvalid):
		status, code, message = 400, "EVENT_SELECTION_INVALID", "Revisa la selección y los filtros."
	case errors.Is(err, repository.ErrEventSelectionExpired):
		status, code, message = 409, "EVENT_SELECTION_EXPIRED", "La revisión caducó. Revisa de nuevo los contactos antes de confirmar."
	case errors.Is(err, repository.ErrEventSelectionStale):
		status, code, message = 409, "EVENT_SELECTION_STALE", "Los contactos o las reglas cambiaron. Revisa nuevamente; no se añadió ningún contacto."
	case errors.Is(err, repository.ErrEventSelectionConsumed):
		status, code, message = 409, "EVENT_SELECTION_CONSUMED", "Esta selección ya fue confirmada. Recupera el resultado de la operación original."
	case errors.Is(err, repository.ErrEventMembershipFrozen):
		status, code, message = 409, "EVENT_MEMBERSHIP_FROZEN", "Este evento está cerrado y no permite añadir participantes."
	case errors.Is(err, context.DeadlineExceeded):
		status, code, message = 503, "EVENT_SELECTION_TIMEOUT", "La operación tardó demasiado. Comprueba su resultado antes de reintentar."
	case errors.As(err, &pgErr) && pgErr.Code == "55P03":
		status, code, message = 409, "EVENT_SELECTION_BUSY", "Hay una operación en curso. Espera un momento y comprueba el resultado."
	case errors.As(err, &pgErr) && pgErr.Code == "23505":
		status, code, message = 409, "EVENT_SELECTION_CONSUMED", "Este identificador de operación ya se utilizó."
	}
	if status == 500 {
		log.Printf("[EventContactSelection] operation failed: %T", err)
	}
	return c.Status(status).JSON(fiber.Map{"success": false, "code": code, "error": message})
}
func (s *Server) handleListEventContactCandidates(c *fiber.Ctx) error {
	accountID, actorID, eventID, err := eventSelectionScope(c)
	if err != nil {
		return err
	}
	tags, err := parseCSVUUIDQuery(c.Query("tag_ids"))
	if err != nil || len(tags) > 100 {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	phone, err := parseOptionalBoolQuery(c, "has_phone")
	if err != nil {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	membership := c.Query("membership", "available")
	switch membership {
	case "available", "active", "inactive", "ineligible", "all":
	default:
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	if len(c.Query("search")) > 500 || len(c.Query("cursor")) > 4096 {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	page, err := s.repos.Event.ListParticipantCandidates(c.Context(), accountID, eventID, repository.EventParticipantCandidateFilter{Search: strings.TrimSpace(c.Query("search")), TagIDs: tags, HasPhone: phone, Membership: membership, Cursor: c.Query("cursor"), Limit: 50, ActorID: actorID})
	if err != nil {
		return eventSelectionError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "page": page})
}
func (s *Server) handlePrepareEventParticipantSelection(c *fiber.Ctx) error {
	accountID, actorID, eventID, err := eventSelectionScope(c)
	if err != nil {
		return err
	}
	var req repository.PrepareEventSelection
	if err = c.BodyParser(&req); err != nil {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	preview, err := repository.NewEventParticipantSelectionRepository(s.repos.DB()).Prepare(c.Context(), accountID, actorID, eventID, req)
	if err != nil {
		return eventSelectionError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "selection": preview})
}
func (s *Server) handleGetEventParticipantSelection(c *fiber.Ctx) error {
	accountID, actorID, eventID, err := eventSelectionScope(c)
	if err != nil {
		return err
	}
	selectionID, err := uuid.Parse(c.Params("selectionId"))
	if err != nil {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	item, err := repository.NewEventParticipantSelectionRepository(s.repos.DB()).Get(c.Context(), accountID, actorID, eventID, selectionID)
	if err != nil {
		return eventSelectionError(c, err)
	}
	if c.Query("review") != "true" || item.Result != nil {
		return c.JSON(fiber.Map{"success": true, "selection": item})
	}
	page, err := s.repos.Event.ListParticipantCandidates(c.Context(), accountID, eventID, repository.EventParticipantCandidateFilter{SelectionID: &selectionID, ActorID: actorID, Limit: 50, Cursor: c.Query("cursor")})
	if err != nil {
		return eventSelectionError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "selection": item, "page": page})
}
func (s *Server) handleConfirmEventParticipantSelection(c *fiber.Ctx) error {
	accountID, actorID, eventID, err := eventSelectionScope(c)
	if err != nil {
		return err
	}
	selectionID, err := uuid.Parse(c.Params("selectionId"))
	if err != nil {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	var req struct {
		OperationID uuid.UUID `json:"operation_id"`
	}
	if err = c.BodyParser(&req); err != nil {
		return eventSelectionError(c, repository.ErrEventSelectionInvalid)
	}
	result, replayed, err := repository.NewEventParticipantSelectionRepository(s.repos.DB()).Confirm(c.Context(), accountID, actorID, eventID, selectionID, req.OperationID)
	if err != nil {
		return eventSelectionError(c, err)
	}
	if !replayed && result.Created+result.Reactivated > 0 {
		s.invalidateEventsCache(accountID)
		if s.hub != nil {
			s.hub.BroadcastToAccount(accountID, ws.EventEventParticipantUpdate, map[string]interface{}{
				"event_id": eventID.String(), "action": "membership_bulk_added", "operation_id": result.OperationID.String(), "summary": result,
			})
		}
	}
	return c.JSON(fiber.Map{"success": true, "result": result, "replayed": replayed})
}
