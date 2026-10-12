package api

import (
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
	"log"
)

func eventStageLayoutError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Evento o etapa no disponible."})
	case errors.Is(err, repository.ErrEventMembershipFrozen):
		return writeEventMembershipError(c, err)
	case errors.Is(err, repository.ErrEventStageLayoutConflict):
		return c.Status(409).JSON(fiber.Map{"success": false, "code": "EVENT_STAGE_LAYOUT_CONFLICT", "error": "Las etapas cambiaron en otra sesión. Tu borrador se conserva; recarga las etapas para revisarlo."})
	case errors.Is(err, repository.ErrEventStageLayoutInvalid):
		return c.Status(422).JSON(fiber.Map{"success": false, "code": "EVENT_STAGE_LAYOUT_INVALID", "error": err.Error()})
	default:
		log.Printf("[EVENT_STAGES] stage operation failed: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudieron guardar las etapas. Vuelve a intentarlo."})
	}
}
func eventStageLayoutJSON(snapshot *repository.EventStageLayoutSnapshot) fiber.Map {
	return fiber.Map{"success": true, "pipeline_id": snapshot.PipelineID, "revision": snapshot.Revision, "stages": snapshot.Stages, "stage_id_map": snapshot.StageIDMap}
}
func (s *Server) handleGetEventStageLayout(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Evento inválido."})
	}
	snapshot, err := s.repos.EventPipeline.GetEventStageLayout(c.Context(), accountID, eventID)
	if err != nil {
		return eventStageLayoutError(c, err)
	}
	return c.JSON(eventStageLayoutJSON(snapshot))
}
func (s *Server) saveEventConfigurationStages(c *fiber.Ctx, accountID, eventID uuid.UUID, input repository.EventStageLayoutInput) error {
	if actorID, ok := c.Locals("user_id").(uuid.UUID); ok {
		input.ActorID = &actorID
	}
	snapshot, err := s.repos.EventPipeline.SaveEventStageLayout(c.Context(), accountID, eventID, input)
	if err != nil {
		return eventStageLayoutError(c, err)
	}
	s.invalidateEventsCache(accountID)
	if s.hub != nil {
		payload := eventStageLayoutJSON(snapshot)
		payload["event_id"] = eventID.String()
		payload["action"] = "stages_layout_changed"
		s.hub.BroadcastToAccount(accountID, ws.EventEventParticipantUpdate, payload)
		if snapshot.LogbooksRemapped > 0 {
			s.hub.BroadcastToAccount(accountID, ws.EventLogbookUpdate, fiber.Map{"action": "stage_filters_remapped", "event_id": eventID, "stage_revision": snapshot.Revision, "affected": snapshot.LogbooksRemapped})
		}
	}
	return c.JSON(eventStageLayoutJSON(snapshot))
}

// Legacy single-stage routes go through exactly the same locked transaction.
func (s *Server) mutateLegacyEventStage(c *fiber.Ctx, operation string) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.SendStatus(400)
	}
	current, err := s.repos.EventPipeline.GetEventStageLayout(c.Context(), accountID, eventID)
	if err != nil {
		return eventStageLayoutError(c, err)
	}
	input := repository.EventStageLayoutInput{ExpectedRevision: &current.Revision, Stages: []repository.EventStageDraftInput{}}
	stageID := c.Params("stageId")
	var req struct {
		Name   *string                          `json:"name"`
		Color  *string                          `json:"color"`
		MoveTo repository.EventStageDestination `json:"moveTo"`
	}
	if len(c.Body()) > 0 {
		if err = c.BodyParser(&req); err != nil {
			return c.SendStatus(400)
		}
	}
	found := operation == "create"
	for _, stage := range current.Stages {
		draft := repository.EventStageDraftInput{ID: stage.ID.String(), Name: stage.Name, Color: stage.Color}
		if stage.ID.String() == stageID {
			found = true
			if operation == "delete" {
				input.Deletions = append(input.Deletions, repository.EventStageDeletionInput{ID: stageID, MoveTo: req.MoveTo})
				continue
			}
			if req.Name != nil {
				draft.Name = *req.Name
			}
			if req.Color != nil {
				draft.Color = *req.Color
			}
		}
		input.Stages = append(input.Stages, draft)
	}
	if !found {
		return eventStageLayoutError(c, pgx.ErrNoRows)
	}
	if operation == "create" {
		draft := repository.EventStageDraftInput{ClientID: "draft-" + uuid.NewString(), Color: "#6366F1"}
		if req.Name != nil {
			draft.Name = *req.Name
		}
		if req.Color != nil {
			draft.Color = *req.Color
		}
		input.Stages = append(input.Stages, draft)
	}
	return s.saveEventConfigurationStages(c, accountID, eventID, input)
}
