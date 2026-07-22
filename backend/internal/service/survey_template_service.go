package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type SurveyTemplateService struct {
	repos *repository.Repositories
}

func NewSurveyTemplateService(repos *repository.Repositories) *SurveyTemplateService {
	return &SurveyTemplateService{repos: repos}
}

func (s *SurveyTemplateService) List(ctx context.Context, accountID uuid.UUID, includeArchived bool) ([]*domain.SurveyTemplate, error) {
	return s.repos.SurveyTemplate.List(ctx, accountID, includeArchived)
}

func (s *SurveyTemplateService) Get(ctx context.Context, accountID, templateID uuid.UUID) (*domain.SurveyTemplate, error) {
	return s.repos.SurveyTemplate.Get(ctx, accountID, templateID)
}

func validateSurveyTemplate(template *domain.SurveyTemplate) error {
	template.Name = strings.TrimSpace(template.Name)
	if template.Name == "" {
		return errors.New("el nombre de la plantilla es obligatorio")
	}
	if len([]rune(template.Name)) > 180 {
		return errors.New("el nombre de la plantilla es demasiado largo")
	}
	if template.Status == "" {
		template.Status = "active"
	}
	if template.Status != "active" && template.Status != "archived" {
		return errors.New("estado de plantilla inválido")
	}
	redirectURL, err := NormalizeSurveyRedirectURL(template.ThankYouRedirectURL)
	if err != nil {
		return err
	}
	template.ThankYouRedirectURL = redirectURL
	return nil
}

func (s *SurveyTemplateService) Create(ctx context.Context, template *domain.SurveyTemplate) error {
	if err := validateSurveyTemplate(template); err != nil {
		return err
	}
	return s.repos.SurveyTemplate.Create(ctx, template)
}

func (s *SurveyTemplateService) Update(ctx context.Context, template *domain.SurveyTemplate) error {
	if err := validateSurveyTemplate(template); err != nil {
		return err
	}
	return s.repos.SurveyTemplate.Update(ctx, template)
}

func validSurveyQuestionType(questionType string) bool {
	switch questionType {
	case "short_text", "long_text", "single_choice", "multiple_choice", "rating", "likert", "date", "email", "phone", "file_upload":
		return true
	default:
		return false
	}
}

func validateTemplateQuestions(questions []domain.SurveyTemplateQuestion) error {
	for i := range questions {
		q := &questions[i]
		if q.ID == uuid.Nil {
			q.ID = uuid.New()
		}
		q.Title = strings.TrimSpace(q.Title)
		if !validSurveyQuestionType(q.Type) {
			return fmt.Errorf("tipo inválido en la pregunta %d", i+1)
		}
		if q.Title == "" {
			return fmt.Errorf("la pregunta %d necesita un título", i+1)
		}
		if len([]rune(q.Title)) > 500 {
			return fmt.Errorf("el título de la pregunta %d es demasiado largo", i+1)
		}
		if q.Type == "single_choice" || q.Type == "multiple_choice" {
			if len(q.Config.Options) < 2 {
				return fmt.Errorf("la pregunta %d necesita al menos dos opciones", i+1)
			}
			seen := map[string]struct{}{}
			for _, raw := range q.Config.Options {
				option := strings.TrimSpace(raw)
				if option == "" {
					return fmt.Errorf("la pregunta %d contiene una opción vacía", i+1)
				}
				if _, duplicate := seen[option]; duplicate {
					return fmt.Errorf("la pregunta %d contiene opciones duplicadas", i+1)
				}
				seen[option] = struct{}{}
			}
		}
		if q.Type == "rating" && (q.Config.MaxRating < 2 || q.Config.MaxRating > 10) {
			return fmt.Errorf("la calificación de la pregunta %d debe estar entre 2 y 10", i+1)
		}
		if q.Type == "likert" && (q.Config.LikertScale < 2 || q.Config.LikertScale > 10) {
			return fmt.Errorf("la escala de la pregunta %d debe estar entre 2 y 10", i+1)
		}
	}
	ids := make([]uuid.UUID, len(questions))
	rules := make([][]domain.SurveyLogicRule, len(questions))
	for i := range questions {
		ids[i] = questions[i].ID
		rules[i] = questions[i].LogicRules
	}
	return validateForwardSurveyLogic(ids, rules)
}

// validateForwardSurveyLogic keeps the public form traversal deterministic:
// every conditional destination must exist and appear after its source. A
// graph made exclusively of forward edges is acyclic by construction.
func validateForwardSurveyLogic(questionIDs []uuid.UUID, rulesByQuestion [][]domain.SurveyLogicRule) error {
	positions := make(map[uuid.UUID]int, len(questionIDs))
	for index, questionID := range questionIDs {
		if questionID == uuid.Nil {
			return fmt.Errorf("la pregunta %d no tiene un identificador válido", index+1)
		}
		if _, duplicate := positions[questionID]; duplicate {
			return errors.New("hay preguntas con identificadores duplicados")
		}
		positions[questionID] = index
	}
	for sourceIndex, rules := range rulesByQuestion {
		for _, rule := range rules {
			switch rule.Operator {
			case "", "eq", "neq", "contains", "gt", "lt":
			default:
				return fmt.Errorf("la pregunta %d contiene un operador condicional inválido", sourceIndex+1)
			}
			targetIndex, exists := positions[rule.JumpTo]
			if !exists {
				return fmt.Errorf("la lógica de la pregunta %d apunta a una pregunta inexistente", sourceIndex+1)
			}
			if targetIndex <= sourceIndex {
				return fmt.Errorf("la lógica de la pregunta %d solo puede saltar a una pregunta posterior", sourceIndex+1)
			}
		}
	}
	return nil
}

func (s *SurveyTemplateService) Questions(ctx context.Context, accountID, templateID uuid.UUID) ([]*domain.SurveyTemplateQuestion, error) {
	if _, err := s.repos.SurveyTemplate.Get(ctx, accountID, templateID); err != nil {
		return nil, err
	}
	return s.repos.SurveyTemplate.ListQuestions(ctx, accountID, templateID)
}

func (s *SurveyTemplateService) ReplaceQuestions(ctx context.Context, accountID, templateID uuid.UUID, questions []domain.SurveyTemplateQuestion) ([]*domain.SurveyTemplateQuestion, int, error) {
	if err := validateTemplateQuestions(questions); err != nil {
		return nil, 0, err
	}
	return s.repos.SurveyTemplate.ReplaceQuestions(ctx, accountID, templateID, questions)
}

func (s *SurveyTemplateService) CreateInstance(ctx context.Context, input domain.CreateSurveyInstanceInput) (*domain.SurveyInstanceSummary, error) {
	template, err := s.repos.SurveyTemplate.Get(ctx, input.AccountID, input.TemplateID)
	if err != nil {
		return nil, err
	}
	if template.QuestionCount == 0 {
		return nil, errors.New("la plantilla necesita al menos una pregunta antes de aplicarse")
	}
	snapshotQuestions, err := s.repos.SurveyTemplate.ListQuestions(ctx, input.AccountID, input.TemplateID)
	if err != nil {
		return nil, err
	}
	questionIDs := make([]uuid.UUID, len(snapshotQuestions))
	rules := make([][]domain.SurveyLogicRule, len(snapshotQuestions))
	for i, question := range snapshotQuestions {
		questionIDs[i] = question.ID
		rules[i] = question.LogicRules
	}
	if err := validateForwardSurveyLogic(questionIDs, rules); err != nil {
		return nil, fmt.Errorf("la plantilla contiene lógica condicional inválida: %w", err)
	}
	input.Name = strings.TrimSpace(input.Name)
	if len([]rune(input.Name)) > 180 {
		return nil, errors.New("el nombre de la aplicación es demasiado largo")
	}
	if input.Status == "" {
		input.Status = "active"
	}
	switch input.Status {
	case "draft", "active", "closed":
	default:
		return nil, errors.New("estado de aplicación inválido")
	}
	if input.OpensAt != nil && input.ClosesAt != nil && input.ClosesAt.Before(*input.OpensAt) {
		return nil, errors.New("la fecha de cierre debe ser posterior a la apertura")
	}
	if input.AudienceMode == "" {
		if input.ProgramID != nil {
			input.AudienceMode = "program_participants"
		} else {
			input.AudienceMode = "public"
		}
	}
	if input.AudienceMode != "public" && input.AudienceMode != "program_participants" {
		return nil, errors.New("audiencia de aplicación inválida")
	}
	if input.ProgramID == nil && input.AudienceMode != "public" {
		return nil, errors.New("una aplicación independiente debe usar audiencia pública")
	}
	if input.ProgramID != nil && input.AudienceMode != "program_participants" {
		return nil, errors.New("una encuesta de programa debe dirigirse a sus participantes")
	}
	base := Slugify(input.Slug)
	if base == "" {
		base = Slugify(input.Name)
	}
	if base == "" {
		base = Slugify(template.Name)
	}
	if base == "" {
		base = "encuesta"
	}
	input.Slug = base
	for attempts := 0; attempts < 4; attempts++ {
		exists, err := s.repos.Survey.SlugExists(ctx, input.Slug, nil)
		if err != nil {
			return nil, err
		}
		if !exists {
			break
		}
		input.Slug = base + "-" + uuid.NewString()[:6]
		if attempts == 3 {
			return nil, errors.New("no se pudo generar un enlace único")
		}
	}
	return s.repos.SurveyTemplate.CreateInstance(ctx, input)
}

func (s *SurveyTemplateService) ListTemplateInstances(ctx context.Context, accountID, templateID uuid.UUID) ([]*domain.SurveyInstanceSummary, error) {
	if _, err := s.repos.SurveyTemplate.Get(ctx, accountID, templateID); err != nil {
		return nil, err
	}
	return s.repos.SurveyTemplate.ListTemplateInstances(ctx, accountID, templateID)
}

func (s *SurveyTemplateService) ListProgramInstances(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.SurveyInstanceSummary, error) {
	program, err := s.repos.Program.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return nil, repository.ErrSurveyInstanceNotFound
	}
	return s.repos.SurveyTemplate.ListProgramInstances(ctx, accountID, programID)
}

func (s *SurveyTemplateService) ListProgramRecipients(ctx context.Context, accountID, programID, surveyID uuid.UUID, search string, limit, offset int) ([]*domain.SurveyInstanceRecipient, int, error) {
	program, err := s.repos.Program.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return nil, 0, repository.ErrSurveyInstanceNotFound
	}
	instance, err := s.repos.SurveyTemplate.GetInstance(ctx, accountID, surveyID)
	if err != nil || instance.ProgramID == nil || *instance.ProgramID != programID || instance.AudienceMode != "program_participants" {
		return nil, 0, repository.ErrSurveyInstanceNotFound
	}
	return s.repos.SurveyTemplate.ListProgramRecipients(ctx, accountID, programID, surveyID, search, limit, offset)
}

func (s *SurveyTemplateService) ResolveRecipient(ctx context.Context, surveyID uuid.UUID, rawToken string, markOpened bool) (*domain.SurveyInstanceRecipient, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, nil
	}
	token, err := uuid.Parse(rawToken)
	if err != nil {
		return nil, repository.ErrSurveyRecipientInvalid
	}
	recipient, err := s.repos.SurveyTemplate.GetRecipientByToken(ctx, surveyID, token)
	if err != nil {
		return nil, err
	}
	if markOpened {
		if err := s.repos.SurveyTemplate.MarkRecipientOpened(ctx, recipient.ID, recipient.AccountID); err != nil {
			return nil, err
		}
	}
	return recipient, nil
}

// ValidateSurveyAnswers treats the published instance snapshot as canonical.
// It rejects foreign IDs, duplicates, missing required answers and invalid
// option/range payloads before the repository starts its transaction.
func ValidateSurveyAnswers(questions []*domain.SurveyQuestion, answers []domain.SurveyAnswer) error {
	byID := make(map[uuid.UUID]*domain.SurveyQuestion, len(questions))
	for _, q := range questions {
		byID[q.ID] = q
	}
	seen := make(map[uuid.UUID]domain.SurveyAnswer, len(answers))
	for _, answer := range answers {
		q, ok := byID[answer.QuestionID]
		if !ok {
			return errors.New("una respuesta no pertenece a esta encuesta")
		}
		if _, duplicate := seen[answer.QuestionID]; duplicate {
			return errors.New("una pregunta fue respondida más de una vez")
		}
		if len(answer.Value) > 20000 {
			return errors.New("una respuesta excede el tamaño permitido")
		}
		if q.Type != "file_upload" && (answer.FileURL != "" || answer.UploadID != nil) {
			return errors.New("se recibió un archivo para una pregunta incompatible")
		}
		if q.Type == "file_upload" && strings.TrimSpace(answer.FileURL) != "" {
			return errors.New("la referencia del archivo debe provenir de una carga válida")
		}
		if err := validateSurveyAnswerValue(q, answer); err != nil {
			return err
		}
		seen[answer.QuestionID] = answer
	}
	questionIDs := make([]uuid.UUID, len(questions))
	rules := make([][]domain.SurveyLogicRule, len(questions))
	for i, q := range questions {
		questionIDs[i] = q.ID
		rules[i] = q.LogicRules
	}
	if err := validateForwardSurveyLogic(questionIDs, rules); err != nil {
		return err
	}

	positions := make(map[uuid.UUID]int, len(questions))
	for index, q := range questions {
		positions[q.ID] = index
	}
	// Required questions are validated only along the route that the submitted
	// answers actually make reachable. A forward jump may legitimately skip a
	// required question that the respondent never saw.
	for index := 0; index < len(questions); {
		q := questions[index]
		answer, answered := seen[q.ID]
		if q.Required && (!answered || (strings.TrimSpace(answer.Value) == "" && answer.UploadID == nil)) {
			return fmt.Errorf("la pregunta %q es obligatoria", q.Title)
		}
		nextIndex := index + 1
		for _, rule := range q.LogicRules {
			if surveyLogicRuleMatches(rule, answer.Value) {
				nextIndex = positions[rule.JumpTo]
				break
			}
		}
		index = nextIndex
	}
	return nil
}

func surveyLogicRuleMatches(rule domain.SurveyLogicRule, value string) bool {
	switch rule.Operator {
	case "", "eq":
		return value == rule.Value
	case "neq":
		return value != rule.Value
	case "contains":
		return strings.Contains(value, rule.Value)
	case "gt", "lt":
		actual, actualErr := strconv.ParseFloat(value, 64)
		expected, expectedErr := strconv.ParseFloat(rule.Value, 64)
		if actualErr != nil || expectedErr != nil {
			return false
		}
		if rule.Operator == "gt" {
			return actual > expected
		}
		return actual < expected
	default:
		return false
	}
}

func validateSurveyAnswerValue(q *domain.SurveyQuestion, answer domain.SurveyAnswer) error {
	value := strings.TrimSpace(answer.Value)
	if value == "" && answer.UploadID == nil {
		return nil
	}
	switch q.Type {
	case "single_choice":
		if !containsString(q.Config.Options, value) {
			return fmt.Errorf("respuesta inválida para %q", q.Title)
		}
	case "multiple_choice":
		var selected []string
		if err := json.Unmarshal([]byte(value), &selected); err != nil || len(selected) == 0 {
			return fmt.Errorf("respuesta inválida para %q", q.Title)
		}
		seen := map[string]struct{}{}
		for _, option := range selected {
			if !containsString(q.Config.Options, option) {
				return fmt.Errorf("respuesta inválida para %q", q.Title)
			}
			if _, duplicate := seen[option]; duplicate {
				return fmt.Errorf("respuesta duplicada para %q", q.Title)
			}
			seen[option] = struct{}{}
		}
	case "rating":
		valueInt, err := strconv.Atoi(value)
		maxRating := q.Config.MaxRating
		if maxRating == 0 {
			maxRating = 5
		}
		if err != nil || valueInt < 1 || valueInt > maxRating {
			return fmt.Errorf("calificación inválida para %q", q.Title)
		}
	case "likert":
		valueInt, err := strconv.Atoi(value)
		likertScale := q.Config.LikertScale
		if likertScale == 0 {
			likertScale = 5
		}
		if err != nil || valueInt < 1 || valueInt > likertScale {
			return fmt.Errorf("valor inválido para %q", q.Title)
		}
	case "email":
		if _, err := mail.ParseAddress(value); err != nil {
			return fmt.Errorf("correo inválido para %q", q.Title)
		}
	case "date":
		if _, err := time.Parse("2006-01-02", value); err != nil {
			return fmt.Errorf("fecha inválida para %q", q.Title)
		}
	case "file_upload":
		if answer.UploadID == nil {
			return fmt.Errorf("archivo inválido para %q", q.Title)
		}
	}
	return nil
}

func containsString(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
