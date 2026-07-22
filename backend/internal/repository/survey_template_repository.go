package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrSurveyTemplateNotFound      = errors.New("survey template not found")
	ErrSurveyInstanceNotFound      = errors.New("survey instance not found")
	ErrSurveyRecipientInvalid      = errors.New("survey recipient is invalid")
	ErrSurveyProgramUnavailable    = errors.New("survey program is unavailable")
	ErrSurveyProgramNoParticipants = errors.New("survey program has no active participants")
	ErrSurveyTemplateEmpty         = errors.New("survey template has no active questions")
)

type SurveyTemplateRepository struct {
	db *pgxpool.Pool
}

func NewSurveyTemplateRepository(db *pgxpool.Pool) *SurveyTemplateRepository {
	return &SurveyTemplateRepository{db: db}
}

const surveyTemplateSelect = `
	SELECT st.id,st.account_id,st.name,st.description,st.status,
		st.welcome_title,st.welcome_description,st.thank_you_title,st.thank_you_message,
		st.thank_you_redirect_url,st.branding,st.revision,st.system_key,st.legacy_survey_id,
		st.created_by,st.created_at,st.updated_at,
		(SELECT COUNT(*) FROM survey_template_questions q WHERE q.account_id=st.account_id AND q.template_id=st.id AND q.is_active),
		(SELECT COUNT(*) FROM surveys s WHERE s.account_id=st.account_id AND s.template_id=st.id),
		(SELECT COUNT(*) FROM survey_responses sr JOIN surveys s ON s.id=sr.survey_id AND s.account_id=sr.account_id
		 WHERE s.account_id=st.account_id AND s.template_id=st.id AND sr.completed_at IS NOT NULL)
	FROM survey_templates st`

type surveyTemplateScanner interface {
	Scan(dest ...any) error
}

func scanSurveyTemplate(row surveyTemplateScanner) (*domain.SurveyTemplate, error) {
	t := &domain.SurveyTemplate{}
	var branding []byte
	if err := row.Scan(
		&t.ID, &t.AccountID, &t.Name, &t.Description, &t.Status,
		&t.WelcomeTitle, &t.WelcomeDescription, &t.ThankYouTitle, &t.ThankYouMessage,
		&t.ThankYouRedirectURL, &branding, &t.Revision, &t.SystemKey, &t.LegacySurveyID,
		&t.CreatedBy, &t.CreatedAt, &t.UpdatedAt, &t.QuestionCount, &t.InstanceCount, &t.ResponseCount,
	); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyTemplateNotFound
		}
		return nil, err
	}
	if err := json.Unmarshal(branding, &t.Branding); err != nil {
		return nil, fmt.Errorf("decode survey template branding: %w", err)
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

func (r *SurveyTemplateRepository) Create(ctx context.Context, template *domain.SurveyTemplate) error {
	branding, err := json.Marshal(template.Branding)
	if err != nil {
		return err
	}
	if template.Status == "" {
		template.Status = "active"
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO survey_templates (
			account_id,name,description,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,created_by
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id,revision,created_at,updated_at
	`, template.AccountID, template.Name, template.Description, template.Status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding, template.CreatedBy,
	).Scan(&template.ID, &template.Revision, &template.CreatedAt, &template.UpdatedAt)
}

func (r *SurveyTemplateRepository) Update(ctx context.Context, template *domain.SurveyTemplate) error {
	branding, err := json.Marshal(template.Branding)
	if err != nil {
		return err
	}
	tag, err := r.db.Exec(ctx, `
		UPDATE survey_templates SET
			name=$3,description=$4,status=$5,welcome_title=$6,welcome_description=$7,
			thank_you_title=$8,thank_you_message=$9,thank_you_redirect_url=$10,
			branding=$11,revision=revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, template.AccountID, template.ID, template.Name, template.Description, template.Status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSurveyTemplateNotFound
	}
	return nil
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
		FROM survey_templates WHERE account_id=$1 AND id=$2 FOR SHARE
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
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = template.Name
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
	err = tx.QueryRow(ctx, `
		INSERT INTO surveys (
			account_id,name,description,slug,status,welcome_title,welcome_description,
			thank_you_title,thank_you_message,thank_you_redirect_url,branding,created_by,
			is_template,template_id,template_revision,origin_type,program_id,origin_label,
			audience_mode,opens_at,closes_at,legacy_instance
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,$13,$14,$15,$16,$17,$18,$19,$20,FALSE)
		RETURNING id,account_id,template_id,template_revision,program_id,origin_type,origin_label,
			name,slug,status,audience_mode,opens_at,closes_at,legacy_instance,created_at,updated_at
	`, input.AccountID, name, template.Description, input.Slug, status,
		template.WelcomeTitle, template.WelcomeDescription, template.ThankYouTitle,
		template.ThankYouMessage, template.ThankYouRedirectURL, branding, input.CreatedBy,
		template.ID, template.Revision, originType, input.ProgramID, originLabel,
		audienceMode, input.OpensAt, input.ClosesAt,
	).Scan(&instance.ID, &instance.AccountID, &instance.TemplateID, &instance.TemplateRevision,
		&instance.ProgramID, &instance.OriginType, &instance.OriginLabel, &instance.Name,
		&instance.Slug, &instance.Status, &instance.AudienceMode, &instance.OpensAt,
		&instance.ClosesAt, &instance.LegacyInstance, &instance.CreatedAt, &instance.UpdatedAt)
	if err != nil {
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
	return instance, nil
}

const surveyInstanceSummarySelect = `
	SELECT s.id,s.account_id,s.template_id,s.template_revision,s.program_id,s.origin_type,
		s.origin_label,s.name,s.slug,s.status,s.audience_mode,s.opens_at,s.closes_at,
		s.legacy_instance,
		(SELECT COUNT(*) FROM survey_questions q WHERE q.survey_id=s.id),
		(SELECT COUNT(*) FROM survey_instance_recipients r
		 WHERE r.account_id=s.account_id AND r.survey_id=s.id AND r.merged_into_recipient_id IS NULL),
		(SELECT COUNT(*) FROM survey_responses sr WHERE sr.account_id=s.account_id AND sr.survey_id=s.id AND sr.completed_at IS NOT NULL),
		s.created_at,s.updated_at
	FROM surveys s`

func scanSurveyInstance(row surveyTemplateScanner) (*domain.SurveyInstanceSummary, error) {
	i := &domain.SurveyInstanceSummary{}
	if err := row.Scan(&i.ID, &i.AccountID, &i.TemplateID, &i.TemplateRevision, &i.ProgramID,
		&i.OriginType, &i.OriginLabel, &i.Name, &i.Slug, &i.Status, &i.AudienceMode,
		&i.OpensAt, &i.ClosesAt, &i.LegacyInstance, &i.QuestionCount, &i.RecipientCount,
		&i.ResponseCount, &i.CreatedAt, &i.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSurveyInstanceNotFound
		}
		return nil, err
	}
	return i, nil
}

func (r *SurveyTemplateRepository) ListTemplateInstances(ctx context.Context, accountID, templateID uuid.UUID) ([]*domain.SurveyInstanceSummary, error) {
	return r.listInstances(ctx, surveyInstanceSummarySelect+` WHERE s.account_id=$1 AND s.template_id=$2 ORDER BY s.created_at DESC,s.id`, accountID, templateID)
}

func (r *SurveyTemplateRepository) ListProgramInstances(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.SurveyInstanceSummary, error) {
	return r.listInstances(ctx, surveyInstanceSummarySelect+` WHERE s.account_id=$1 AND s.program_id=$2 ORDER BY s.created_at DESC,s.id`, accountID, programID)
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
	_, err := r.db.Exec(ctx, `
		UPDATE survey_instance_recipients SET status=CASE WHEN status='pending' THEN 'opened' ELSE status END,
			opened_at=COALESCE(opened_at,NOW()),updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, recipientID)
	return err
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
