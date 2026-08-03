package service

import (
	"context"
	"encoding/base64"
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

var ErrSurveyTextAnswerCursorInvalid = errors.New("invalid survey text answer cursor")

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

func (svc *SurveyService) ListSurveysWithArchived(ctx context.Context, accountID uuid.UUID, includeArchived bool) ([]*domain.Survey, error) {
	return svc.repo.Survey.ListWithArchived(ctx, accountID, includeArchived)
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
	if current.ArchivedAt != nil {
		return repository.ErrSurveyArchived
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
			return repository.ErrSurveySlugUnavailable
		}
	}
	if err := validateSurveyPresentationMutation(current, s); err != nil {
		return err
	}

	return svc.repo.Survey.Update(ctx, s)
}

func (svc *SurveyService) DeleteSurvey(ctx context.Context, id, accountID uuid.UUID) error {
	return svc.repo.Survey.Delete(ctx, id, accountID)
}

func (svc *SurveyService) ArchiveSurvey(ctx context.Context, id, accountID, actorID uuid.UUID) (*domain.SurveyInstanceSummary, error) {
	if err := svc.repo.Survey.Archive(ctx, accountID, id, actorID); err != nil {
		return nil, err
	}
	return svc.repo.SurveyTemplate.GetInstance(ctx, accountID, id)
}

func (svc *SurveyService) RestoreSurvey(ctx context.Context, id, accountID uuid.UUID) (*domain.SurveyInstanceSummary, error) {
	if err := svc.repo.Survey.Restore(ctx, accountID, id); err != nil {
		return nil, err
	}
	return svc.repo.SurveyTemplate.GetInstance(ctx, accountID, id)
}

func (svc *SurveyService) SetStatus(ctx context.Context, id, accountID uuid.UUID, status string) error {
	current, err := svc.repo.Survey.GetByID(ctx, id, accountID)
	if err != nil {
		return err
	}
	if current.ArchivedAt != nil {
		return repository.ErrSurveyArchived
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
	nextBranding := next.Branding
	if err := NormalizeSurveyBranding(&nextBranding); err != nil {
		return err
	}
	if current.Status == "draft" && (current.LegacyInstance || current.TemplateID == nil) {
		next.Branding = nextBranding
		return nil
	}
	currentBranding := current.Branding
	if err := NormalizeSurveyBranding(&currentBranding); err != nil {
		currentBranding = current.Branding
	}
	if current.Name != next.Name ||
		current.Description != next.Description ||
		current.Slug != next.Slug ||
		current.WelcomeTitle != next.WelcomeTitle ||
		current.WelcomeDescription != next.WelcomeDescription ||
		current.ThankYouTitle != next.ThankYouTitle ||
		current.ThankYouMessage != next.ThankYouMessage ||
		current.ThankYouRedirectURL != next.ThankYouRedirectURL ||
		currentBranding != nextBranding {
		return repository.ErrSurveyPublishedImmutable
	}
	return nil
}

func (svc *SurveyService) CheckSlug(ctx context.Context, accountID uuid.UUID, slug string, excludeID *uuid.UUID) (bool, error) {
	slug = Slugify(slug)
	if slug == "" {
		return false, errors.New("slug cannot be empty")
	}
	if excludeID != nil {
		if _, err := svc.repo.Survey.GetByID(ctx, *excludeID, accountID); err != nil {
			// Availability is intentionally non-enumerating: an excluded survey
			// outside the active account is treated as if no exclusion was sent.
			excludeID = nil
		}
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

func (svc *SurveyService) ListTextAnswers(ctx context.Context, accountID, surveyID, questionID uuid.UUID, limit int, rawCursor string) (*domain.SurveyTextAnswersPage, error) {
	limit = normalizeSurveyTextAnswerLimit(limit)
	completedAt, responseID, err := decodeSurveyTextAnswerCursor(rawCursor)
	if err != nil {
		return nil, err
	}
	page, err := svc.repo.Survey.ListTextAnswers(ctx, accountID, surveyID, questionID, limit, completedAt, responseID)
	if err != nil {
		return nil, err
	}
	if len(page.Items) > limit {
		page.Items = page.Items[:limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor = encodeSurveyTextAnswerCursor(last.CompletedAt, last.ResponseID)
	}
	return page, nil
}

func normalizeSurveyTextAnswerLimit(limit int) int {
	if limit <= 0 {
		limit = 25
	}
	if limit > 100 {
		limit = 100
	}
	return limit
}

func encodeSurveyTextAnswerCursor(completedAt time.Time, responseID uuid.UUID) string {
	raw := completedAt.UTC().Format(time.RFC3339Nano) + "|" + responseID.String()
	return base64.RawURLEncoding.EncodeToString([]byte(raw))
}

func decodeSurveyTextAnswerCursor(raw string) (*time.Time, *uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(raw))
	if err != nil {
		return nil, nil, ErrSurveyTextAnswerCursorInvalid
	}
	parts := strings.SplitN(string(decoded), "|", 2)
	if len(parts) != 2 {
		return nil, nil, ErrSurveyTextAnswerCursorInvalid
	}
	completedAt, err := time.Parse(time.RFC3339Nano, parts[0])
	if err != nil {
		return nil, nil, ErrSurveyTextAnswerCursorInvalid
	}
	responseID, err := uuid.Parse(parts[1])
	if err != nil {
		return nil, nil, ErrSurveyTextAnswerCursorInvalid
	}
	return &completedAt, &responseID, nil
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
	if survey.ArchivedAt != nil {
		return nil, nil, repository.ErrSurveyArchived
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
		if errors.Is(err, repository.ErrSurveyArchived) || errors.Is(err, repository.ErrSurveyNotAcceptingResponses) {
			return err
		}
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

func (svc *SurveyService) TrackSession(ctx context.Context, event domain.SurveySessionEvent) error {
	switch event.Phase {
	case domain.SurveySessionOpened, domain.SurveySessionStarted:
		if event.QuestionID != nil {
			return errors.New("la fase de sesión no admite una pregunta")
		}
	case domain.SurveySessionReached, domain.SurveySessionAnswered:
		if event.QuestionID == nil {
			return errors.New("la fase de sesión necesita una pregunta")
		}
	default:
		return errors.New("fase de sesión inválida")
	}
	event.Source = strings.TrimSpace(event.Source)
	if event.Source == "" {
		event.Source = "direct"
	}
	if len(event.Source) > 40 {
		return errors.New("origen de sesión inválido")
	}
	return svc.repo.Survey.TrackSession(ctx, event)
}

func (svc *SurveyService) GetExportData(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyExportData, error) {
	return svc.repo.Survey.GetAllAnswersForExport(ctx, accountID, surveyID)
}
