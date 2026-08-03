package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrSurveyTemplateNotFound        = errors.New("survey template not found")
	ErrSurveyInstanceNotFound        = errors.New("survey instance not found")
	ErrSurveyRecipientInvalid        = errors.New("survey recipient is invalid")
	ErrSurveyProgramUnavailable      = errors.New("survey program is unavailable")
	ErrSurveyProgramNoParticipants   = errors.New("survey program has no active participants")
	ErrSurveyTemplateEmpty           = errors.New("survey template has no active questions")
	ErrSurveyMeasurementIncompatible = errors.New("las aplicaciones seleccionadas no tienen una medición compatible")
)

type SurveyInstanceNameConflictError struct {
	SuggestedName string
}

func (e *SurveyInstanceNameConflictError) Error() string {
	return "ya existe una aplicación de esta plantilla con ese nombre"
}

type SurveyTemplateRepository struct {
	db *pgxpool.Pool
}

func NewSurveyTemplateRepository(db *pgxpool.Pool) *SurveyTemplateRepository {
	return &SurveyTemplateRepository{db: db}
}

const surveyTemplateSelect = `
	SELECT st.id,st.account_id,st.name,st.description,st.status,
		st.welcome_title,st.welcome_description,st.thank_you_title,st.thank_you_message,
		st.thank_you_redirect_url,st.branding,st.measurement_config,st.revision,st.system_key,st.legacy_survey_id,
		st.created_by,st.created_at,st.updated_at,
		(SELECT COUNT(*) FROM survey_template_questions q WHERE q.account_id=st.account_id AND q.template_id=st.id AND q.is_active),
		(SELECT COUNT(*) FROM surveys s WHERE s.account_id=st.account_id AND s.template_id=st.id AND s.archived_at IS NULL),
		(SELECT COUNT(*) FROM surveys s WHERE s.account_id=st.account_id AND s.template_id=st.id AND s.archived_at IS NOT NULL),
		(SELECT COUNT(*) FROM survey_responses sr JOIN surveys s ON s.id=sr.survey_id AND s.account_id=sr.account_id
		 WHERE s.account_id=st.account_id AND s.template_id=st.id AND sr.completed_at IS NOT NULL)
	FROM survey_templates st`

type surveyTemplateScanner interface {
	Scan(dest ...any) error
}

func scanSurveyTemplate(row surveyTemplateScanner) (*domain.SurveyTemplate, error) {
	t := &domain.SurveyTemplate{}
	var branding, measurement []byte
	if err := row.Scan(
		&t.ID, &t.AccountID, &t.Name, &t.Description, &t.Status,
		&t.WelcomeTitle, &t.WelcomeDescription, &t.ThankYouTitle, &t.ThankYouMessage,
		&t.ThankYouRedirectURL, &branding, &measurement, &t.Revision, &t.SystemKey, &t.LegacySurveyID,
		&t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.QuestionCount, &t.InstanceCount,
		&t.ArchivedInstanceCount, &t.ResponseCount,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	if err := json.Unmarshal(branding, &t.Branding); err != nil {
		return nil, fmt.Errorf("decode survey template branding: %w", err)
	}
	if err := json.Unmarshal(measurement, &t.MeasurementConfig); err != nil {
		return nil, fmt.Errorf("decode survey template measurement config: %w", err)
	}
	if t.MeasurementConfig.Dimensions == nil {
		t.MeasurementConfig.Dimensions = []domain.SurveyMeasurementDimension{}
	}
	return t, nil
}

func (r *SurveyTemplateRepository) List(ctx context.Context, accountID uuid.UUID, includeArchived bool) ([]*domain.SurveyTemplate, error) {
	query := surveyTemplateSelect + ` WHERE st.account_id=$1`
	if !includeArchived {
		query += ` AND st.status='active'`
	}
	query += ` ORDER BY st.status,st.updated_at DESC,st.id`
	rows, err := r.db.Query(ctx, query, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*domain.SurveyTemplate, 0)
	for rows.Next() {
		t, err := scanSurveyTemplate(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, t)
	}
	return result, rows.Err()
}

func (r *SurveyTemplateRepository) Get(ctx context.Context, accountID, templateID uuid.UUID) (*domain.SurveyTemplate, error) {
	return scanSurveyTemplate(r.db.QueryRow(ctx, surveyTemplateSelect+` WHERE st.account_id=$1 AND st.id=$2`, accountID, templateID))
}

type surveyInstanceNameQueryer interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func surveyInstanceNameKeys(ctx context.Context, queryer surveyInstanceNameQueryer, accountID, templateID uuid.UUID) (map[string]struct{}, error) {
	rows, err := queryer.Query(ctx, `
		SELECT name FROM surveys
		WHERE account_id=$1 AND template_id=$2
	`, accountID, templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	used := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		used[domain.SurveyInstanceNameKey(name)] = struct{}{}
	}
	return used, rows.Err()
}

func trimSurveyInstanceNameForSuffix(base, suffix string) string {
	baseRunes := []rune(domain.CleanSurveyInstanceName(base))
	available := 180 - len([]rune(suffix))
	if available < 1 {
		available = 1
	}
	if len(baseRunes) > available {
		baseRunes = baseRunes[:available]
	}
	return strings.TrimSpace(string(baseRunes)) + suffix
}

func nextSurveyInstanceName(base string, used map[string]struct{}) string {
	base = trimSurveyInstanceNameForSuffix(base, "")
	if base == "" {
		base = "Aplicación de encuesta"
	}
	if _, exists := used[domain.SurveyInstanceNameKey(base)]; !exists {
		return base
	}
	for ordinal := 2; ordinal < 10000; ordinal++ {
		suffix := fmt.Sprintf(" · %d", ordinal)
		candidate := trimSurveyInstanceNameForSuffix(base, suffix)
		if _, exists := used[domain.SurveyInstanceNameKey(candidate)]; !exists {
			return candidate
		}
	}
	return trimSurveyInstanceNameForSuffix(base, " · "+uuid.NewString()[:6])
}

func (r *SurveyTemplateRepository) SuggestInstanceName(ctx context.Context, accountID, templateID uuid.UUID, programID *uuid.UUID, requested string) (*domain.SurveyInstanceNameSuggestion, error) {
	var templateName string
	if err := r.db.QueryRow(ctx, `SELECT name FROM survey_templates WHERE account_id=$1 AND id=$2`, accountID, templateID).Scan(&templateName); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	base := templateName
	if programID != nil {
		var programName string
		if err := r.db.QueryRow(ctx, `SELECT name FROM programs WHERE account_id=$1 AND id=$2 AND type='course' AND status='active'`, accountID, *programID).Scan(&programName); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrSurveyProgramUnavailable
			}
			return nil, err
		}
		base += " · " + programName
	}
	used, err := surveyInstanceNameKeys(ctx, r.db, accountID, templateID)
	if err != nil {
		return nil, err
	}
	cleanRequested := domain.CleanSurveyInstanceName(requested)
	if cleanRequested == "" {
		return &domain.SurveyInstanceNameSuggestion{Available: true, SuggestedName: nextSurveyInstanceName(base, used)}, nil
	}
	_, exists := used[domain.SurveyInstanceNameKey(cleanRequested)]
	available := !exists && len([]rune(cleanRequested)) <= 180
	if available {
		return &domain.SurveyInstanceNameSuggestion{Available: true, SuggestedName: cleanRequested}, nil
	}
	return &domain.SurveyInstanceNameSuggestion{Available: false, SuggestedName: nextSurveyInstanceName(cleanRequested, used)}, nil
}

func (r *SurveyTemplateRepository) Create(ctx context.Context, template *domain.SurveyTemplate) error {
	branding, err := json.Marshal(template.Branding)
	if err != nil {
		return err
	}
	if template.Status == "" {
		template.Status = "active"
	}
	measurement, err := json.Marshal(template.MeasurementConfig)
	if err != nil {
		return err
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO survey_templates (
			account_id,name,description,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,measurement_config,created_by
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id,revision,created_at,updated_at
	`, template.AccountID, template.Name, template.Description, template.Status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding, measurement, template.CreatedBy,
	).Scan(&template.ID, &template.Revision, &template.CreatedAt, &template.UpdatedAt)
}

func (r *SurveyTemplateRepository) Update(ctx context.Context, template *domain.SurveyTemplate) error {
	branding, err := json.Marshal(template.Branding)
	if err != nil {
		return err
	}
	measurement, err := json.Marshal(template.MeasurementConfig)
	if err != nil {
		return err
	}
	tag, err := r.db.Exec(ctx, `
		UPDATE survey_templates SET
			name=$3,description=$4,status=$5,welcome_title=$6,welcome_description=$7,
			thank_you_title=$8,thank_you_message=$9,thank_you_redirect_url=$10,
			branding=$11,measurement_config=$12,revision=revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, template.AccountID, template.ID, template.Name, template.Description, template.Status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding, measurement)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSurveyTemplateNotFound
	}
	return nil
}

// UpdateDesign atomically persists the branding definition and its account-scoped
// media references. Removed assets remain inventoried so immutable applications
// and the storage cleanup workflow can continue to reference them safely.
func (r *SurveyTemplateRepository) UpdateDesign(ctx context.Context, accountID, templateID uuid.UUID, branding domain.SurveyBranding, logoAssetID, backgroundAssetID *uuid.UUID) (*domain.SurveyTemplate, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, templateID).Scan(&status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	if status == "archived" {
		return nil, errors.New("una plantilla archivada no se puede editar")
	}
	refs := map[string]*uuid.UUID{"logo": logoAssetID, "background": backgroundAssetID}
	for slot, assetID := range refs {
		if assetID == nil {
			continue
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM media_assets WHERE account_id=$1 AND id=$2 AND status='active' AND deleted_at IS NULL)`, accountID, *assetID).Scan(&exists); err != nil {
			return nil, err
		}
		if !exists {
			return nil, fmt.Errorf("el recurso de %s no pertenece a la cuenta", slot)
		}
	}
	encoded, err := json.Marshal(branding)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE survey_templates SET branding=$3,revision=revision+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, templateID, encoded); err != nil {
		return nil, err
	}
	for slot, assetID := range refs {
		if assetID == nil {
			if _, err := tx.Exec(ctx, `DELETE FROM survey_branding_asset_refs WHERE account_id=$1 AND template_id=$2 AND slot=$3`, accountID, templateID, slot); err != nil {
				return nil, err
			}
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_branding_asset_refs (account_id,template_id,slot,media_asset_id)
			VALUES ($1,$2,$3,$4)
			ON CONFLICT (account_id,template_id,slot) WHERE template_id IS NOT NULL
			DO UPDATE SET media_asset_id=EXCLUDED.media_asset_id,updated_at=NOW()
		`, accountID, templateID, slot, *assetID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE storage_objects so SET status='active',next_delete_at=NULL,delete_error='',deleted_at=NULL,updated_at=NOW()
		FROM media_assets ma
		WHERE ma.account_id=$1 AND ma.id=ANY($2::uuid[]) AND so.account_id=ma.account_id AND so.object_key=ma.object_key
	`, accountID, nonNilUUIDs(logoAssetID, backgroundAssetID)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.Get(ctx, accountID, templateID)
}

func nonNilUUIDs(values ...*uuid.UUID) []uuid.UUID {
	result := make([]uuid.UUID, 0, len(values))
	for _, value := range values {
		if value != nil {
			result = append(result, *value)
		}
	}
	return result
}

// Duplicate creates an independent, editable template definition. Applications,
// public slugs, recipients and responses intentionally remain attached only to
// the source template.
func (r *SurveyTemplateRepository) Duplicate(ctx context.Context, accountID, sourceID uuid.UUID, name string, createdBy *uuid.UUID) (*domain.SurveyTemplate, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	copyTemplate := &domain.SurveyTemplate{AccountID: accountID, Name: name, Status: "active", CreatedBy: createdBy}
	var branding, measurement []byte
	if err := tx.QueryRow(ctx, `
		SELECT description,welcome_title,welcome_description,thank_you_title,
			thank_you_message,thank_you_redirect_url,branding,measurement_config
		FROM survey_templates
		WHERE account_id=$1 AND id=$2
		FOR SHARE
	`, accountID, sourceID).Scan(
		&copyTemplate.Description, &copyTemplate.WelcomeTitle, &copyTemplate.WelcomeDescription,
		&copyTemplate.ThankYouTitle, &copyTemplate.ThankYouMessage,
		&copyTemplate.ThankYouRedirectURL, &branding, &measurement,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	if err := json.Unmarshal(branding, &copyTemplate.Branding); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(measurement, &copyTemplate.MeasurementConfig); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO survey_templates (
			account_id,name,description,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,
			measurement_config,revision,system_key,legacy_survey_id,created_by
		) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,1,NULL,NULL,$11)
		RETURNING id,revision,created_at,updated_at
	`, accountID, copyTemplate.Name, copyTemplate.Description, copyTemplate.WelcomeTitle,
		copyTemplate.WelcomeDescription, copyTemplate.ThankYouTitle, copyTemplate.ThankYouMessage,
		copyTemplate.ThankYouRedirectURL, branding, measurement, createdBy,
	).Scan(&copyTemplate.ID, &copyTemplate.Revision, &copyTemplate.CreatedAt, &copyTemplate.UpdatedAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO survey_branding_asset_refs (account_id,template_id,slot,media_asset_id)
		SELECT account_id,$3,slot,media_asset_id
		FROM survey_branding_asset_refs
		WHERE account_id=$1 AND template_id=$2
		ON CONFLICT (account_id,template_id,slot) WHERE template_id IS NOT NULL
		DO UPDATE SET media_asset_id=EXCLUDED.media_asset_id,updated_at=NOW()
	`, accountID, sourceID, copyTemplate.ID); err != nil {
		return nil, err
	}

	type questionCopy struct {
		sourceID                  uuid.UUID
		targetID                  uuid.UUID
		order                     int
		qtype, title, description string
		required                  bool
		config, rules             []byte
	}
	rows, err := tx.Query(ctx, `
		SELECT id,order_index,type,title,description,required,config,logic_rules
		FROM survey_template_questions
		WHERE account_id=$1 AND template_id=$2 AND is_active
		ORDER BY order_index,id
	`, accountID, sourceID)
	if err != nil {
		return nil, err
	}
	questions := make([]questionCopy, 0)
	idMap := make(map[uuid.UUID]uuid.UUID)
	for rows.Next() {
		question := questionCopy{targetID: uuid.New()}
		if err := rows.Scan(&question.sourceID, &question.order, &question.qtype, &question.title,
			&question.description, &question.required, &question.config, &question.rules); err != nil {
			rows.Close()
			return nil, err
		}
		idMap[question.sourceID] = question.targetID
		questions = append(questions, question)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	for _, question := range questions {
		var rules []domain.SurveyLogicRule
		if err := json.Unmarshal(question.rules, &rules); err != nil {
			return nil, err
		}
		for index := range rules {
			target, exists := idMap[rules[index].JumpTo]
			if !exists {
				return nil, errors.New("survey template logic points outside the copied definition")
			}
			rules[index].JumpTo = target
		}
		rulesJSON, err := json.Marshal(rules)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_template_questions (
				id,account_id,template_id,order_index,type,title,description,required,
				config,logic_rules,is_active
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
		`, question.targetID, accountID, copyTemplate.ID, question.order, question.qtype,
			question.title, question.description, question.required, question.config, rulesJSON); err != nil {
			return nil, err
		}
	}
	copyTemplate.QuestionCount = len(questions)
	copyTemplate.MeasurementConfig.Dimensions = append([]domain.SurveyMeasurementDimension(nil), copyTemplate.MeasurementConfig.Dimensions...)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return copyTemplate, nil
}

// UpdateMeasurement applies the complete measurement draft in one revision and
// clears stale assignments omitted by the client.
func (r *SurveyTemplateRepository) UpdateMeasurement(ctx context.Context, accountID, templateID uuid.UUID, config domain.SurveyMeasurementConfig, assignments map[uuid.UUID]*domain.SurveyQuestionMeasurement) (int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var revision int
	if err := tx.QueryRow(ctx, `SELECT revision FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, templateID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrSurveyTemplateNotFound
		}
		return 0, err
	}
	rows, err := tx.Query(ctx, `
		SELECT id,config FROM survey_template_questions
		WHERE account_id=$1 AND template_id=$2 AND is_active
		ORDER BY order_index,id
	`, accountID, templateID)
	if err != nil {
		return 0, err
	}
	found := make(map[uuid.UUID]struct{})
	type pendingConfig struct {
		id    uuid.UUID
		value []byte
	}
	pending := make([]pendingConfig, 0)
	for rows.Next() {
		var questionID uuid.UUID
		var raw []byte
		if err := rows.Scan(&questionID, &raw); err != nil {
			rows.Close()
			return 0, err
		}
		var questionConfig domain.SurveyQuestionConfig
		if err := json.Unmarshal(raw, &questionConfig); err != nil {
			rows.Close()
			return 0, err
		}
		questionConfig.Measurement = assignments[questionID]
		encoded, err := json.Marshal(questionConfig)
		if err != nil {
			rows.Close()
			return 0, err
		}
		pending = append(pending, pendingConfig{id: questionID, value: encoded})
		found[questionID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for questionID := range assignments {
		if _, exists := found[questionID]; !exists {
			return 0, errors.New("measurement references a question outside the template")
		}
	}
	for _, update := range pending {
		if _, err := tx.Exec(ctx, `
			UPDATE survey_template_questions SET config=$4,updated_at=NOW()
			WHERE account_id=$1 AND template_id=$2 AND id=$3 AND is_active
		`, accountID, templateID, update.id, update.value); err != nil {
			return 0, err
		}
	}
	encodedConfig, err := json.Marshal(config)
	if err != nil {
		return 0, err
	}
	revision++
	if _, err := tx.Exec(ctx, `
		UPDATE survey_templates
		SET measurement_config=$3,revision=$4,updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, templateID, encodedConfig, revision); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return revision, nil
}

func (r *SurveyTemplateRepository) ListQuestions(ctx context.Context, accountID, templateID uuid.UUID) ([]*domain.SurveyTemplateQuestion, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id,account_id,template_id,order_index,type,title,description,required,
			config,logic_rules,is_active,created_at,updated_at
		FROM survey_template_questions
		WHERE account_id=$1 AND template_id=$2 AND is_active
		ORDER BY order_index,id
	`, accountID, templateID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*domain.SurveyTemplateQuestion, 0)
	for rows.Next() {
		q := &domain.SurveyTemplateQuestion{}
		var config, rules []byte
		if err := rows.Scan(&q.ID, &q.AccountID, &q.TemplateID, &q.OrderIndex, &q.Type,
			&q.Title, &q.Description, &q.Required, &config, &rules, &q.IsActive,
			&q.CreatedAt, &q.UpdatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(config, &q.Config); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(rules, &q.LogicRules); err != nil {
			return nil, err
		}
		if q.LogicRules == nil {
			q.LogicRules = []domain.SurveyLogicRule{}
		}
		result = append(result, q)
	}
	return result, rows.Err()
}

// ReplaceQuestions keeps logical question IDs stable, archives removed rows and
// increments the template revision. Published survey_questions are untouched.
func (r *SurveyTemplateRepository) ReplaceQuestions(ctx context.Context, accountID, templateID uuid.UUID, questions []domain.SurveyTemplateQuestion) ([]*domain.SurveyTemplateQuestion, int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, 0, err
	}
	defer tx.Rollback(ctx)
	var revision int
	if err := tx.QueryRow(ctx, `SELECT revision FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, templateID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, 0, ErrSurveyTemplateNotFound
		}
		return nil, 0, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE survey_template_questions
		SET is_active=FALSE,order_index=order_index+1000000,updated_at=NOW()
		WHERE account_id=$1 AND template_id=$2 AND is_active
	`, accountID, templateID); err != nil {
		return nil, 0, err
	}
	ids := make(map[uuid.UUID]struct{}, len(questions))
	for i := range questions {
		if questions[i].ID == uuid.Nil {
			questions[i].ID = uuid.New()
		}
		if _, duplicate := ids[questions[i].ID]; duplicate {
			return nil, 0, errors.New("duplicate survey template question id")
		}
		ids[questions[i].ID] = struct{}{}
	}
	for _, q := range questions {
		for _, rule := range q.LogicRules {
			if rule.JumpTo != uuid.Nil {
				if _, ok := ids[rule.JumpTo]; !ok {
					return nil, 0, errors.New("survey logic points to a question outside the template")
				}
			}
		}
	}
	for i := range questions {
		q := &questions[i]
		q.AccountID, q.TemplateID, q.OrderIndex, q.IsActive = accountID, templateID, i, true
		config, err := json.Marshal(q.Config)
		if err != nil {
			return nil, 0, err
		}
		rules, err := json.Marshal(q.LogicRules)
		if err != nil {
			return nil, 0, err
		}
		if string(rules) == "null" {
			rules = []byte("[]")
		}
		var configOut, rulesOut []byte
		err = tx.QueryRow(ctx, `
			INSERT INTO survey_template_questions (
				id,account_id,template_id,order_index,type,title,description,required,config,logic_rules,is_active
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
			ON CONFLICT (id) DO UPDATE SET
				order_index=EXCLUDED.order_index,type=EXCLUDED.type,title=EXCLUDED.title,
				description=EXCLUDED.description,required=EXCLUDED.required,config=EXCLUDED.config,
				logic_rules=EXCLUDED.logic_rules,is_active=TRUE,updated_at=NOW()
			WHERE survey_template_questions.account_id=EXCLUDED.account_id
			  AND survey_template_questions.template_id=EXCLUDED.template_id
			RETURNING id,account_id,template_id,order_index,type,title,description,required,
				config,logic_rules,is_active,created_at,updated_at
		`, q.ID, accountID, templateID, i, q.Type, q.Title, q.Description, q.Required, config, rules).Scan(
			&q.ID, &q.AccountID, &q.TemplateID, &q.OrderIndex, &q.Type, &q.Title,
			&q.Description, &q.Required, &configOut, &rulesOut, &q.IsActive, &q.CreatedAt, &q.UpdatedAt,
		)
		if err != nil {
			return nil, 0, err
		}
		_ = json.Unmarshal(configOut, &q.Config)
		_ = json.Unmarshal(rulesOut, &q.LogicRules)
	}
	revision++
	if _, err := tx.Exec(ctx, `UPDATE survey_templates SET revision=$3,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, templateID, revision); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	result := make([]*domain.SurveyTemplateQuestion, len(questions))
	for i := range questions {
		result[i] = &questions[i]
	}
	return result, revision, nil
}

func (r *SurveyTemplateRepository) CreateInstance(ctx context.Context, input domain.CreateSurveyInstanceInput) (*domain.SurveyInstanceSummary, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	template := &domain.SurveyTemplate{}
	var branding []byte
	err = tx.QueryRow(ctx, `
		SELECT id,account_id,name,description,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,revision
		FROM survey_templates WHERE account_id=$1 AND id=$2 FOR UPDATE
	`, input.AccountID, input.TemplateID).Scan(
		&template.ID, &template.AccountID, &template.Name, &template.Description, &template.Status,
		&template.WelcomeTitle, &template.WelcomeDescription, &template.ThankYouTitle,
		&template.ThankYouMessage, &template.ThankYouRedirectURL, &branding, &template.Revision,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	if template.Status != "active" {
		return nil, errors.New("archived survey templates cannot be applied")
	}
	originType, originLabel := "standalone", "Aplicación independiente"
	if input.ProgramID != nil {
		originType = "program"
		if err := tx.QueryRow(ctx, `
			SELECT name FROM programs
			WHERE account_id=$1 AND id=$2 AND type='course' AND status='active'
			FOR SHARE
		`, input.AccountID, *input.ProgramID).Scan(&originLabel); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, ErrSurveyProgramUnavailable
			}
			return nil, err
		}
		var hasActiveParticipants bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS(
				SELECT 1
				FROM program_participants pp
				JOIN programs p ON p.id=pp.program_id AND p.account_id=$1
				JOIN contacts c ON c.id=pp.contact_id AND c.account_id=p.account_id
				WHERE pp.program_id=$2 AND pp.status='active'
			)
		`, input.AccountID, *input.ProgramID).Scan(&hasActiveParticipants); err != nil {
			return nil, err
		}
		if !hasActiveParticipants {
			return nil, ErrSurveyProgramNoParticipants
		}
	}
	name := domain.CleanSurveyInstanceName(input.Name)
	if name == "" {
		name = template.Name
		if input.ProgramID != nil {
			name += " · " + originLabel
		}
	}
	if len([]rune(name)) > 180 {
		return nil, errors.New("el nombre de la aplicación es demasiado largo")
	}
	usedNames, err := surveyInstanceNameKeys(ctx, tx, input.AccountID, input.TemplateID)
	if err != nil {
		return nil, err
	}
	if _, duplicate := usedNames[domain.SurveyInstanceNameKey(name)]; duplicate {
		return nil, &SurveyInstanceNameConflictError{SuggestedName: nextSurveyInstanceName(name, usedNames)}
	}
	status := input.Status
	if status == "" {
		status = "active"
	}
	audienceMode := input.AudienceMode
	if audienceMode == "" {
		if input.ProgramID != nil {
			audienceMode = "program_participants"
		} else {
			audienceMode = "public"
		}
	}
	instance := &domain.SurveyInstanceSummary{}
	measurement, err := json.Marshal(input.MeasurementConfig)
	if err != nil {
		return nil, err
	}
	instanceID := uuid.New()
	if _, err := tx.Exec(ctx, `
		INSERT INTO survey_public_slug_reservations
			(slug,owner_account_id,survey_id,reserved_at)
		VALUES ($1,$2,$3,NOW())
	`, input.Slug, input.AccountID, instanceID); err != nil {
		if isUniqueViolation(err) {
			return nil, ErrSurveySlugUnavailable
		}
		return nil, err
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO surveys (
			id,account_id,name,description,slug,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,
			measurement_config,measurement_signature,created_by,
			is_template,template_id,template_revision,origin_type,program_id,origin_label,
			audience_mode,opens_at,closes_at,legacy_instance
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,FALSE,$16,$17,$18,$19,$20,$21,$22,$23,FALSE)
		RETURNING id,account_id,template_id,template_revision,program_id,origin_type,origin_label,
			name,slug,status,audience_mode,opens_at,closes_at,legacy_instance,
			measurement_signature,analytics_tracking_started_at,created_at,updated_at
	`, instanceID, input.AccountID, name, template.Description, input.Slug, status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding, measurement,
		input.MeasurementSignature, input.CreatedBy,
		template.ID, template.Revision, originType, input.ProgramID, originLabel,
		audienceMode, input.OpensAt, input.ClosesAt,
	).Scan(&instance.ID, &instance.AccountID, &instance.TemplateID, &instance.TemplateRevision,
		&instance.ProgramID, &instance.OriginType, &instance.OriginLabel, &instance.Name,
		&instance.Slug, &instance.Status, &instance.AudienceMode, &instance.OpensAt,
		&instance.ClosesAt, &instance.LegacyInstance, &instance.MeasurementSignature,
		&instance.AnalyticsTrackingStartedAt, &instance.CreatedAt, &instance.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO survey_branding_asset_refs (account_id,survey_id,slot,media_asset_id)
		SELECT account_id,$3,slot,media_asset_id
		FROM survey_branding_asset_refs
		WHERE account_id=$1 AND template_id=$2
		ON CONFLICT (account_id,survey_id,slot) WHERE survey_id IS NOT NULL
		DO UPDATE SET media_asset_id=EXCLUDED.media_asset_id,updated_at=NOW()
	`, input.AccountID, template.ID, instance.ID); err != nil {
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id,order_index,type,title,description,required,config,logic_rules
		FROM survey_template_questions
		WHERE account_id=$1 AND template_id=$2 AND is_active ORDER BY order_index,id
	`, input.AccountID, template.ID)
	if err != nil {
		return nil, err
	}
	type questionCopy struct {
		sourceID, instanceID uuid.UUID
		order                int
		qtype, title, desc   string
		required             bool
		config, rules        []byte
	}
	questions := make([]questionCopy, 0)
	idMap := make(map[uuid.UUID]uuid.UUID)
	for rows.Next() {
		q := questionCopy{instanceID: uuid.New()}
		if err := rows.Scan(&q.sourceID, &q.order, &q.qtype, &q.title, &q.desc, &q.required, &q.config, &q.rules); err != nil {
			rows.Close()
			return nil, err
		}
		idMap[q.sourceID] = q.instanceID
		questions = append(questions, q)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(questions) == 0 {
		return nil, ErrSurveyTemplateEmpty
	}
	for _, q := range questions {
		var rules []domain.SurveyLogicRule
		if err := json.Unmarshal(q.rules, &rules); err != nil {
			return nil, err
		}
		for i := range rules {
			if mapped, ok := idMap[rules[i].JumpTo]; ok {
				rules[i].JumpTo = mapped
			}
		}
		rulesJSON, err := json.Marshal(rules)
		if err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_questions (
				id,survey_id,order_index,type,title,description,required,config,logic_rules,
				source_template_question_id,template_revision
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		`, q.instanceID, instance.ID, q.order, q.qtype, q.title, q.desc, q.required,
			q.config, rulesJSON, q.sourceID, template.Revision); err != nil {
			return nil, err
		}
	}
	instance.QuestionCount = len(questions)
	if input.ProgramID != nil && audienceMode == "program_participants" {
		tag, err := tx.Exec(ctx, `
			INSERT INTO survey_instance_recipients (
				account_id,survey_id,program_id,program_participant_id,contact_id,status
			)
			SELECT p.account_id,$2,pp.program_id,pp.id,pp.contact_id,'pending'
			FROM programs p
			JOIN program_participants pp ON pp.program_id=p.id
			JOIN contacts c ON c.account_id=p.account_id AND c.id=pp.contact_id
			WHERE p.account_id=$1 AND p.id=$3
			  AND pp.status IN ('active','enrolled') AND pp.dropped_at IS NULL
			ON CONFLICT (account_id,survey_id,program_participant_id) WHERE program_participant_id IS NOT NULL DO NOTHING
		`, input.AccountID, instance.ID, *input.ProgramID)
		if err != nil {
			return nil, err
		}
		instance.RecipientCount = int(tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	instance.CanDelete = true
	instance.CanArchive = true
	return instance, nil
}

var surveyInstanceSummarySelect = fmt.Sprintf(`
	SELECT s.id,s.account_id,s.template_id,s.template_revision,s.program_id,s.origin_type,
		s.origin_label,s.name,s.slug,s.status,s.audience_mode,s.opens_at,s.closes_at,
		s.legacy_instance,s.archived_at,s.archived_by,COALESCE(s.archived_from_status,''),
		s.measurement_signature,s.analytics_tracking_started_at,
		(SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id),
		(SELECT COUNT(*) FROM survey_instance_recipients r
		 WHERE r.account_id=s.account_id AND r.survey_id=s.id AND r.merged_into_recipient_id IS NULL),
		(SELECT COUNT(*) FROM survey_responses sr WHERE sr.account_id=s.account_id AND sr.survey_id=s.id AND sr.completed_at IS NOT NULL),
		%s AS deletion_block_reason,
		s.created_at,s.updated_at
	FROM surveys s`, surveyDeletionBlockSQL)

func scanSurveyInstance(row surveyTemplateScanner) (*domain.SurveyInstanceSummary, error) {
	i := &domain.SurveyInstanceSummary{}
	if err := row.Scan(&i.ID, &i.AccountID, &i.TemplateID, &i.TemplateRevision, &i.ProgramID,
		&i.OriginType, &i.OriginLabel, &i.Name, &i.Slug, &i.Status, &i.AudienceMode,
		&i.OpensAt, &i.ClosesAt, &i.LegacyInstance, &i.ArchivedAt, &i.ArchivedBy, &i.ArchivedFromStatus,
		&i.MeasurementSignature,
		&i.AnalyticsTrackingStartedAt, &i.QuestionCount, &i.RecipientCount,
		&i.ResponseCount, &i.DeletionBlockReason, &i.CreatedAt, &i.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyInstanceNotFound
		}
		return nil, err
	}
	i.CanDelete = i.DeletionBlockReason == ""
	i.CanArchive = i.ArchivedAt == nil
	i.CanRestore = i.ArchivedAt != nil
	return i, nil
}

func (r *SurveyTemplateRepository) ListTemplateInstances(ctx context.Context, accountID, templateID uuid.UUID, includeArchived bool) ([]*domain.SurveyInstanceSummary, error) {
	query := surveyInstanceSummarySelect + ` WHERE s.account_id=$1 AND s.template_id=$2`
	if !includeArchived {
		query += ` AND s.archived_at IS NULL`
	}
	return r.listInstances(ctx, query+` ORDER BY s.created_at DESC,s.id`, accountID, templateID)
}

func (r *SurveyTemplateRepository) ListProgramInstances(ctx context.Context, accountID, programID uuid.UUID, includeArchived bool) ([]*domain.SurveyInstanceSummary, error) {
	query := surveyInstanceSummarySelect + ` WHERE s.account_id=$1 AND s.program_id=$2`
	if !includeArchived {
		query += ` AND s.archived_at IS NULL`
	}
	return r.listInstances(ctx, query+` ORDER BY s.created_at DESC,s.id`, accountID, programID)
}

func (r *SurveyTemplateRepository) GetInstance(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyInstanceSummary, error) {
	return scanSurveyInstance(r.db.QueryRow(ctx, surveyInstanceSummarySelect+` WHERE s.account_id=$1 AND s.id=$2`, accountID, surveyID))
}

func (r *SurveyTemplateRepository) listInstances(ctx context.Context, query string, args ...any) ([]*domain.SurveyInstanceSummary, error) {
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]*domain.SurveyInstanceSummary, 0)
	for rows.Next() {
		i, err := scanSurveyInstance(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, i)
	}
	return result, rows.Err()
}

func (r *SurveyTemplateRepository) GetRecipientByToken(ctx context.Context, surveyID, token uuid.UUID) (*domain.SurveyInstanceRecipient, error) {
	recipient := &domain.SurveyInstanceRecipient{}
	err := r.db.QueryRow(ctx, `
		WITH RECURSIVE recipient_chain AS (
			SELECT recipient.id,recipient.account_id,recipient.survey_id,recipient.program_id,
				recipient.program_participant_id,recipient.contact_id,recipient.access_token,
				recipient.status,recipient.opened_at,recipient.completed_at,
				recipient.merged_into_recipient_id,ARRAY[recipient.id]::uuid[] AS path
			FROM survey_instance_recipients recipient
			WHERE recipient.survey_id=$1 AND recipient.access_token=$2
			UNION ALL
			SELECT target.id,target.account_id,target.survey_id,target.program_id,
				target.program_participant_id,target.contact_id,target.access_token,
				target.status,target.opened_at,target.completed_at,
				target.merged_into_recipient_id,chain.path||target.id
			FROM recipient_chain chain
			JOIN survey_instance_recipients target
			  ON target.account_id=chain.account_id
			 AND target.survey_id=chain.survey_id
			 AND target.id=chain.merged_into_recipient_id
			WHERE NOT target.id=ANY(chain.path) AND CARDINALITY(chain.path)<32
		)
		SELECT id,account_id,survey_id,program_id,program_participant_id,contact_id,
			access_token,status,opened_at,completed_at
		FROM recipient_chain
		WHERE merged_into_recipient_id IS NULL
		ORDER BY CARDINALITY(path) DESC
		LIMIT 1
	`, surveyID, token).Scan(&recipient.ID, &recipient.AccountID, &recipient.SurveyID,
		&recipient.ProgramID, &recipient.ProgramParticipantID, &recipient.ContactID,
		&recipient.AccessToken, &recipient.Status, &recipient.OpenedAt, &recipient.CompletedAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyRecipientInvalid
		}
		return nil, err
	}
	return recipient, nil
}

func (r *SurveyTemplateRepository) MarkRecipientOpened(ctx context.Context, recipientID, accountID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var surveyID uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT survey_id FROM survey_instance_recipients
		WHERE account_id=$1 AND id=$2
	`, accountID, recipientID).Scan(&surveyID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrSurveyRecipientInvalid
		}
		return err
	}
	// The same survey-row lock is used by response/session creation and
	// conflicts with archive/delete. Therefore an opening can never be recorded
	// after archive/delete has won the race, and a successful opening becomes
	// visible to the deletion-history check before deletion can continue.
	if err := lockSurveyForResponse(ctx, tx, accountID, surveyID); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `
		UPDATE survey_instance_recipients SET status=CASE WHEN status='pending' THEN 'opened' ELSE status END,
			opened_at=COALESCE(opened_at,NOW()),updated_at=NOW()
		WHERE account_id=$1 AND survey_id=$2 AND id=$3
	`, accountID, surveyID, recipientID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrSurveyRecipientInvalid
	}
	return tx.Commit(ctx)
}

func (r *SurveyTemplateRepository) ListProgramRecipients(ctx context.Context, accountID, programID, surveyID uuid.UUID, search string, limit, offset int) ([]*domain.SurveyInstanceRecipient, int, error) {
	search = strings.TrimSpace(search)
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var total int
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM survey_instance_recipients recipient
		JOIN surveys s ON s.account_id=recipient.account_id AND s.id=recipient.survey_id
		JOIN programs p ON p.account_id=recipient.account_id AND p.id=recipient.program_id
		LEFT JOIN contacts c ON c.account_id=recipient.account_id AND c.id=recipient.contact_id
		WHERE recipient.account_id=$1 AND recipient.program_id=$2 AND recipient.survey_id=$3
		  AND s.program_id=p.id
		  AND ($4='' OR CONCAT_WS(' ',c.custom_name,c.name,c.last_name,c.phone,c.email) ILIKE '%'||$4||'%'
			OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND cp.phone ILIKE '%'||$4||'%'))
	`, accountID, programID, surveyID, search).Scan(&total)
	if err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT recipient.id,recipient.account_id,recipient.survey_id,recipient.program_id,
			recipient.program_participant_id,recipient.contact_id,
			COALESCE(NULLIF(BTRIM(c.custom_name),''),NULLIF(BTRIM(c.name),''),NULLIF(BTRIM(c.phone),''),'Contacto'),
			recipient.access_token,recipient.status,recipient.opened_at,recipient.completed_at
		FROM survey_instance_recipients recipient
		JOIN surveys s ON s.account_id=recipient.account_id AND s.id=recipient.survey_id
		JOIN programs p ON p.account_id=recipient.account_id AND p.id=recipient.program_id
		LEFT JOIN contacts c ON c.account_id=recipient.account_id AND c.id=recipient.contact_id
		WHERE recipient.account_id=$1 AND recipient.program_id=$2 AND recipient.survey_id=$3
		  AND s.program_id=p.id
		  AND ($4='' OR CONCAT_WS(' ',c.custom_name,c.name,c.last_name,c.phone,c.email) ILIKE '%'||$4||'%'
			OR EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id=c.id AND cp.phone ILIKE '%'||$4||'%'))
		ORDER BY recipient.status,LOWER(COALESCE(c.custom_name,c.name,c.phone,'')),recipient.id
		LIMIT $5 OFFSET $6
	`, accountID, programID, surveyID, search, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	result := make([]*domain.SurveyInstanceRecipient, 0)
	for rows.Next() {
		recipient := &domain.SurveyInstanceRecipient{}
		if err := rows.Scan(&recipient.ID, &recipient.AccountID, &recipient.SurveyID,
			&recipient.ProgramID, &recipient.ProgramParticipantID, &recipient.ContactID,
			&recipient.ContactName, &recipient.AccessToken, &recipient.Status,
			&recipient.OpenedAt, &recipient.CompletedAt); err != nil {
			return nil, 0, err
		}
		result = append(result, recipient)
	}
	return result, total, rows.Err()
}

func (r *SurveyTemplateRepository) GetProgramMeasurementSeries(ctx context.Context, accountID, programID, templateID uuid.UUID, requestedSignature string, baselineID, followupID *uuid.UUID) (*domain.SurveyMeasurementSeries, error) {
	type application struct {
		id              uuid.UUID
		name, signature string
		createdAt       time.Time
		config          domain.SurveyMeasurementConfig
	}
	rows, err := r.db.Query(ctx, `
		SELECT id,name,measurement_signature,measurement_config,created_at
		FROM surveys
		WHERE account_id=$1 AND program_id=$2 AND template_id=$3
		  AND measurement_signature<>''
		ORDER BY created_at,id
	`, accountID, programID, templateID)
	if err != nil {
		return nil, err
	}
	all := make([]application, 0)
	for rows.Next() {
		var item application
		var raw []byte
		if err := rows.Scan(&item.id, &item.name, &item.signature, &raw, &item.createdAt); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal(raw, &item.config); err != nil {
			rows.Close()
			return nil, err
		}
		all = append(all, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if requestedSignature == "" && len(all) > 0 {
		requestedSignature = all[len(all)-1].signature
	}
	selected := make([]application, 0)
	for _, item := range all {
		if item.signature == requestedSignature {
			selected = append(selected, item)
		}
	}
	series := &domain.SurveyMeasurementSeries{
		TemplateID: templateID, ProgramID: programID, Signature: requestedSignature,
		ExcludedApplications: len(all) - len(selected), Applications: []domain.SurveyMeasurementApplicationPoint{},
		Participants: []domain.SurveyParticipantMeasurementPoint{}, PairedChanges: []domain.SurveyPairedMeasurementChange{},
	}
	if len(selected) == 0 {
		return series, nil
	}
	surveyIDs := make([]uuid.UUID, len(selected))
	for index := range selected {
		surveyIDs[index] = selected[index].id
	}
	questionRows, err := r.db.Query(ctx, `
		SELECT question.id,question.survey_id,question.order_index,question.type,
			question.title,question.description,question.required,question.config,
			question.logic_rules,question.created_at,question.updated_at
		FROM survey_questions question
		JOIN surveys survey ON survey.id=question.survey_id
		WHERE survey.account_id=$1 AND question.survey_id=ANY($2::uuid[])
		ORDER BY question.survey_id,question.order_index,question.id
	`, accountID, surveyIDs)
	if err != nil {
		return nil, err
	}
	questionsBySurvey := make(map[uuid.UUID][]*domain.SurveyQuestion)
	for questionRows.Next() {
		question := &domain.SurveyQuestion{}
		var configJSON, rulesJSON []byte
		if err := questionRows.Scan(&question.ID, &question.SurveyID, &question.OrderIndex,
			&question.Type, &question.Title, &question.Description, &question.Required,
			&configJSON, &rulesJSON, &question.CreatedAt, &question.UpdatedAt); err != nil {
			questionRows.Close()
			return nil, err
		}
		if err := json.Unmarshal(configJSON, &question.Config); err != nil {
			questionRows.Close()
			return nil, err
		}
		if err := json.Unmarshal(rulesJSON, &question.LogicRules); err != nil {
			questionRows.Close()
			return nil, err
		}
		questionsBySurvey[question.SurveyID] = append(questionsBySurvey[question.SurveyID], question)
	}
	if err := questionRows.Err(); err != nil {
		questionRows.Close()
		return nil, err
	}
	questionRows.Close()
	answerRepository := &SurveyRepository{db: r.db}
	allAnswers, err := answerRepository.measurementAnswers(ctx, accountID, surveyIDs)
	if err != nil {
		return nil, err
	}
	scoresBySurvey := make(map[uuid.UUID]map[uuid.UUID]map[string]float64)
	answerSetBySurvey := make(map[uuid.UUID]map[uuid.UUID]surveyMeasurementAnswerSet)
	for responseID, answerSet := range allAnswers {
		if answerSetBySurvey[answerSet.SurveyID] == nil {
			answerSetBySurvey[answerSet.SurveyID] = make(map[uuid.UUID]surveyMeasurementAnswerSet)
		}
		answerSetBySurvey[answerSet.SurveyID][responseID] = answerSet
	}
	for _, item := range selected {
		scores, stats := calculateMeasurementScores(item.config, questionsBySurvey[item.id], answerSetBySurvey[item.id])
		scoresBySurvey[item.id] = scores
		series.Applications = append(series.Applications, domain.SurveyMeasurementApplicationPoint{
			SurveyID: item.id, Name: item.name, CreatedAt: item.createdAt,
			ResponseCount: len(answerSetBySurvey[item.id]), Dimensions: stats,
		})
		for responseID, responseScores := range scores {
			answerSet := answerSetBySurvey[item.id][responseID]
			if answerSet.ProgramParticipantID == nil {
				continue
			}
			series.Participants = append(series.Participants, domain.SurveyParticipantMeasurementPoint{
				ProgramParticipantID: *answerSet.ProgramParticipantID, ContactName: answerSet.ContactName,
				SurveyID: item.id, SurveyName: item.name, CreatedAt: item.createdAt, Scores: responseScores,
			})
		}
	}
	sort.Slice(series.Participants, func(i, j int) bool {
		if series.Participants[i].ContactName == series.Participants[j].ContactName {
			return series.Participants[i].CreatedAt.Before(series.Participants[j].CreatedAt)
		}
		return series.Participants[i].ContactName < series.Participants[j].ContactName
	})
	baseline, followup := selected[0].id, selected[len(selected)-1].id
	if baselineID != nil {
		baseline = *baselineID
	}
	if followupID != nil {
		followup = *followupID
	}
	validSurvey := func(id uuid.UUID) bool {
		for _, item := range selected {
			if item.id == id {
				return true
			}
		}
		return false
	}
	if !validSurvey(baseline) || !validSurvey(followup) {
		return nil, ErrSurveyMeasurementIncompatible
	}
	if baseline == followup {
		return series, nil
	}
	type paired struct{ baseline, followup *float64 }
	pairedByDimension := make(map[string]map[uuid.UUID]*paired)
	for _, point := range series.Participants {
		if point.SurveyID != baseline && point.SurveyID != followup {
			continue
		}
		for key, score := range point.Scores {
			if pairedByDimension[key] == nil {
				pairedByDimension[key] = make(map[uuid.UUID]*paired)
			}
			if pairedByDimension[key][point.ProgramParticipantID] == nil {
				pairedByDimension[key][point.ProgramParticipantID] = &paired{}
			}
			value := score
			if point.SurveyID == baseline {
				pairedByDimension[key][point.ProgramParticipantID].baseline = &value
			}
			if point.SurveyID == followup {
				pairedByDimension[key][point.ProgramParticipantID].followup = &value
			}
		}
	}
	for _, dimension := range selected[0].config.Dimensions {
		var baselineSum, followupSum float64
		count := 0
		for _, pair := range pairedByDimension[dimension.Key] {
			if pair.baseline == nil || pair.followup == nil {
				continue
			}
			baselineSum += *pair.baseline
			followupSum += *pair.followup
			count++
		}
		change := domain.SurveyPairedMeasurementChange{DimensionKey: dimension.Key, SampleSize: count}
		if count > 0 {
			baselineAverage, followupAverage := baselineSum/float64(count), followupSum/float64(count)
			delta := followupAverage - baselineAverage
			change.Baseline, change.Followup, change.Delta = &baselineAverage, &followupAverage, &delta
		}
		series.PairedChanges = append(series.PairedChanges, change)
	}
	return series, nil
}
