package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	surveyApplicationDefaultLimit = 50
	surveyApplicationMaxLimit     = 200
)

var errInvalidSurveyApplicationPage = errors.New("invalid survey application page")

type surveyApplicationCursorPayload struct {
	CreatedAt time.Time `json:"created_at"`
	ID        uuid.UUID `json:"id"`
}

func encodeSurveyApplicationCursor(cursor *repository.SurveyApplicationCursor) string {
	if cursor == nil {
		return ""
	}
	payload, _ := json.Marshal(surveyApplicationCursorPayload{CreatedAt: cursor.CreatedAt, ID: cursor.ID})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeSurveyApplicationCursor(raw string) (*repository.SurveyApplicationCursor, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, errInvalidSurveyApplicationPage
	}
	var decoded surveyApplicationCursorPayload
	if err := json.Unmarshal(payload, &decoded); err != nil || decoded.ID == uuid.Nil || decoded.CreatedAt.IsZero() {
		return nil, errInvalidSurveyApplicationPage
	}
	return &repository.SurveyApplicationCursor{CreatedAt: decoded.CreatedAt, ID: decoded.ID}, nil
}

func parseSurveyApplicationLimit(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return surveyApplicationDefaultLimit, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 || limit > surveyApplicationMaxLimit {
		return 0, errInvalidSurveyApplicationPage
	}
	return limit, nil
}

func parseSurveyApplicationFilters(c *fiber.Ctx) (repository.SurveyApplicationFilters, error) {
	filters := repository.SurveyApplicationFilters{
		ArchiveState: strings.TrimSpace(c.Query("archive_state", "current")),
		Status:       strings.TrimSpace(c.Query("status", "all")),
		OriginType:   strings.TrimSpace(c.Query("origin_type", "all")),
		Query:        strings.TrimSpace(c.Query("query")),
	}
	if filters.ArchiveState != "current" && filters.ArchiveState != "archived" {
		return filters, errInvalidSurveyApplicationPage
	}
	if filters.Status != "all" && filters.Status != "draft" && filters.Status != "active" && filters.Status != "closed" {
		return filters, errInvalidSurveyApplicationPage
	}
	if filters.OriginType != "all" && filters.OriginType != "standalone" && filters.OriginType != "program" {
		return filters, errInvalidSurveyApplicationPage
	}
	if len([]rune(filters.Query)) > 160 {
		return filters, errInvalidSurveyApplicationPage
	}
	return filters, nil
}

func (s *Server) handleListSurveyTemplateApplications(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	templateID, err := uuid.Parse(c.Params("templateId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "ID inválido"})
	}
	filters, err := parseSurveyApplicationFilters(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Filtros de aplicaciones inválidos"})
	}
	limit, err := parseSurveyApplicationLimit(c.Query("limit"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Límite inválido"})
	}
	cursor, err := decodeSurveyApplicationCursor(c.Query("cursor"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Cursor inválido"})
	}
	items, next, counts, err := s.services.SurveyTemplate.ListTemplateApplicationsPage(
		c.Context(), accountID, templateID, filters, limit, cursor,
	)
	if err != nil {
		return surveyTemplateError(c, err)
	}
	if items == nil {
		items = []*domain.SurveyInstanceSummary{}
	}
	return c.JSON(fiber.Map{
		"items":       items,
		"limit":       limit,
		"has_more":    next != nil,
		"next_cursor": encodeSurveyApplicationCursor(next),
		"counts":      counts,
	})
}
