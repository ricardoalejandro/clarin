package service

import (
	"context"
	"errors"
	"regexp"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type SurveyService struct {
	repo *repository.Repositories
}

func NewSurveyService(repo *repository.Repositories) *SurveyService {
	return &SurveyService{repo: repo}
}

var slugRegex = regexp.MustCompile(`[^a-z0-9-]+`)
var multiDash = regexp.MustCompile(`-{2,}`)

func Slugify(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = slugRegex.ReplaceAllString(s, "-")
	s = multiDash.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if len(s) > 60 {
		s = s[:60]
	}
	return s
}

func (svc *SurveyService) CreateSurvey(ctx context.Context, s *domain.Survey) error {
	if s.Name == "" {
		return errors.New("survey name is required")
	}
	if s.Status == "" {
		s.Status = "draft"
	}

	// Generate slug if not provided
	if s.Slug == "" {
		base := Slugify(s.Name)
		s.Slug = base
		// Ensure uniqueness by appending short UUID suffix
		exists, _ := svc.repo.Survey.SlugExists(ctx, s.Slug, nil)
		if exists {
			s.Slug = base + "-" + uuid.New().String()[:6]
		}
	} else {
		s.Slug = Slugify(s.Slug)
	}

	// Check slug uniqueness
	exists, err := svc.repo.Survey.SlugExists(ctx, s.Slug, nil)
	if err != nil {
		return err
	}
	if exists {
		return errors.New("slug already exists")
	}

	return svc.repo.Survey.Create(ctx, s)
}

func (svc *SurveyService) GetSurvey(ctx context.Context, id, accountID uuid.UUID) (*domain.Survey, error) {
	return svc.repo.Survey.GetByID(ctx, id, accountID)
}

func (svc *SurveyService) ListSurveys(ctx context.Context, accountID uuid.UUID) ([]*domain.Survey, error) {
	return svc.repo.Survey.List(ctx, accountID)
}

func (svc *SurveyService) UpdateSurvey(ctx context.Context, s *domain.Survey) error {
	if s.Name == "" {
		return errors.New("survey name is required")
	}

	if s.Slug != "" {
		s.Slug = Slugify(s.Slug)
		exists, err := svc.repo.Survey.SlugExists(ctx, s.Slug, &s.ID)
		if err != nil {
			return err
		}
		if exists {
			return errors.New("slug already exists")
		}
	}

	return svc.repo.Survey.Update(ctx, s)
}

func (svc *SurveyService) DeleteSurvey(ctx context.Context, id, accountID uuid.UUID) error {
	s, err := svc.repo.Survey.GetByID(ctx, id, accountID)
	if err != nil {
		return err
	}
	if s.IsTemplate {
		return errors.New("las encuestas modelo no se pueden eliminar")
	}
	return svc.repo.Survey.Delete(ctx, id, accountID)
}

func (svc *SurveyService) SetStatus(ctx context.Context, id, accountID uuid.UUID, status string) error {
	switch status {
	case "draft", "active", "closed":
	default:
		return errors.New("invalid status: must be draft, active, or closed")
	}
	return svc.repo.Survey.SetStatus(ctx, id, accountID, status)
}

func (svc *SurveyService) CheckSlug(ctx context.Context, slug string, excludeID *uuid.UUID) (bool, error) {
	slug = Slugify(slug)
	if slug == "" {
		return false, errors.New("slug cannot be empty")
	}
	exists, err := svc.repo.Survey.SlugExists(ctx, slug, excludeID)
	return !exists, err // returns true if available
}

func (svc *SurveyService) DuplicateSurvey(ctx context.Context, id, accountID uuid.UUID) (*domain.Survey, error) {
	src, err := svc.repo.Survey.GetByID(ctx, id, accountID)
	if err != nil {
		return nil, err
	}

	newName := src.Name + " (copia)"
	newSlug := Slugify(newName)
	exists, _ := svc.repo.Survey.SlugExists(ctx, newSlug, nil)
	if exists {
		newSlug = newSlug + "-" + uuid.New().String()[:6]
	}

	return svc.repo.Survey.Duplicate(ctx, id, accountID, newName, newSlug)
}

// ─── Questions ──────────────────────────────────────────────────────────────

func (svc *SurveyService) GetQuestions(ctx context.Context, surveyID uuid.UUID) ([]*domain.SurveyQuestion, error) {
	return svc.repo.Survey.GetQuestions(ctx, surveyID)
}

func (svc *SurveyService) SaveQuestions(ctx context.Context, surveyID uuid.UUID, questions []domain.SurveyQuestion) ([]*domain.SurveyQuestion, error) {
	// Validate question types
	validTypes := map[string]bool{
		"short_text": true, "long_text": true, "single_choice": true, "multiple_choice": true,
		"rating": true, "likert": true, "date": true, "email": true, "phone": true, "file_upload": true,
	}
	for i, q := range questions {
		if !validTypes[q.Type] {
			return nil, errors.New("invalid question type: " + q.Type)
		}
		if q.Title == "" {
			return nil, errors.New("question title is required")
		}
		questions[i].SurveyID = surveyID
	}
	return svc.repo.Survey.BulkUpsertQuestions(ctx, surveyID, questions)
}

// ─── Responses ──────────────────────────────────────────────────────────────

func (svc *SurveyService) ListResponses(ctx context.Context, surveyID uuid.UUID, limit, offset int) ([]*domain.SurveyResponse, int, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	return svc.repo.Survey.ListResponses(ctx, surveyID, limit, offset)
}

func (svc *SurveyService) GetResponse(ctx context.Context, responseID uuid.UUID) (*domain.SurveyResponse, error) {
	return svc.repo.Survey.GetResponse(ctx, responseID)
}

func (svc *SurveyService) DeleteResponse(ctx context.Context, responseID uuid.UUID) error {
	return svc.repo.Survey.DeleteResponse(ctx, responseID)
}

// ─── Analytics ──────────────────────────────────────────────────────────────

func (svc *SurveyService) GetAnalytics(ctx context.Context, surveyID uuid.UUID) (*domain.SurveyAnalytics, error) {
	return svc.repo.Survey.GetAnalytics(ctx, surveyID)
}

// ─── Public ─────────────────────────────────────────────────────────────────

func (svc *SurveyService) GetPublicSurvey(ctx context.Context, slug string) (*domain.Survey, []*domain.SurveyQuestion, error) {
	survey, err := svc.repo.Survey.GetBySlug(ctx, slug)
	if err != nil {
		return nil, nil, err
	}
	if survey.Status != "active" {
		return nil, nil, errors.New("survey is not active")
	}
	questions, err := svc.repo.Survey.GetQuestions(ctx, survey.ID)
	if err != nil {
		return nil, nil, err
	}
	return survey, questions, nil
}

func (svc *SurveyService) SubmitResponse(ctx context.Context, resp *domain.SurveyResponse, answers []domain.SurveyAnswer) error {
	return svc.repo.Survey.CreateResponse(ctx, resp, answers)
}

func (svc *SurveyService) GetExportData(ctx context.Context, surveyID uuid.UUID) ([]map[string]string, error) {
	return svc.repo.Survey.GetAllAnswersForExport(ctx, surveyID)
}
