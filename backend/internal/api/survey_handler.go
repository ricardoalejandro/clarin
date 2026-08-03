package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

// ─── Protected Handlers ─────────────────────────────────────────────────────

func (s *Server) handleListSurveys(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	includeArchived, _ := strconv.ParseBool(c.Query("include_archived", "false"))

	// Redis cache — 30s TTL
	surveysCacheKey := ""
	if s.cache != nil {
		surveysCacheKey = fmt.Sprintf("surveys:%s:archived:%t", accountID.String(), includeArchived)
		if cached, err := s.cache.Get(c.Context(), surveysCacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	surveys, err := s.services.Survey.ListSurveysWithArchived(c.Context(), accountID, includeArchived)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if surveys == nil {
		surveys = []*domain.Survey{}
	}

	if surveysCacheKey != "" && s.cache != nil {
		if data, err := json.Marshal(surveys); err == nil {
			_ = s.cache.Set(c.Context(), surveysCacheKey, data, 30*time.Second)
		}
	}

	return c.JSON(surveys)
}

func (s *Server) handleCreateSurvey(c *fiber.Ctx) error {
	return c.Status(fiber.StatusConflict).JSON(fiber.Map{
		"code":  "survey_templates_required",
		"error": repository.ErrRawSurveyMutationDisabled.Error(),
	})
}

func (s *Server) handleGetSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}

	survey, err := s.services.Survey.GetSurvey(c.Context(), id, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}
	return c.JSON(survey)
}

func (s *Server) handleUpdateSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}

	var req struct {
		Name                string                `json:"name"`
		Description         string                `json:"description"`
		Slug                string                `json:"slug"`
		Status              string                `json:"status"`
		WelcomeTitle        string                `json:"welcome_title"`
		WelcomeDescription  string                `json:"welcome_description"`
		ThankYouTitle       string                `json:"thank_you_title"`
		ThankYouMessage     string                `json:"thank_you_message"`
		ThankYouRedirectURL string                `json:"thank_you_redirect_url"`
		Branding            domain.SurveyBranding `json:"branding"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	survey := &domain.Survey{
		ID:                  id,
		AccountID:           accountID,
		Name:                req.Name,
		Description:         req.Description,
		Slug:                req.Slug,
		Status:              req.Status,
		WelcomeTitle:        req.WelcomeTitle,
		WelcomeDescription:  req.WelcomeDescription,
		ThankYouTitle:       req.ThankYouTitle,
		ThankYouMessage:     req.ThankYouMessage,
		ThankYouRedirectURL: req.ThankYouRedirectURL,
		Branding:            req.Branding,
	}

	if err := s.services.Survey.UpdateSurvey(c.Context(), survey); err != nil {
		if errors.Is(err, service.ErrSurveyRedirectURLInvalid) {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
		}
		if errors.Is(err, repository.ErrSurveyArchived) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "survey_archived", "error": err.Error()})
		}
		if errors.Is(err, repository.ErrSurveyPublishedImmutable) || errors.Is(err, repository.ErrSurveyCannotReturnToDraft) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": err.Error()})
		}
		if errors.Is(err, repository.ErrSurveySlugUnavailable) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "survey_slug_unavailable", "error": err.Error()})
		}
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	s.invalidateSurveysCache(accountID)
	// Fetch updated survey to return with counts
	updated, err := s.services.Survey.GetSurvey(c.Context(), id, accountID)
	if err != nil {
		return c.JSON(survey)
	}
	return c.JSON(updated)
}

func (s *Server) handleDeleteSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}

	if err := s.services.Survey.DeleteSurvey(c.Context(), id, accountID); err != nil {
		return surveyApplicationMutationError(c, err)
	}
	s.invalidateSurveysCache(accountID)
	return c.SendStatus(fiber.StatusNoContent)
}

func (s *Server) handleArchiveSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_survey_id", "error": "ID de aplicación inválido"})
	}
	instance, err := s.services.Survey.ArchiveSurvey(c.Context(), id, accountID, actorID)
	if err != nil {
		return surveyApplicationMutationError(c, err)
	}
	s.invalidateSurveysCache(accountID)
	return c.JSON(instance)
}

func (s *Server) handleRestoreSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_survey_id", "error": "ID de aplicación inválido"})
	}
	instance, err := s.services.Survey.RestoreSurvey(c.Context(), id, accountID)
	if err != nil {
		return surveyApplicationMutationError(c, err)
	}
	s.invalidateSurveysCache(accountID)
	return c.JSON(instance)
}

func surveyApplicationMutationError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, repository.ErrSurveyInstanceNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"code": "survey_instance_not_found", "error": "Aplicación de encuesta no encontrada"})
	case errors.Is(err, repository.ErrSurveyDeleteLegacy),
		errors.Is(err, repository.ErrSurveyDeleteHasResponses),
		errors.Is(err, repository.ErrSurveyDeleteHasActivity),
		errors.Is(err, repository.ErrSurveyDeleteHasUploads):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "survey_application_has_history", "error": err.Error()})
	default:
		log.Printf("[SURVEY] Error mutating survey application lifecycle: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"code": "survey_instance_mutation_failed", "error": "No se pudo actualizar la aplicación"})
	}
}

func surveyArchivedGone(c *fiber.Ctx) error {
	return c.Status(fiber.StatusGone).JSON(fiber.Map{
		"code":  "survey_archived",
		"error": "Esta encuesta fue archivada",
	})
}

func surveyLinkRetiredGone(c *fiber.Ctx) error {
	return c.Status(fiber.StatusGone).JSON(fiber.Map{
		"code":  "survey_link_retired",
		"error": "Este enlace de encuesta fue retirado",
	})
}

func (s *Server) handleSetSurveyStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}

	var req struct {
		Status string `json:"status"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if err := s.services.Survey.SetStatus(c.Context(), id, accountID, req.Status); err != nil {
		if errors.Is(err, repository.ErrSurveyArchived) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "survey_archived", "error": err.Error()})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	s.invalidateSurveysCache(accountID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCheckSurveySlug(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	var req struct {
		Slug      string     `json:"slug"`
		ExcludeID *uuid.UUID `json:"exclude_id,omitempty"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	available, err := s.services.Survey.CheckSlug(c.Context(), accountID, req.Slug, req.ExcludeID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": available, "slug": req.Slug})
}

func (s *Server) handleDuplicateSurvey(c *fiber.Ctx) error {
	return c.Status(fiber.StatusConflict).JSON(fiber.Map{
		"code":  "survey_templates_required",
		"error": repository.ErrRawSurveyMutationDisabled.Error(),
	})
}

// ─── Questions ──────────────────────────────────────────────────────────────

func (s *Server) handleGetSurveyQuestions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	if srv, _ := s.services.Survey.GetSurvey(c.Context(), id, accountID); srv == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}

	questions, err := s.services.Survey.GetQuestions(c.Context(), id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if questions == nil {
		questions = []*domain.SurveyQuestion{}
	}
	return c.JSON(questions)
}

func (s *Server) handleSaveSurveyQuestions(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	if srv, _ := s.services.Survey.GetSurvey(c.Context(), id, accountID); srv == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}

	var questions []domain.SurveyQuestion
	if err := c.BodyParser(&questions); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	saved, err := s.services.Survey.SaveQuestions(c.Context(), accountID, id, questions)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(saved)
}

// ─── Responses ──────────────────────────────────────────────────────────────

func (s *Server) handleListSurveyResponses(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	if srv, _ := s.services.Survey.GetSurvey(c.Context(), id, accountID); srv == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}

	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))

	responses, total, err := s.services.Survey.ListResponses(c.Context(), accountID, id, limit, offset)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	if responses == nil {
		responses = []*domain.SurveyResponse{}
	}
	return c.JSON(fiber.Map{"responses": responses, "total": total})
}

func (s *Server) handleGetSurveyResponse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	surveyID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	rid, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid response ID"})
	}

	resp, err := s.services.Survey.GetResponseScoped(c.Context(), accountID, surveyID, rid)
	if err != nil || resp == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Response not found"})
	}
	return c.JSON(resp)
}

func (s *Server) handleListSurveyTextAnswers(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	surveyID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_survey_id", "error": "ID de aplicación inválido"})
	}
	questionID, err := uuid.Parse(c.Params("questionId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_question_id", "error": "ID de pregunta inválido"})
	}
	limit, parseErr := strconv.Atoi(c.Query("limit", "25"))
	if parseErr != nil || limit < 1 || limit > 100 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_pagination", "error": "Paginación inválida"})
	}
	page, err := s.services.Survey.ListTextAnswers(c.Context(), accountID, surveyID, questionID, limit, c.Query("cursor"))
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSurveyTextAnswerCursorInvalid):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_cursor", "error": "Cursor inválido"})
		case errors.Is(err, repository.ErrSurveyQuestionNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"code": "survey_question_not_found", "error": err.Error()})
		case errors.Is(err, repository.ErrSurveyQuestionNotText):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "survey_question_not_text", "error": err.Error()})
		default:
			log.Printf("[SURVEY] Error listing text answers: %v", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudieron cargar las respuestas de texto"})
		}
	}
	return c.JSON(page)
}

func (s *Server) handleDeleteSurveyResponse(c *fiber.Ctx) error {
	return c.Status(fiber.StatusConflict).JSON(fiber.Map{
		"error": "Las respuestas publicadas son registros históricos y no se pueden eliminar",
	})
}

// ─── Analytics ──────────────────────────────────────────────────────────────

func (s *Server) handleGetSurveyAnalytics(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	if srv, _ := s.services.Survey.GetSurvey(c.Context(), id, accountID); srv == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}

	analytics, err := s.services.Survey.GetAnalytics(c.Context(), accountID, id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(analytics)
}

func (s *Server) handleExportSurveyCSV(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}
	if srv, _ := s.services.Survey.GetSurvey(c.Context(), id, accountID); srv == nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found"})
	}

	data, err := s.services.Survey.GetExportData(c.Context(), accountID, id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	var output bytes.Buffer
	if err := writeSurveyCSV(&output, data); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo generar el archivo CSV"})
	}

	c.Set("Content-Type", "text/csv; charset=utf-8")
	c.Set("Content-Disposition", fmt.Sprintf("attachment; filename=survey_%s.csv", id.String()[:8]))
	return c.Send(output.Bytes())
}

type surveyExportTempFile struct {
	*os.File
	path string
}

func (file *surveyExportTempFile) Close() error {
	err := file.File.Close()
	removeErr := os.Remove(file.path)
	if err != nil {
		return err
	}
	return removeErr
}

func (s *Server) handleExportSurveyXLSX(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	surveyID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_survey_id", "error": "ID de aplicación inválido"})
	}
	var body struct {
		ChartTypes map[string]string `json:"chart_types"`
		BaselineID *string           `json:"baseline_id"`
		FollowupID *string           `json:"followup_id"`
	}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&body); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_export_request", "error": "Solicitud de exportación inválida"})
		}
	}
	request := service.SurveyXLSXExportRequest{ChartTypes: make(map[uuid.UUID]string, len(body.ChartTypes))}
	for rawID, chartType := range body.ChartTypes {
		questionID, parseErr := uuid.Parse(rawID)
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_chart_question", "error": "La configuración contiene una pregunta inválida"})
		}
		request.ChartTypes[questionID] = chartType
	}
	parseOptionalBodyID := func(raw *string) (*uuid.UUID, error) {
		if raw == nil || strings.TrimSpace(*raw) == "" {
			return nil, nil
		}
		value, parseErr := uuid.Parse(strings.TrimSpace(*raw))
		if parseErr != nil {
			return nil, parseErr
		}
		return &value, nil
	}
	request.BaselineID, err = parseOptionalBodyID(body.BaselineID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_baseline", "error": "Aplicación inicial inválida"})
	}
	request.FollowupID, err = parseOptionalBodyID(body.FollowupID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_followup", "error": "Aplicación final inválida"})
	}

	temporary, err := os.CreateTemp("", "clarin-survey-results-*.xlsx")
	if err != nil {
		log.Printf("[SURVEY] Error creating XLSX temporary file: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"code": "survey_export_failed", "error": "No se pudo preparar el informe"})
	}
	cleanup := func() {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
	}
	filename, err := s.services.Survey.WriteSurveyResultsXLSX(c.Context(), accountID, surveyID, request, temporary)
	if err != nil {
		cleanup()
		switch {
		case errors.Is(err, pgx.ErrNoRows), errors.Is(err, repository.ErrSurveyInstanceNotFound):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"code": "survey_instance_not_found", "error": "Aplicación de encuesta no encontrada"})
		case errors.Is(err, service.ErrSurveyApplicationRequired):
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"code": "survey_application_required", "error": err.Error()})
		case errors.Is(err, service.ErrSurveyXLSXRequestInvalid), errors.Is(err, repository.ErrSurveyMeasurementIncompatible):
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"code": "invalid_export_request", "error": err.Error()})
		default:
			log.Printf("[SURVEY] Error generating XLSX report: %v", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"code": "survey_export_failed", "error": "No se pudo generar el informe Excel"})
		}
	}
	stat, err := temporary.Stat()
	if err != nil {
		cleanup()
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"code": "survey_export_failed", "error": "No se pudo finalizar el informe Excel"})
	}
	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		cleanup()
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"code": "survey_export_failed", "error": "No se pudo abrir el informe Excel"})
	}
	c.Set(fiber.HeaderContentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="%s"`, filename))
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	return c.SendStream(&surveyExportTempFile{File: temporary, path: temporary.Name()}, int(stat.Size()))
}

func neutralizeSpreadsheetFormula(value string) string {
	candidate := strings.TrimLeft(value, " ")
	if candidate == "" {
		return value
	}
	switch candidate[0] {
	case '=', '+', '-', '@', '\t', '\r', '\n':
		return "'" + value
	default:
		return value
	}
}

func writeSurveyCSV(writer io.Writer, data *domain.SurveyExportData) error {
	csvWriter := csv.NewWriter(writer)
	if data == nil {
		csvWriter.Flush()
		return csvWriter.Error()
	}

	headers := make([]string, len(data.Headers))
	for index, value := range data.Headers {
		headers[index] = neutralizeSpreadsheetFormula(value)
	}
	if err := csvWriter.Write(headers); err != nil {
		return err
	}
	for _, row := range data.Rows {
		record := make([]string, len(data.Headers))
		for index := range record {
			if index < len(row) {
				record[index] = neutralizeSpreadsheetFormula(row[index])
			}
		}
		if err := csvWriter.Write(record); err != nil {
			return err
		}
	}
	csvWriter.Flush()
	return csvWriter.Error()
}

// ─── Public Handlers (No Auth) ──────────────────────────────────────────────

func (s *Server) handleGetPublicSurvey(c *fiber.Ctx) error {
	slug := c.Params("slug")
	if slug == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Slug is required"})
	}
	c.Set(fiber.HeaderCacheControl, "no-store, max-age=0")

	survey, questions, err := s.services.Survey.GetPublicSurvey(c.Context(), slug)
	if err != nil {
		if errors.Is(err, repository.ErrSurveyArchived) {
			return surveyArchivedGone(c)
		}
		if errors.Is(err, repository.ErrSurveyLinkRetired) {
			return surveyLinkRetiredGone(c)
		}
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	recipientToken := strings.TrimSpace(c.Query("recipient"))
	if survey.AudienceMode == "program_participants" && recipientToken == "" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey recipient not found"})
	}
	var recipientID *uuid.UUID
	if recipientToken != "" {
		recipient, recipientErr := s.services.SurveyTemplate.ResolveRecipient(c.Context(), survey.ID, recipientToken, false)
		if errors.Is(recipientErr, repository.ErrSurveyArchived) {
			return surveyArchivedGone(c)
		}
		if recipientErr != nil || recipient == nil || recipient.Status == "completed" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey recipient not found"})
		}
		recipientID = &recipient.ID
	}
	respondentToken, tokenErr := uuid.Parse(strings.TrimSpace(c.Get("X-Survey-Session-Token")))
	if tokenErr != nil {
		respondentToken, tokenErr = uuid.Parse(strings.TrimSpace(c.Query("respondent_token")))
	}
	if tokenErr != nil {
		respondentToken = uuid.New()
	}
	// Commit the opening before returning the form. TrackSession holds the same
	// survey-row lock used by response creation, so delete/archive cannot win a
	// concurrent race while this request still reports a successful opening.
	if err := s.services.Survey.TrackSession(c.Context(), domain.SurveySessionEvent{
		SurveyID: survey.ID, AccountID: survey.AccountID, RecipientID: recipientID,
		RespondentToken: respondentToken, Source: "direct", Phase: domain.SurveySessionOpened,
	}); err != nil {
		switch {
		case errors.Is(err, repository.ErrSurveyArchived):
			return surveyArchivedGone(c)
		case errors.Is(err, repository.ErrSurveyNotAcceptingResponses), errors.Is(err, pgx.ErrNoRows):
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
		default:
			log.Printf("[SURVEY] Error tracking public survey opening: %v", err)
			return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo abrir la encuesta"})
		}
	}

	publicQuestions := make([]fiber.Map, 0, len(questions))
	for _, question := range questions {
		publicQuestions = append(publicQuestions, fiber.Map{
			"id":          question.ID,
			"order_index": question.OrderIndex,
			"type":        question.Type,
			"title":       question.Title,
			"description": question.Description,
			"required":    question.Required,
			"config":      question.Config,
			"logic_rules": question.LogicRules,
		})
	}
	return c.JSON(fiber.Map{
		"respondent_token": respondentToken,
		"survey": fiber.Map{
			"id":                     survey.ID,
			"name":                   survey.Name,
			"description":            survey.Description,
			"slug":                   survey.Slug,
			"status":                 survey.Status,
			"welcome_title":          survey.WelcomeTitle,
			"welcome_description":    survey.WelcomeDescription,
			"thank_you_title":        survey.ThankYouTitle,
			"thank_you_message":      survey.ThankYouMessage,
			"thank_you_redirect_url": service.SafeSurveyRedirectURL(survey.ThankYouRedirectURL),
			"branding":               survey.Branding,
		},
		"questions": publicQuestions,
	})
}

func (s *Server) handleSubmitSurveyResponse(c *fiber.Ctx) error {
	slug := c.Params("slug")

	// Resolve survey by slug
	survey, err := s.repos.Survey.GetBySlug(c.Context(), slug)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	if survey.ArchivedAt != nil {
		return surveyArchivedGone(c)
	}
	if survey.Status != "active" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	requestNow := time.Now()
	if (survey.OpensAt != nil && requestNow.Before(*survey.OpensAt)) || (survey.ClosesAt != nil && requestNow.After(*survey.ClosesAt)) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	var req struct {
		RespondentToken string                `json:"respondent_token"`
		RecipientToken  string                `json:"recipient_token"`
		Source          string                `json:"source"`
		StartedAt       *time.Time            `json:"started_at"`
		Answers         []domain.SurveyAnswer `json:"answers"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	req.RespondentToken = strings.TrimSpace(req.RespondentToken)
	if _, tokenErr := uuid.Parse(req.RespondentToken); tokenErr != nil {
		req.RespondentToken = uuid.New().String()
	}
	if req.Source == "" {
		req.Source = "direct"
	}
	recipientToken := strings.TrimSpace(req.RecipientToken)
	if survey.AudienceMode == "program_participants" && recipientToken == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Este enlace de encuesta requiere un destinatario válido"})
	}
	recipient, err := s.services.SurveyTemplate.ResolveRecipient(c.Context(), survey.ID, recipientToken, false)
	if err != nil || (survey.AudienceMode == "program_participants" && recipient == nil) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El destinatario de la encuesta no es válido"})
	}
	if recipient != nil && recipient.Status == "completed" {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"error": "Esta encuesta ya fue respondida"})
	}

	now := requestNow
	startedAt := requestNow
	if req.StartedAt != nil {
		startedAt = *req.StartedAt
	}

	resp := &domain.SurveyResponse{
		SurveyID:        survey.ID,
		AccountID:       survey.AccountID,
		RespondentToken: req.RespondentToken,
		Source:          req.Source,
		IPAddress:       c.IP(),
		UserAgent:       string(c.Request().Header.UserAgent()),
		StartedAt:       startedAt,
		CompletedAt:     &now,
	}
	if recipient != nil {
		resp.RecipientID = &recipient.ID
		resp.ContactID = recipient.ContactID
		resp.ProgramID = recipient.ProgramID
		resp.ProgramParticipantID = recipient.ProgramParticipantID
	}

	if err := s.services.Survey.SubmitResponse(c.Context(), resp, req.Answers); err != nil {
		if errors.Is(err, repository.ErrSurveyArchived) {
			return surveyArchivedGone(c)
		}
		if errors.Is(err, repository.ErrSurveyNotAcceptingResponses) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
		}
		log.Printf("[SURVEY] Error submitting response for %s: %v", slug, err)
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success":     true,
		"response_id": resp.ID,
	})
}

func (s *Server) handleTrackSurveySession(c *fiber.Ctx) error {
	slug := c.Params("slug")
	survey, err := s.repos.Survey.GetBySlug(c.Context(), slug)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Encuesta no encontrada o inactiva"})
	}
	if survey.ArchivedAt != nil {
		return surveyArchivedGone(c)
	}
	if survey.Status != "active" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Encuesta no encontrada o inactiva"})
	}
	now := time.Now()
	if (survey.OpensAt != nil && now.Before(*survey.OpensAt)) || (survey.ClosesAt != nil && now.After(*survey.ClosesAt)) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Encuesta no encontrada o inactiva"})
	}
	var req struct {
		RespondentToken string                    `json:"respondent_token"`
		RecipientToken  string                    `json:"recipient_token"`
		Source          string                    `json:"source"`
		Phase           domain.SurveySessionPhase `json:"phase"`
		QuestionID      *uuid.UUID                `json:"question_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Solicitud inválida"})
	}
	respondentToken, err := uuid.Parse(strings.TrimSpace(req.RespondentToken))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "La sesión de respuesta no es válida"})
	}
	var recipientID *uuid.UUID
	recipientToken := strings.TrimSpace(req.RecipientToken)
	if recipientToken != "" {
		recipient, resolveErr := s.services.SurveyTemplate.ResolveRecipient(c.Context(), survey.ID, recipientToken, false)
		if resolveErr != nil || recipient == nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "El destinatario de la encuesta no es válido"})
		}
		recipientID = &recipient.ID
	} else if survey.AudienceMode == "program_participants" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Este enlace requiere un destinatario válido"})
	}
	event := domain.SurveySessionEvent{
		SurveyID: survey.ID, AccountID: survey.AccountID, RecipientID: recipientID,
		RespondentToken: respondentToken, Source: req.Source, Phase: req.Phase,
		QuestionID: req.QuestionID,
	}
	if err := s.services.Survey.TrackSession(c.Context(), event); err != nil {
		if errors.Is(err, repository.ErrSurveyArchived) {
			return surveyArchivedGone(c)
		}
		if errors.Is(err, repository.ErrSurveyNotAcceptingResponses) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Encuesta no encontrada o inactiva"})
		}
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUploadSurveyFile(c *fiber.Ctx) error {
	if s.storage == nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": "Almacenamiento no configurado"})
	}
	slug := c.Params("slug")

	// Verify survey exists and is active
	survey, err := s.repos.Survey.GetBySlug(c.Context(), slug)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	if survey.ArchivedAt != nil {
		return surveyArchivedGone(c)
	}
	if survey.Status != "active" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	now := time.Now()
	if (survey.OpensAt != nil && now.Before(*survey.OpensAt)) || (survey.ClosesAt != nil && now.After(*survey.ClosesAt)) {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}
	respondentToken := strings.TrimSpace(c.FormValue("respondent_token"))
	if _, err := uuid.Parse(respondentToken); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "La sesión de respuesta no es válida"})
	}
	questionID, err := uuid.Parse(strings.TrimSpace(c.FormValue("question_id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "La pregunta no es válida"})
	}
	questions, err := s.repos.Survey.GetQuestions(c.Context(), survey.ID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo validar la pregunta"})
	}
	var question *domain.SurveyQuestion
	for _, candidate := range questions {
		if candidate.ID == questionID {
			question = candidate
			break
		}
	}
	if question == nil || question.Type != "file_upload" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "La pregunta no admite archivos"})
	}
	if err := s.checkAbuseLimits(c, "survey_upload_rate_limited", survey.ID.String(), []abuseLimit{
		{Key: "abuse:survey-upload:ip:minute:" + hashForLog(clientIP(c)), Max: 10, Window: time.Minute},
		{Key: "abuse:survey-upload:ip:hour:" + hashForLog(clientIP(c)), Max: 40, Window: time.Hour},
		{Key: "abuse:survey-upload:respondent:hour:" + hashForLog(survey.ID.String()+":"+respondentToken), Max: 12, Window: time.Hour},
	}); err != nil {
		return err
	}

	var recipientID *uuid.UUID
	if survey.AudienceMode == "program_participants" {
		recipient, recipientErr := s.services.SurveyTemplate.ResolveRecipient(c.Context(), survey.ID, c.Query("recipient"), false)
		if recipientErr != nil || recipient == nil || recipient.Status == "completed" {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey recipient not found"})
		}
		recipientID = &recipient.ID
	}

	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No file uploaded"})
	}

	maxSizeMB := question.Config.MaxSizeMB
	if maxSizeMB <= 0 {
		maxSizeMB = 10
	}
	if maxSizeMB > 50 {
		maxSizeMB = 50
	}
	maxBytes := int64(maxSizeMB) * 1024 * 1024
	if file.Size <= 0 || file.Size > maxBytes {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": fmt.Sprintf("El archivo supera el máximo de %d MB", maxSizeMB)})
	}

	f, err := file.Open()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to read file"})
	}
	defer f.Close()

	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil || int64(len(data)) == 0 || int64(len(data)) > maxBytes {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No se pudo validar el archivo"})
	}

	safeName := sanitizeSurveyUploadFilename(file.Filename)
	if safeName == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid filename"})
	}
	contentType, err := validateSurveyUploadContent(question, safeName, file.Header.Get("Content-Type"), data)
	if err != nil {
		return c.Status(fiber.StatusUnsupportedMediaType).JSON(fiber.Map{"error": err.Error()})
	}
	if err := s.ensureStorageQuota(c.Context(), survey.AccountID, int64(len(data))); err != nil {
		return c.Status(fiber.StatusInsufficientStorage).JSON(fiber.Map{"error": "La cuenta alcanzó su límite de almacenamiento", "code": "storage_quota"})
	}

	ext := safeSurveyUploadExtension(safeName)
	objectKey := fmt.Sprintf("%s/survey-uploads/%s/%s/%s%s", survey.AccountID, survey.ID, questionID, uuid.New(), ext)
	hash := fmt.Sprintf("%x", sha256.Sum256(data))
	upload, err := s.repos.Survey.PrepareSurveyFileUpload(c.Context(), repository.PrepareSurveyFileUploadInput{
		AccountID:        survey.AccountID,
		SurveyID:         survey.ID,
		QuestionID:       questionID,
		RecipientID:      recipientID,
		RespondentToken:  respondentToken,
		ObjectKey:        objectKey,
		OriginalFilename: safeName,
		ContentType:      contentType,
		SizeBytes:        int64(len(data)),
		ContentHash:      hash,
		ExpiresAt:        time.Now().Add(24 * time.Hour),
	})
	if err != nil {
		if errors.Is(err, repository.ErrSurveyArchived) {
			return surveyArchivedGone(c)
		}
		if errors.Is(err, repository.ErrSurveyNotAcceptingResponses) {
			return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
		}
		log.Printf("[SURVEY] Error preparing file inventory: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "No se pudo preparar la carga"})
	}

	_, err = s.storage.UploadObject(c.Context(), objectKey, data, contentType)
	if err != nil {
		_ = s.repos.Survey.MarkSurveyFileUploadFailed(c.Context(), survey.AccountID, upload.ID)
		log.Printf("[SURVEY] Error uploading file: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to upload file"})
	}

	return c.JSON(fiber.Map{
		"upload_id": upload.ID,
		"url":       "/api/public/survey-files/" + upload.AccessToken.String(),
		"filename":  safeName,
	})
}
