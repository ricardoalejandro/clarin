package service

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/mail"
	"net/url"
	"regexp"
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
	if err := NormalizeSurveyBranding(&template.Branding); err != nil {
		return err
	}
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

func (s *SurveyTemplateService) Duplicate(ctx context.Context, accountID, sourceID uuid.UUID, name string, createdBy *uuid.UUID) (*domain.SurveyTemplate, error) {
	copyTemplate := &domain.SurveyTemplate{Name: name, Status: "active"}
	if err := validateSurveyTemplate(copyTemplate); err != nil {
		return nil, err
	}
	return s.repos.SurveyTemplate.Duplicate(ctx, accountID, sourceID, copyTemplate.Name, createdBy)
}

func (s *SurveyTemplateService) SuggestInstanceName(ctx context.Context, accountID, templateID uuid.UUID, programID *uuid.UUID, requested string) (*domain.SurveyInstanceNameSuggestion, error) {
	return s.repos.SurveyTemplate.SuggestInstanceName(ctx, accountID, templateID, programID, requested)
}

func (s *SurveyTemplateService) UpdateDesign(ctx context.Context, accountID, templateID uuid.UUID, branding domain.SurveyBranding, logoAssetID, backgroundAssetID *uuid.UUID) (*domain.SurveyTemplate, error) {
	if err := NormalizeSurveyBranding(&branding); err != nil {
		return nil, err
	}
	branding.LogoMediaAssetID = logoAssetID
	branding.BgImageMediaAssetID = backgroundAssetID
	return s.repos.SurveyTemplate.UpdateDesign(ctx, accountID, templateID, branding, logoAssetID, backgroundAssetID)
}

var measurementKeyPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,63}$`)
var surveyHexColorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)

var surveyBrandingFonts = map[string]struct{}{
	"Inter": {}, "Poppins": {}, "DM Sans": {}, "Space Grotesk": {}, "Montserrat": {},
	"Roboto": {}, "Open Sans": {}, "Lato": {}, "Nunito": {}, "Playfair Display": {},
}

func normalizeSurveyBrandingURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" || strings.HasPrefix(value, "/api/media/file/") {
		return value, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || !parsed.IsAbs() || parsed.Host == "" || parsed.Hostname() == "" || parsed.User != nil {
		return "", errors.New("la URL de imagen es inválida; usa una dirección absoluta http o https")
	}
	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", errors.New("la URL de imagen es inválida; usa una dirección absoluta http o https")
	}
	parsed.Scheme = scheme
	return parsed.String(), nil
}

// NormalizeSurveyBranding is shared by JSON compatibility updates and the
// multipart design endpoint. Uploaded asset ownership is validated separately
// inside the account-scoped repository transaction.
func NormalizeSurveyBranding(branding *domain.SurveyBranding) error {
	for _, color := range []*string{&branding.AccentColor, &branding.BgColor, &branding.TextColor} {
		value := strings.TrimSpace(*color)
		if value == "" {
			continue
		}
		if !surveyHexColorPattern.MatchString(value) {
			return errors.New("los colores del diseño deben usar el formato #RRGGBB")
		}
		*color = strings.ToUpper(value)
	}
	if branding.FontFamily != "" {
		if _, allowed := surveyBrandingFonts[branding.FontFamily]; !allowed {
			return errors.New("la tipografía seleccionada no es válida")
		}
	}
	if branding.TitleSize != "" && branding.TitleSize != "sm" && branding.TitleSize != "md" && branding.TitleSize != "lg" && branding.TitleSize != "xl" {
		return errors.New("el tamaño de título no es válido")
	}
	if branding.ButtonStyle != "" && branding.ButtonStyle != "rounded" && branding.ButtonStyle != "pill" && branding.ButtonStyle != "square" {
		return errors.New("el estilo de botón no es válido")
	}
	if branding.QuestionAlign != "" && branding.QuestionAlign != "left" && branding.QuestionAlign != "center" {
		return errors.New("la alineación del diseño no es válida")
	}
	if branding.LogoSize != "" && branding.LogoSize != "sm" && branding.LogoSize != "md" && branding.LogoSize != "lg" {
		return errors.New("el tamaño de logo no es válido")
	}
	if branding.BgPosition != "" && branding.BgPosition != "top" && branding.BgPosition != "center" && branding.BgPosition != "bottom" {
		return errors.New("la posición de fondo no es válida")
	}
	if branding.BgOverlay != "" {
		overlay, err := strconv.ParseFloat(branding.BgOverlay, 64)
		if err != nil || math.IsNaN(overlay) || overlay < 0 || overlay > 0.8 {
			return errors.New("la opacidad de fondo debe estar entre 0 y 0.8")
		}
		branding.BgOverlay = strconv.FormatFloat(overlay, 'f', 1, 64)
	}
	var err error
	branding.LogoURL, err = normalizeSurveyBrandingURL(branding.LogoURL)
	if err != nil {
		return err
	}
	branding.BgImageURL, err = normalizeSurveyBrandingURL(branding.BgImageURL)
	return err
}

func validateMeasurementMutation(questions []*domain.SurveyTemplateQuestion, mutation *domain.SurveyMeasurementMutation) (map[uuid.UUID]*domain.SurveyQuestionMeasurement, error) {
	dimensionKeys := make(map[string]struct{}, len(mutation.Dimensions))
	for index := range mutation.Dimensions {
		dimension := &mutation.Dimensions[index]
		dimension.Key = strings.ToLower(strings.TrimSpace(dimension.Key))
		dimension.Name = strings.TrimSpace(dimension.Name)
		dimension.Description = strings.TrimSpace(dimension.Description)
		if !measurementKeyPattern.MatchString(dimension.Key) {
			return nil, fmt.Errorf("la dimensión %d necesita una clave válida", index+1)
		}
		if dimension.Name == "" || len([]rune(dimension.Name)) > 120 {
			return nil, fmt.Errorf("la dimensión %d necesita un nombre válido", index+1)
		}
		if _, duplicate := dimensionKeys[dimension.Key]; duplicate {
			return nil, errors.New("hay dimensiones con claves duplicadas")
		}
		dimensionKeys[dimension.Key] = struct{}{}
		if dimension.MinimumAnsweredRatio == 0 {
			dimension.MinimumAnsweredRatio = 1
		}
		if dimension.MinimumAnsweredRatio <= 0 || dimension.MinimumAnsweredRatio > 1 || math.IsNaN(dimension.MinimumAnsweredRatio) {
			return nil, fmt.Errorf("la dimensión %s tiene un mínimo respondido inválido", dimension.Name)
		}
	}
	questionByID := make(map[uuid.UUID]*domain.SurveyTemplateQuestion, len(questions))
	for _, question := range questions {
		questionByID[question.ID] = question
	}
	assignments := make(map[uuid.UUID]*domain.SurveyQuestionMeasurement, len(mutation.Questions))
	for _, input := range mutation.Questions {
		if input.Measurement == nil {
			continue
		}
		question, exists := questionByID[input.QuestionID]
		if !exists {
			return nil, errors.New("la medición contiene una pregunta ajena a la plantilla")
		}
		if _, duplicate := assignments[input.QuestionID]; duplicate {
			return nil, errors.New("la medición contiene preguntas duplicadas")
		}
		measurement := *input.Measurement
		measurement.DimensionKey = strings.ToLower(strings.TrimSpace(measurement.DimensionKey))
		if _, exists := dimensionKeys[measurement.DimensionKey]; !exists {
			return nil, fmt.Errorf("la pregunta %q referencia una dimensión inexistente", question.Title)
		}
		if measurement.Weight == 0 {
			measurement.Weight = 1
		}
		if measurement.Weight <= 0 || measurement.Weight > 100 || math.IsNaN(measurement.Weight) || math.IsInf(measurement.Weight, 0) {
			return nil, fmt.Errorf("la pregunta %q tiene un peso inválido", question.Title)
		}
		switch question.Type {
		case "rating", "likert":
			measurement.OptionScores = nil
		case "single_choice":
			if len(measurement.OptionScores) != len(question.Config.Options) {
				return nil, fmt.Errorf("la pregunta %q necesita un puntaje para cada opción", question.Title)
			}
			for _, option := range question.Config.Options {
				score, exists := measurement.OptionScores[option]
				if !exists || math.IsNaN(score) || math.IsInf(score, 0) {
					return nil, fmt.Errorf("la opción %q de %q necesita un puntaje válido", option, question.Title)
				}
			}
		default:
			return nil, fmt.Errorf("la pregunta %q no admite medición en esta versión", question.Title)
		}
		assignments[input.QuestionID] = &measurement
	}
	if len(assignments) > 0 && len(dimensionKeys) == 0 {
		return nil, errors.New("agrega al menos una dimensión para configurar puntajes")
	}
	return assignments, nil
}

func (s *SurveyTemplateService) UpdateMeasurement(ctx context.Context, accountID, templateID uuid.UUID, mutation domain.SurveyMeasurementMutation) (*domain.SurveyTemplate, []*domain.SurveyTemplateQuestion, error) {
	questions, err := s.Questions(ctx, accountID, templateID)
	if err != nil {
		return nil, nil, err
	}
	assignments, err := validateMeasurementMutation(questions, &mutation)
	if err != nil {
		return nil, nil, err
	}
	config := domain.SurveyMeasurementConfig{Dimensions: mutation.Dimensions}
	if _, err := s.repos.SurveyTemplate.UpdateMeasurement(ctx, accountID, templateID, config, assignments); err != nil {
		return nil, nil, err
	}
	template, err := s.Get(ctx, accountID, templateID)
	if err != nil {
		return nil, nil, err
	}
	questions, err = s.Questions(ctx, accountID, templateID)
	return template, questions, err
}

func surveyMeasurementSignature(config domain.SurveyMeasurementConfig, questions []*domain.SurveyTemplateQuestion) (string, error) {
	if len(config.Dimensions) == 0 {
		return "", nil
	}
	type signatureQuestion struct {
		ID          uuid.UUID                         `json:"id"`
		Type        string                            `json:"type"`
		Title       string                            `json:"title"`
		Options     []string                          `json:"options,omitempty"`
		MaxRating   int                               `json:"max_rating,omitempty"`
		LikertScale int                               `json:"likert_scale,omitempty"`
		Measurement *domain.SurveyQuestionMeasurement `json:"measurement,omitempty"`
	}
	payload := struct {
		Config    domain.SurveyMeasurementConfig `json:"config"`
		Questions []signatureQuestion            `json:"questions"`
	}{Config: config, Questions: make([]signatureQuestion, 0)}
	for _, question := range questions {
		if question.Config.Measurement == nil {
			continue
		}
		payload.Questions = append(payload.Questions, signatureQuestion{
			ID: question.ID, Type: question.Type, Title: question.Title,
			Options: question.Config.Options, MaxRating: question.Config.MaxRating,
			LikertScale: question.Config.LikertScale, Measurement: question.Config.Measurement,
		})
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return fmt.Sprintf("%x", hash[:]), nil
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
	template, err := s.Get(ctx, accountID, templateID)
	if err != nil {
		return nil, 0, err
	}
	measurementMutation := domain.SurveyMeasurementMutation{Dimensions: template.MeasurementConfig.Dimensions}
	for index := range questions {
		if questions[index].Config.Measurement != nil {
			measurementMutation.Questions = append(measurementMutation.Questions, domain.SurveyMeasurementQuestionInput{
				QuestionID:  questions[index].ID,
				Measurement: questions[index].Config.Measurement,
			})
		}
	}
	assignments, err := validateMeasurementMutation(questionPointers(questions), &measurementMutation)
	if err != nil {
		return nil, 0, fmt.Errorf("actualiza la configuración de medición antes de guardar las preguntas: %w", err)
	}
	for index := range questions {
		questions[index].Config.Measurement = assignments[questions[index].ID]
	}
	return s.repos.SurveyTemplate.ReplaceQuestions(ctx, accountID, templateID, questions)
}

func questionPointers(questions []domain.SurveyTemplateQuestion) []*domain.SurveyTemplateQuestion {
	result := make([]*domain.SurveyTemplateQuestion, len(questions))
	for index := range questions {
		result[index] = &questions[index]
	}
	return result
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
	input.MeasurementConfig = template.MeasurementConfig
	input.MeasurementSignature, err = surveyMeasurementSignature(template.MeasurementConfig, snapshotQuestions)
	if err != nil {
		return nil, err
	}
	input.Name = domain.CleanSurveyInstanceName(input.Name)
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
	for attempt := 0; attempt < 8; attempt++ {
		if attempt == 0 {
			input.Slug = base
		} else {
			input.Slug = base + "-" + uuid.NewString()[:6]
		}
		instance, createErr := s.repos.SurveyTemplate.CreateInstance(ctx, input)
		if createErr == nil {
			return instance, nil
		}
		if !errors.Is(createErr, repository.ErrSurveySlugUnavailable) {
			return nil, createErr
		}
	}
	return nil, errors.New("no se pudo generar un enlace único")
}

func (s *SurveyTemplateService) ListTemplateInstances(ctx context.Context, accountID, templateID uuid.UUID, includeArchived bool) ([]*domain.SurveyInstanceSummary, error) {
	if _, err := s.repos.SurveyTemplate.Get(ctx, accountID, templateID); err != nil {
		return nil, err
	}
	return s.repos.SurveyTemplate.ListTemplateInstances(ctx, accountID, templateID, includeArchived)
}

func (s *SurveyTemplateService) ListProgramInstances(ctx context.Context, accountID, programID uuid.UUID, includeArchived bool) ([]*domain.SurveyInstanceSummary, error) {
	program, err := s.repos.Program.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return nil, repository.ErrSurveyInstanceNotFound
	}
	return s.repos.SurveyTemplate.ListProgramInstances(ctx, accountID, programID, includeArchived)
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

func (s *SurveyTemplateService) ProgramMeasurementSeries(ctx context.Context, accountID, programID, templateID uuid.UUID, signature string, baselineID, followupID *uuid.UUID) (*domain.SurveyMeasurementSeries, error) {
	program, err := s.repos.Program.GetByID(ctx, accountID, programID)
	if err != nil || program == nil {
		return nil, repository.ErrSurveyInstanceNotFound
	}
	if _, err := s.repos.SurveyTemplate.Get(ctx, accountID, templateID); err != nil {
		return nil, err
	}
	return s.repos.SurveyTemplate.GetProgramMeasurementSeries(ctx, accountID, programID, templateID, signature, baselineID, followupID)
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
