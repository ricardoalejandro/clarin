package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// ─── Protected Handlers ─────────────────────────────────────────────────────

func (s *Server) handleListSurveys(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	// Redis cache — 30s TTL
	surveysCacheKey := ""
	if s.cache != nil {
		surveysCacheKey = fmt.Sprintf("surveys:%s:all", accountID.String())
		if cached, err := s.cache.Get(c.Context(), surveysCacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	surveys, err := s.services.Survey.ListSurveys(c.Context(), accountID)
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
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Name                string               `json:"name"`
		Description         string               `json:"description"`
		Slug                string               `json:"slug"`
		WelcomeTitle        string               `json:"welcome_title"`
		WelcomeDescription  string               `json:"welcome_description"`
		ThankYouTitle       string               `json:"thank_you_title"`
		ThankYouMessage     string               `json:"thank_you_message"`
		ThankYouRedirectURL string               `json:"thank_you_redirect_url"`
		Branding            domain.SurveyBranding `json:"branding"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	survey := &domain.Survey{
		AccountID:           accountID,
		Name:                req.Name,
		Description:         req.Description,
		Slug:                req.Slug,
		WelcomeTitle:        req.WelcomeTitle,
		WelcomeDescription:  req.WelcomeDescription,
		ThankYouTitle:       req.ThankYouTitle,
		ThankYouMessage:     req.ThankYouMessage,
		ThankYouRedirectURL: req.ThankYouRedirectURL,
		Branding:            req.Branding,
		CreatedBy:           &userID,
	}

	if err := s.services.Survey.CreateSurvey(c.Context(), survey); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	s.invalidateSurveysCache(accountID)
	return c.Status(fiber.StatusCreated).JSON(survey)
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
		Name                string               `json:"name"`
		Description         string               `json:"description"`
		Slug                string               `json:"slug"`
		Status              string               `json:"status"`
		WelcomeTitle        string               `json:"welcome_title"`
		WelcomeDescription  string               `json:"welcome_description"`
		ThankYouTitle       string               `json:"thank_you_title"`
		ThankYouMessage     string               `json:"thank_you_message"`
		ThankYouRedirectURL string               `json:"thank_you_redirect_url"`
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
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	s.invalidateSurveysCache(accountID)
	return c.JSON(fiber.Map{"success": true})
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
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	s.invalidateSurveysCache(accountID)
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleCheckSurveySlug(c *fiber.Ctx) error {
	var req struct {
		Slug      string     `json:"slug"`
		ExcludeID *uuid.UUID `json:"exclude_id,omitempty"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	available, err := s.services.Survey.CheckSlug(c.Context(), req.Slug, req.ExcludeID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"available": available, "slug": req.Slug})
}

func (s *Server) handleDuplicateSurvey(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid survey ID"})
	}

	newSurvey, err := s.services.Survey.DuplicateSurvey(c.Context(), id, accountID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.Status(fiber.StatusCreated).JSON(newSurvey)
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

	saved, err := s.services.Survey.SaveQuestions(c.Context(), id, questions)
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

	responses, total, err := s.services.Survey.ListResponses(c.Context(), id, limit, offset)
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
	rid, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid response ID"})
	}

	resp, err := s.services.Survey.GetResponse(c.Context(), rid)
	if err != nil || resp == nil || resp.AccountID != accountID {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Response not found"})
	}
	return c.JSON(resp)
}

func (s *Server) handleDeleteSurveyResponse(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	rid, err := uuid.Parse(c.Params("rid"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid response ID"})
	}
	if resp, _ := s.services.Survey.GetResponse(c.Context(), rid); resp == nil || resp.AccountID != accountID {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Response not found"})
	}

	if err := s.services.Survey.DeleteResponse(c.Context(), rid); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}
	return c.JSON(fiber.Map{"success": true})
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

	analytics, err := s.services.Survey.GetAnalytics(c.Context(), id)
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

	data, err := s.services.Survey.GetExportData(c.Context(), id)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": err.Error()})
	}

	// Build CSV
	c.Set("Content-Type", "text/csv; charset=utf-8")
	c.Set("Content-Disposition", fmt.Sprintf("attachment; filename=survey_%s.csv", id.String()[:8]))

	// Collect all column headers
	headerSet := map[string]bool{"response_id": true, "token": true, "source": true}
	var extraHeaders []string
	for _, row := range data {
		for k := range row {
			if !headerSet[k] {
				headerSet[k] = true
				extraHeaders = append(extraHeaders, k)
			}
		}
	}
	headers := append([]string{"response_id", "token", "source"}, extraHeaders...)

	w := csv.NewWriter(c.Response().BodyWriter())
	_ = w.Write(headers)
	for _, row := range data {
		record := make([]string, len(headers))
		for i, h := range headers {
			record[i] = row[h]
		}
		_ = w.Write(record)
	}
	w.Flush()
	return nil
}

// ─── Public Handlers (No Auth) ──────────────────────────────────────────────

func (s *Server) handleGetPublicSurvey(c *fiber.Ctx) error {
	slug := c.Params("slug")
	if slug == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Slug is required"})
	}

	survey, questions, err := s.services.Survey.GetPublicSurvey(c.Context(), slug)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}

	return c.JSON(fiber.Map{
		"survey":    survey,
		"questions": questions,
	})
}

func (s *Server) handleSubmitSurveyResponse(c *fiber.Ctx) error {
	slug := c.Params("slug")

	// Resolve survey by slug
	survey, err := s.repos.Survey.GetBySlug(c.Context(), slug)
	if err != nil || survey.Status != "active" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}

	var req struct {
		RespondentToken string               `json:"respondent_token"`
		Source          string               `json:"source"`
		StartedAt       *time.Time           `json:"started_at"`
		Answers         []domain.SurveyAnswer `json:"answers"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid request body"})
	}

	if req.RespondentToken == "" {
		req.RespondentToken = uuid.New().String()
	}
	if req.Source == "" {
		req.Source = "direct"
	}

	now := time.Now()
	startedAt := now
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

	if err := s.services.Survey.SubmitResponse(c.Context(), resp, req.Answers); err != nil {
		log.Printf("[SURVEY] Error submitting response for %s: %v", slug, err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to submit response"})
	}

	return c.Status(fiber.StatusCreated).JSON(fiber.Map{
		"success":     true,
		"response_id": resp.ID,
	})
}

func (s *Server) handleUploadSurveyFile(c *fiber.Ctx) error {
	slug := c.Params("slug")

	// Verify survey exists and is active
	survey, err := s.repos.Survey.GetBySlug(c.Context(), slug)
	if err != nil || survey.Status != "active" {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"error": "Survey not found or not active"})
	}

	file, err := c.FormFile("file")
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "No file uploaded"})
	}

	// Limit 10MB
	if file.Size > 10*1024*1024 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "File too large (max 10MB)"})
	}

	f, err := file.Open()
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to read file"})
	}
	defer f.Close()

	ext := filepath.Ext(file.Filename)
	safeName := filepath.Base(file.Filename)
	if strings.Contains(safeName, "..") {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "Invalid filename"})
	}

	contentType := file.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	folder := fmt.Sprintf("surveys/%s", survey.ID.String())
	fileName := fmt.Sprintf("%s%s", uuid.New().String(), ext)

	url, err := s.storage.UploadReader(c.Context(), survey.AccountID, folder, fileName, f, file.Size, contentType)
	if err != nil {
		log.Printf("[SURVEY] Error uploading file: %v", err)
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"error": "Failed to upload file"})
	}

	return c.JSON(fiber.Map{
		"url":      url,
		"filename": safeName,
	})
}
