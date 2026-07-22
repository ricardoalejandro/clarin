package service

import (
	"context"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
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

var ErrSurveyRedirectURLInvalid = errors.New("la URL de redirección es inválida; usa una dirección absoluta http o https")

// NormalizeSurveyRedirectURL is the single trust boundary for redirects that
// are later consumed by the public survey page. In particular, it prevents a
// stored javascript: URL from becoming script execution in Clarin's origin.
func NormalizeSurveyRedirectURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", nil
	}
	if len(value) > 2048 {
		return "", ErrSurveyRedirectURLInvalid
	}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil {
		return "", ErrSurveyRedirectURLInvalid
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", ErrSurveyRedirectURLInvalid
	}
	parsed.Scheme = scheme
	return parsed.String(), nil
}

// SafeSurveyRedirectURL is a read-side compatibility guard for historical
// rows that predate validation. Invalid legacy values are never sent to the
// public renderer, but remain stored until an authorized user corrects them.
func SafeSurveyRedirectURL(raw string) string {
	value, err := NormalizeSurveyRedirectURL(raw)
	if err != nil {
		return ""
	}
	return value
}

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
	return repository.ErrRawSurveyMutationDisabled
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
	redirectURL, err := NormalizeSurveyRedirectURL(s.ThankYouRedirectURL)
	if err != nil {
		return err
	}
	s.ThankYouRedirectURL = redirectURL
	current, err := svc.repo.Survey.GetByID(ctx, s.ID, s.AccountID)
	if err != nil {
		return err
	}
	if err := validateSurveyStatusTransition(current.Status, s.Status); err != nil {
		return err
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
	if err := validateSurveyPresentationMutation(current, s); err != nil {
		return err
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
	if s.Status != "draft" || s.LegacyInstance || s.TemplateID == nil || s.OpensAt != nil {
		return errors.New("solo se puede anular un borrador canónico que nunca fue publicado ni distribuido")
	}
	distributed, err := svc.repo.Survey.HasDistribution(ctx, accountID, id)
	if err != nil {
		return err
	}
	if distributed {
		return errors.New("una aplicación distribuida no se puede eliminar; ciérrala para conservar su historial")
	}
	return svc.repo.Survey.Delete(ctx, id, accountID)
}

func (svc *SurveyService) SetStatus(ctx context.Context, id, accountID uuid.UUID, status string) error {
	current, err := svc.repo.Survey.GetByID(ctx, id, accountID)
	if err != nil {
		return err
	}
	if err := validateSurveyStatusTransition(current.Status, status); err != nil {
		return err
	}
	return svc.repo.Survey.SetStatus(ctx, id, accountID, status)
}

func validateSurveyStatusTransition(current, next string) error {
	switch next {
	case "draft", "active", "closed":
	default:
		return errors.New("invalid status: must be draft, active, or closed")
	}
	if current != "draft" && next == "draft" {
		return repository.ErrSurveyCannotReturnToDraft
	}
	return nil
}

func validateSurveyPresentationMutation(current, next *domain.Survey) error {
	if current.Status == "draft" && (current.LegacyInstance || current.TemplateID == nil) {
		return nil
	}
	if current.Name != next.Name ||
		current.Description != next.Description ||
		current.Slug != next.Slug ||
		current.WelcomeTitle != next.WelcomeTitle ||
		current.WelcomeDescription != next.WelcomeDescription ||
		current.ThankYouTitle != next.ThankYouTitle ||
		current.ThankYouMessage != next.ThankYouMessage ||
		current.ThankYouRedirectURL != next.ThankYouRedirectURL ||
		current.Branding != next.Branding {
		return repository.ErrSurveyPublishedImmutable
	}
	return nil
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
	return nil, repository.ErrRawSurveyMutationDisabled
}

// ─── Questions ──────────────────────────────────────────────────────────────

func (svc *SurveyService) GetQuestions(ctx context.Context, surveyID uuid.UUID) ([]*domain.SurveyQuestion, error) {
	return svc.repo.Survey.GetQuestions(ctx, surveyID)
}

func (svc *SurveyService) SaveQuestions(ctx context.Context, accountID, surveyID uuid.UUID, questions []domain.SurveyQuestion) ([]*domain.SurveyQuestion, error) {
	survey, err := svc.repo.Survey.GetByID(ctx, surveyID, accountID)
	if err != nil {
		return nil, err
	}
	_, started, err := svc.repo.Survey.GetResponseCount(ctx, surveyID)
	if err != nil {
		return nil, err
	}
	if err := validateSurveyQuestionMutation(survey, started); err != nil {
		return nil, err
	}
	// Validate question types
	for i, q := range questions {
		if q.ID == uuid.Nil {
			questions[i].ID = uuid.New()
		}
		if !validSurveyQuestionType(q.Type) {
			return nil, errors.New("invalid question type: " + q.Type)
		}
		if q.Title == "" {
			return nil, errors.New("question title is required")
		}
		questions[i].SurveyID = surveyID
	}
	questionIDs := make([]uuid.UUID, len(questions))
	rules := make([][]domain.SurveyLogicRule, len(questions))
	for i := range questions {
		questionIDs[i] = questions[i].ID
		rules[i] = questions[i].LogicRules
	}
	if err := validateForwardSurveyLogic(questionIDs, rules); err != nil {
		return nil, err
	}
	return svc.repo.Survey.BulkUpsertQuestions(ctx, accountID, surveyID, questions)
}

func validateSurveyQuestionMutation(survey *domain.Survey, started int) error {
	if started > 0 {
		return repository.ErrSurveyPublishedImmutable
	}
	// Every canonical application is an immutable snapshot from the moment it
	// is instantiated, including drafts. Only response-free legacy/raw drafts
	// keep their old editing behavior during the compatibility window.
	if survey.Status != "draft" || (!survey.LegacyInstance && survey.TemplateID != nil) {
		return repository.ErrSurveyPublishedImmutable
	}
	return nil
}

// ─── Responses ──────────────────────────────────────────────────────────────

func (svc *SurveyService) ListResponses(ctx context.Context, accountID, surveyID uuid.UUID, limit, offset int) ([]*domain.SurveyResponse, int, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	return svc.repo.Survey.ListResponses(ctx, accountID, surveyID, limit, offset)
}

func (svc *SurveyService) GetResponse(ctx context.Context, responseID uuid.UUID) (*domain.SurveyResponse, error) {
	return svc.repo.Survey.GetResponse(ctx, responseID)
}

func (svc *SurveyService) GetResponseScoped(ctx context.Context, accountID, surveyID, responseID uuid.UUID) (*domain.SurveyResponse, error) {
	return svc.repo.Survey.GetResponseScoped(ctx, accountID, surveyID, responseID)
}

func (svc *SurveyService) DeleteResponse(ctx context.Context, responseID uuid.UUID) error {
	return svc.repo.Survey.DeleteResponse(ctx, responseID)
}

func (svc *SurveyService) DeleteResponseScoped(ctx context.Context, accountID, surveyID, responseID uuid.UUID) error {
	return svc.repo.Survey.DeleteResponseScoped(ctx, accountID, surveyID, responseID)
}

// ─── Analytics ──────────────────────────────────────────────────────────────

func (svc *SurveyService) GetAnalytics(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyAnalytics, error) {
	return svc.repo.Survey.GetAnalytics(ctx, accountID, surveyID)
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
	now := time.Now()
	if survey.OpensAt != nil && now.Before(*survey.OpensAt) {
		return nil, nil, errors.New("survey is not open yet")
	}
	if survey.ClosesAt != nil && now.After(*survey.ClosesAt) {
		return nil, nil, errors.New("survey is closed")
	}
	questions, err := svc.repo.Survey.GetQuestions(ctx, survey.ID)
	if err != nil {
		return nil, nil, err
	}
	return survey, questions, nil
}

func (svc *SurveyService) SubmitResponse(ctx context.Context, resp *domain.SurveyResponse, answers []domain.SurveyAnswer) error {
	questions, err := svc.repo.Survey.GetQuestions(ctx, resp.SurveyID)
	if err != nil {
		return err
	}
	if err := ValidateSurveyAnswers(questions, answers); err != nil {
		return err
	}
	if err := svc.repo.Survey.CreateResponse(ctx, resp, answers); err != nil {
		if errors.Is(err, repository.ErrSurveyUploadInvalid) {
			return errors.New("el archivo no pertenece a esta encuesta, pregunta o destinatario, o ya venció")
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_survey_responses_recipient" {
			return errors.New("esta encuesta ya fue respondida")
		}
		return errors.New("no se pudo guardar la respuesta")
	}
	return nil
}

func (svc *SurveyService) GetExportData(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyExportData, error) {
	return svc.repo.Survey.GetAllAnswersForExport(ctx, accountID, surveyID)
}
