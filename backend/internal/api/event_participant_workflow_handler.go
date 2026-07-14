package api

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func (s *Server) eventHasMembershipRules(ctx context.Context, event *domain.Event) (bool, error) {
	if event == nil {
		return false, nil
	}
	if strings.EqualFold(event.TagFormulaType, "advanced") {
		return strings.TrimSpace(event.TagFormula) != "", nil
	}
	includes, excludes, err := s.repos.Event.GetEventTagEntries(ctx, event.ID)
	if err != nil {
		return false, err
	}
	return len(includes) > 0 || len(excludes) > 0, nil
}

func eventMembershipFrozen(status string) bool {
	return status == domain.EventStatusCompleted || status == domain.EventStatusCancelled
}

func validEventLifecycleStatus(status string) bool {
	return domain.IsValidEventStatus(status)
}

func allowedEventStatusTransition(from, to string) bool {
	return domain.CanTransitionEventStatus(from, to)
}

// requireWritableEvent re-checks lifecycle and account ownership immediately
// before participant mutations. It intentionally returns the rendered Fiber
// response so handlers cannot accidentally continue after a failed guard.
func (s *Server) requireWritableEvent(c *fiber.Ctx, accountID, eventID uuid.UUID) (bool, error) {
	var status string
	err := s.repos.DB().QueryRow(c.Context(), `SELECT status FROM events WHERE id=$1 AND account_id=$2`, eventID, accountID).Scan(&status)
	if err == pgx.ErrNoRows {
		return false, c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	if err != nil {
		return false, c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if eventMembershipFrozen(status) {
		return false, writeEventMembershipError(c, repository.ErrEventMembershipFrozen)
	}
	return true, nil
}

func writeEventParticipantMutationError(c *fiber.Ctx, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, repository.ErrEventMembershipFrozen):
		return writeEventMembershipError(c, err)
	case errors.Is(err, repository.ErrEventParticipantInactive):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{
			"success": false,
			"code":    "EVENT_PARTICIPANT_INACTIVE",
			"error":   "Uno o más participantes ya no están activos en el evento",
		})
	case errors.Is(err, repository.ErrEventStageMismatch):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"success": false,
			"code":    "EVENT_STAGE_INVALID",
			"error":   "La etapa no pertenece al pipeline actual del evento",
		})
	case errors.Is(err, pgx.ErrNoRows):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Event not found"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
}

func parseStrictUniqueUUIDs(values []string) ([]uuid.UUID, error) {
	ids := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		id, err := uuid.Parse(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("invalid UUID %q: %w", value, err)
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

func parseOptionalBoolQuery(c *fiber.Ctx, name string) (*bool, error) {
	raw := strings.TrimSpace(c.Query(name))
	if raw == "" {
		return nil, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

func parseCSVUUIDQuery(raw string) ([]uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	parts := strings.Split(raw, ",")
	result := make([]uuid.UUID, 0, len(parts))
	seen := make(map[uuid.UUID]struct{}, len(parts))
	for _, part := range parts {
		id, err := uuid.Parse(strings.TrimSpace(part))
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}

func uniqueUUIDs(ids []uuid.UUID) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(ids))
	seen := make(map[uuid.UUID]struct{}, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func (s *Server) participantsBelongToEvent(ctx context.Context, accountID, eventID uuid.UUID, participantIDs []uuid.UUID, activeOnly bool) (bool, error) {
	participantIDs = uniqueUUIDs(participantIDs)
	if len(participantIDs) == 0 {
		return false, nil
	}
	activeClause := ""
	if activeOnly {
		activeClause = " AND ep.membership_state='active'"
	}
	var count int
	err := s.repos.DB().QueryRow(ctx, `
		SELECT COUNT(DISTINCT ep.id)
		FROM event_participants ep
		JOIN events e ON e.id=ep.event_id AND e.account_id=$1
		WHERE ep.event_id=$2 AND ep.id=ANY($3::uuid[])
	`+activeClause, accountID, eventID, participantIDs).Scan(&count)
	return count == len(participantIDs), err
}

func (s *Server) handleGetEventParticipantCandidates(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	tagIDs, err := parseCSVUUIDQuery(c.Query("tag_ids"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid tag_ids"})
	}
	hasPhone, err := parseOptionalBoolQuery(c, "has_phone")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid has_phone"})
	}
	filter := repository.EventParticipantCandidateFilter{
		Search:   strings.TrimSpace(c.Query("search")),
		TagIDs:   tagIDs,
		HasPhone: hasPhone,
		Limit:    c.QueryInt("limit", 50),
		Offset:   c.QueryInt("offset", 0),
	}
	page, err := s.services.Event.GetParticipantCandidates(c.Context(), accountID, eventID, filter)
	if err == pgx.ErrNoRows {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Event not found"})
	}
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	return c.JSON(fiber.Map{
		"success":      true,
		"candidates":   page.Candidates,
		"total":        page.Total,
		"limit":        page.Limit,
		"offset":       page.Offset,
		"has_more":     page.HasMore,
		"has_rules":    page.HasRules,
		"event_status": page.EventStatus,
		"counts":       page.Counts,
	})
}

func (s *Server) handleGetEventParticipant(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	eventID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid event ID"})
	}
	participantID, err := uuid.Parse(c.Params("pid"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid participant ID"})
	}
	participant, err := s.services.Event.GetParticipantForEvent(c.Context(), accountID, eventID, participantID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	if participant == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Participant not found"})
	}
	if participant.ContactID != nil {
		tags, tagErr := s.repos.Tag.GetByEntityForAccount(c.Context(), accountID, "contact", *participant.ContactID)
		if tagErr != nil {
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": tagErr.Error()})
		}
		participant.Tags = tags
	}
	if participant.Tags == nil {
		participant.Tags = make([]*domain.Tag, 0)
	}
	return c.JSON(fiber.Map{"success": true, "participant": participant})
}
