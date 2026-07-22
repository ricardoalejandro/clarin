package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrRawSurveyMutationDisabled = errors.New("las encuestas se crean desde plantillas; crea una plantilla o una aplicación desde una plantilla existente")
	ErrSurveyPublishedImmutable  = errors.New("una aplicación de encuesta es inmutable; edita la plantilla y crea una nueva aplicación")
	ErrSurveyCannotReturnToDraft = errors.New("una aplicación publicada no puede volver a borrador")
)

type SurveyRepository struct {
	db *pgxpool.Pool
}

// ─── Survey CRUD ──────────────────────────────────────────────────────────────

func (r *SurveyRepository) Create(ctx context.Context, s *domain.Survey) error {
	return ErrRawSurveyMutationDisabled
}

func (r *SurveyRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Survey, error) {
	s := &domain.Survey{}
	var brandingJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT s.id, s.account_id, s.name, s.description, s.slug, s.status,
			s.welcome_title, s.welcome_description, s.thank_you_title, s.thank_you_message,
			s.thank_you_redirect_url, s.branding, s.is_template, s.template_id, s.template_revision,
			s.origin_type, s.program_id, s.origin_label, s.audience_mode, s.opens_at, s.closes_at,
			s.legacy_instance, s.created_by, s.created_at, s.updated_at,
			(SELECT COUNT(*) FROM survey_questions WHERE survey_id = s.id) AS question_count,
			(SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id AND completed_at IS NOT NULL) AS response_count
		FROM surveys s
		WHERE s.id = $1 AND s.account_id = $2
	`, id, accountID).Scan(
		&s.ID, &s.AccountID, &s.Name, &s.Description, &s.Slug, &s.Status,
		&s.WelcomeTitle, &s.WelcomeDescription, &s.ThankYouTitle, &s.ThankYouMessage,
		&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.TemplateID, &s.TemplateRevision,
		&s.OriginType, &s.ProgramID, &s.OriginLabel, &s.AudienceMode, &s.OpensAt, &s.ClosesAt,
		&s.LegacyInstance, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
		&s.QuestionCount, &s.ResponseCount,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(brandingJSON, &s.Branding)
	return s, nil
}

func (r *SurveyRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.Survey, error) {
	rows, err := r.db.Query(ctx, `
		SELECT s.id, s.account_id, s.name, s.description, s.slug, s.status,
			s.welcome_title, s.welcome_description, s.thank_you_title, s.thank_you_message,
			s.thank_you_redirect_url, s.branding, s.is_template, s.template_id, s.template_revision,
			s.origin_type, s.program_id, s.origin_label, s.audience_mode, s.opens_at, s.closes_at,
			s.legacy_instance, s.created_by, s.created_at, s.updated_at,
			(SELECT COUNT(*) FROM survey_questions WHERE survey_id = s.id) AS question_count,
			(SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id AND completed_at IS NOT NULL) AS response_count
		FROM surveys s
		WHERE s.account_id = $1
		ORDER BY s.is_template DESC, s.created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var surveys []*domain.Survey
	for rows.Next() {
		s := &domain.Survey{}
		var brandingJSON []byte
		if err := rows.Scan(
			&s.ID, &s.AccountID, &s.Name, &s.Description, &s.Slug, &s.Status,
			&s.WelcomeTitle, &s.WelcomeDescription, &s.ThankYouTitle, &s.ThankYouMessage,
			&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.TemplateID, &s.TemplateRevision,
			&s.OriginType, &s.ProgramID, &s.OriginLabel, &s.AudienceMode, &s.OpensAt, &s.ClosesAt,
			&s.LegacyInstance, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
			&s.QuestionCount, &s.ResponseCount,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(brandingJSON, &s.Branding)
		surveys = append(surveys, s)
	}
	return surveys, nil
}

func (r *SurveyRepository) Update(ctx context.Context, s *domain.Survey) error {
	brandingJSON, _ := json.Marshal(s.Branding)
	tag, err := r.db.Exec(ctx, `
		UPDATE surveys SET name=$1, description=$2, slug=$3, status=$4,
			welcome_title=$5, welcome_description=$6, thank_you_title=$7, thank_you_message=$8,
			thank_you_redirect_url=$9, branding=$10, updated_at=NOW()
		WHERE id=$11 AND account_id=$12
		  AND NOT (status IN ('active','closed') AND $4::text='draft')
		  AND (
			(status='draft' AND (legacy_instance OR template_id IS NULL)) OR (
				name=$1 AND description=$2 AND slug=$3 AND
				welcome_title=$5 AND welcome_description=$6 AND thank_you_title=$7 AND
				thank_you_message=$8 AND thank_you_redirect_url=$9 AND branding=$10::jsonb
			)
		  )
	`, s.Name, s.Description, s.Slug, s.Status,
		s.WelcomeTitle, s.WelcomeDescription, s.ThankYouTitle, s.ThankYouMessage,
		s.ThankYouRedirectURL, brandingJSON, s.ID, s.AccountID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSurveyPublishedImmutable
	}
	return nil
}

func (r *SurveyRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM surveys WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *SurveyRepository) HasDistribution(ctx context.Context, accountID, surveyID uuid.UUID) (bool, error) {
	var distributed bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM survey_responses WHERE account_id=$1 AND survey_id=$2
			UNION ALL
			SELECT 1 FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2
			UNION ALL
			SELECT 1 FROM survey_file_uploads WHERE account_id=$1 AND survey_id=$2
		)
	`, accountID, surveyID).Scan(&distributed)
	return distributed, err
}

func (r *SurveyRepository) SetStatus(ctx context.Context, id, accountID uuid.UUID, status string) error {
	tag, err := r.db.Exec(ctx, `
		UPDATE surveys SET status=$1, updated_at=NOW()
		WHERE id=$2 AND account_id=$3
		  AND NOT (status IN ('active','closed') AND $1::text='draft')
	`, status, id, accountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrSurveyCannotReturnToDraft
	}
	return nil
}

func (r *SurveyRepository) SlugExists(ctx context.Context, slug string, excludeID *uuid.UUID) (bool, error) {
	var exists bool
	if excludeID != nil {
		err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM surveys WHERE slug=$1 AND id!=$2)`, slug, *excludeID).Scan(&exists)
		return exists, err
	}
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM surveys WHERE slug=$1)`, slug).Scan(&exists)
	return exists, err
}

func (r *SurveyRepository) GetBySlug(ctx context.Context, slug string) (*domain.Survey, error) {
	s := &domain.Survey{}
	var brandingJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, slug, status,
			welcome_title, welcome_description, thank_you_title, thank_you_message,
			thank_you_redirect_url, branding, is_template, template_id, template_revision,
			origin_type, program_id, origin_label, audience_mode, opens_at, closes_at,
			legacy_instance, created_by, created_at, updated_at
		FROM surveys WHERE slug = $1
	`, slug).Scan(
		&s.ID, &s.AccountID, &s.Name, &s.Description, &s.Slug, &s.Status,
		&s.WelcomeTitle, &s.WelcomeDescription, &s.ThankYouTitle, &s.ThankYouMessage,
		&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.TemplateID, &s.TemplateRevision,
		&s.OriginType, &s.ProgramID, &s.OriginLabel, &s.AudienceMode, &s.OpensAt, &s.ClosesAt,
		&s.LegacyInstance, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(brandingJSON, &s.Branding)
	return s, nil
}

func (r *SurveyRepository) Duplicate(ctx context.Context, srcID, accountID uuid.UUID, newName, newSlug string) (*domain.Survey, error) {
	return nil, ErrRawSurveyMutationDisabled
}

// ─── Questions ────────────────────────────────────────────────────────────────

func (r *SurveyRepository) GetQuestions(ctx context.Context, surveyID uuid.UUID) ([]*domain.SurveyQuestion, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, survey_id, order_index, type, title, description, required, config, logic_rules, created_at, updated_at
		FROM survey_questions WHERE survey_id = $1 ORDER BY order_index
	`, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var questions []*domain.SurveyQuestion
	for rows.Next() {
		q := &domain.SurveyQuestion{}
		var configJSON, logicJSON []byte
		if err := rows.Scan(&q.ID, &q.SurveyID, &q.OrderIndex, &q.Type, &q.Title, &q.Description,
			&q.Required, &configJSON, &logicJSON, &q.CreatedAt, &q.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(configJSON, &q.Config)
		_ = json.Unmarshal(logicJSON, &q.LogicRules)
		if q.LogicRules == nil {
			q.LogicRules = []domain.SurveyLogicRule{}
		}
		questions = append(questions, q)
	}
	return questions, nil
}

// GetQuestionsScoped is the account-isolated variant used by protected
// analytics and exports. Keeping the account predicate in the data-bearing
// query prevents a caller from relying only on a prior UUID ownership check.
func (r *SurveyRepository) GetQuestionsScoped(ctx context.Context, accountID, surveyID uuid.UUID) ([]*domain.SurveyQuestion, error) {
	rows, err := r.db.Query(ctx, `
		SELECT q.id, q.survey_id, q.order_index, q.type, q.title, q.description,
			q.required, q.config, q.logic_rules, q.created_at, q.updated_at
		FROM survey_questions q
		JOIN surveys s ON s.id = q.survey_id
		WHERE s.account_id = $1 AND q.survey_id = $2
		ORDER BY q.order_index,q.id
	`, accountID, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	questions := make([]*domain.SurveyQuestion, 0)
	for rows.Next() {
		q := &domain.SurveyQuestion{}
		var configJSON, logicJSON []byte
		if err := rows.Scan(&q.ID, &q.SurveyID, &q.OrderIndex, &q.Type, &q.Title, &q.Description,
			&q.Required, &configJSON, &logicJSON, &q.CreatedAt, &q.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(configJSON, &q.Config)
		_ = json.Unmarshal(logicJSON, &q.LogicRules)
		if q.LogicRules == nil {
			q.LogicRules = []domain.SurveyLogicRule{}
		}
		questions = append(questions, q)
	}
	return questions, rows.Err()
}

// BulkUpsertQuestions replaces all questions for a survey with the given set.
// Uses DELETE + INSERT in a transaction for simplicity and correctness.
func (r *SurveyRepository) BulkUpsertQuestions(ctx context.Context, accountID, surveyID uuid.UUID, questions []domain.SurveyQuestion) ([]*domain.SurveyQuestion, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var status string
	var legacy bool
	var templateID *uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT status,legacy_instance,template_id FROM surveys
		WHERE account_id=$1 AND id=$2
		FOR UPDATE
	`, accountID, surveyID).Scan(&status, &legacy, &templateID); err != nil {
		return nil, err
	}
	var hasResponses bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM survey_responses WHERE account_id=$1 AND survey_id=$2)`, accountID, surveyID).Scan(&hasResponses); err != nil {
		return nil, err
	}
	if hasResponses || status != "draft" || (!legacy && templateID != nil) {
		return nil, ErrSurveyPublishedImmutable
	}

	// Delete existing questions (CASCADE deletes answers too)
	_, err = tx.Exec(ctx, `DELETE FROM survey_questions WHERE survey_id = $1`, surveyID)
	if err != nil {
		return nil, err
	}

	result := make([]*domain.SurveyQuestion, 0, len(questions))
	for i, q := range questions {
		if q.ID == uuid.Nil {
			q.ID = uuid.New()
		}
		configJSON, _ := json.Marshal(q.Config)
		logicJSON, _ := json.Marshal(q.LogicRules)
		if logicJSON == nil || string(logicJSON) == "null" {
			logicJSON = []byte("[]")
		}

		saved := &domain.SurveyQuestion{}
		var cfgOut, logicOut []byte
		err := tx.QueryRow(ctx, `
			INSERT INTO survey_questions (id, survey_id, order_index, type, title, description, required, config, logic_rules)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
			RETURNING id, survey_id, order_index, type, title, description, required, config, logic_rules, created_at, updated_at
		`, q.ID, surveyID, i, q.Type, q.Title, q.Description, q.Required, configJSON, logicJSON,
		).Scan(&saved.ID, &saved.SurveyID, &saved.OrderIndex, &saved.Type, &saved.Title,
			&saved.Description, &saved.Required, &cfgOut, &logicOut, &saved.CreatedAt, &saved.UpdatedAt)
		if err != nil {
			return nil, err
		}
		_ = json.Unmarshal(cfgOut, &saved.Config)
		_ = json.Unmarshal(logicOut, &saved.LogicRules)
		if saved.LogicRules == nil {
			saved.LogicRules = []domain.SurveyLogicRule{}
		}
		result = append(result, saved)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// ─── Responses ────────────────────────────────────────────────────────────────

func (r *SurveyRepository) CreateResponse(ctx context.Context, resp *domain.SurveyResponse, answers []domain.SurveyAnswer) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	err = tx.QueryRow(ctx, `
		INSERT INTO survey_responses (
			survey_id, account_id, respondent_token, lead_id, recipient_id, contact_id,
			program_id, program_participant_id, source, ip_address, user_agent, started_at, completed_at
		)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
		RETURNING id, created_at
	`, resp.SurveyID, resp.AccountID, resp.RespondentToken, resp.LeadID, resp.RecipientID,
		resp.ContactID, resp.ProgramID, resp.ProgramParticipantID, resp.Source,
		resp.IPAddress, resp.UserAgent, resp.StartedAt, resp.CompletedAt,
	).Scan(&resp.ID, &resp.CreatedAt)
	if err != nil {
		return err
	}

	for i := range answers {
		answers[i].ResponseID = resp.ID
		if answers[i].UploadID != nil {
			accessToken, objectKey, mediaAssetID, err := scanSurveyUploadForAttachment(
				ctx, tx, resp.AccountID, resp.SurveyID, answers[i].QuestionID,
				*answers[i].UploadID, resp.RespondentToken, resp.RecipientID,
			)
			if err != nil {
				return err
			}
			answers[i].FileURL = "/api/public/survey-files/" + accessToken.String()
			if _, err := tx.Exec(ctx, `
				UPDATE survey_file_uploads SET status='attached',response_id=$3,updated_at=NOW()
				WHERE account_id=$1 AND id=$2 AND status='staged'
			`, resp.AccountID, *answers[i].UploadID, resp.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE storage_objects SET status='active',next_delete_at=NULL,delete_error='',updated_at=NOW()
				WHERE account_id=$1 AND object_key=$2 AND source='survey_upload'
			`, resp.AccountID, objectKey); err != nil {
				return err
			}
			if _, err := tx.Exec(ctx, `
				UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
				WHERE account_id=$1 AND id=$2
			`, resp.AccountID, mediaAssetID); err != nil {
				return err
			}
		}
		err = tx.QueryRow(ctx, `
			INSERT INTO survey_answers (response_id, survey_id, question_id, value, file_url, survey_upload_id)
			VALUES ($1,$2,$3,$4,$5,$6)
			RETURNING id, created_at
		`, answers[i].ResponseID, resp.SurveyID, answers[i].QuestionID, answers[i].Value,
			answers[i].FileURL, answers[i].UploadID,
		).Scan(&answers[i].ID, &answers[i].CreatedAt)
		if err != nil {
			return err
		}
	}
	resp.Answers = answers
	if resp.RecipientID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE survey_instance_recipients
			SET status='completed', completed_at=COALESCE(completed_at,NOW()), updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND survey_id=$3
		`, resp.AccountID, *resp.RecipientID, resp.SurveyID); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *SurveyRepository) ListResponses(ctx context.Context, accountID, surveyID uuid.UUID, limit, offset int) ([]*domain.SurveyResponse, int, error) {
	var total int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_responses WHERE account_id=$1 AND survey_id=$2 AND completed_at IS NOT NULL`, accountID, surveyID).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := r.db.Query(ctx, `
		SELECT response.id,response.survey_id,response.account_id,response.respondent_token,
			CASE WHEN participant.id IS NOT NULL THEN response.lead_id END,
			CASE WHEN participant.id IS NOT NULL THEN response.recipient_id END,
			CASE WHEN participant.id IS NOT NULL THEN participant.contact_id END,
			CASE WHEN participant.id IS NOT NULL THEN survey.program_id END,
			CASE WHEN participant.id IS NOT NULL THEN participant.id END,
			CASE WHEN participant.id IS NOT NULL THEN
				COALESCE(NULLIF(BTRIM(contact.custom_name),''),
					NULLIF(BTRIM(CONCAT_WS(' ',contact.name,contact.last_name)),''),
					NULLIF(BTRIM(contact.push_name),''),NULLIF(BTRIM(contact.phone),''),'Contacto')
			ELSE '' END,
			CASE WHEN participant.id IS NOT NULL THEN COALESCE(contact.phone,'') ELSE '' END,
			response.source,response.started_at,response.completed_at,response.created_at
		FROM survey_responses response
		JOIN surveys survey ON survey.id=response.survey_id AND survey.account_id=response.account_id
		LEFT JOIN program_participants participant
		  ON survey.audience_mode='program_participants'
		 AND participant.id=response.program_participant_id
		 AND participant.program_id=survey.program_id
		 AND participant.contact_id=response.contact_id
		LEFT JOIN contacts contact
		  ON contact.account_id=survey.account_id AND contact.id=participant.contact_id
		WHERE response.account_id=$1 AND response.survey_id=$2 AND response.completed_at IS NOT NULL
		ORDER BY response.created_at DESC,response.id DESC LIMIT $3 OFFSET $4
	`, accountID, surveyID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var responses []*domain.SurveyResponse
	for rows.Next() {
		r := &domain.SurveyResponse{}
		if err := rows.Scan(&r.ID, &r.SurveyID, &r.AccountID, &r.RespondentToken, &r.LeadID,
			&r.RecipientID, &r.ContactID, &r.ProgramID, &r.ProgramParticipantID,
			&r.ContactName, &r.ContactPhone, &r.Source, &r.StartedAt, &r.CompletedAt,
			&r.CreatedAt); err != nil {
			return nil, 0, err
		}
		responses = append(responses, r)
	}
	return responses, total, rows.Err()
}

func (r *SurveyRepository) GetResponse(ctx context.Context, responseID uuid.UUID) (*domain.SurveyResponse, error) {
	resp := &domain.SurveyResponse{}
	err := r.db.QueryRow(ctx, `
		SELECT id, survey_id, account_id, respondent_token, lead_id, source, started_at, completed_at, created_at
		FROM survey_responses WHERE id=$1
	`, responseID).Scan(&resp.ID, &resp.SurveyID, &resp.AccountID, &resp.RespondentToken,
		&resp.LeadID, &resp.Source, &resp.StartedAt, &resp.CompletedAt, &resp.CreatedAt)
	if err != nil {
		return nil, err
	}

	// Load answers
	ansRows, err := r.db.Query(ctx, `
		SELECT id, response_id, question_id, value, file_url, survey_upload_id, created_at
		FROM survey_answers WHERE response_id=$1 ORDER BY created_at
	`, responseID)
	if err != nil {
		return nil, err
	}
	defer ansRows.Close()
	for ansRows.Next() {
		a := domain.SurveyAnswer{}
		if err := ansRows.Scan(&a.ID, &a.ResponseID, &a.QuestionID, &a.Value, &a.FileURL, &a.UploadID, &a.CreatedAt); err != nil {
			return nil, err
		}
		resp.Answers = append(resp.Answers, a)
	}
	return resp, nil
}

func (r *SurveyRepository) GetResponseScoped(ctx context.Context, accountID, surveyID, responseID uuid.UUID) (*domain.SurveyResponse, error) {
	resp := &domain.SurveyResponse{}
	err := r.db.QueryRow(ctx, `
		SELECT response.id,response.survey_id,response.account_id,response.respondent_token,
			CASE WHEN participant.id IS NOT NULL THEN response.lead_id END,
			CASE WHEN participant.id IS NOT NULL THEN response.recipient_id END,
			CASE WHEN participant.id IS NOT NULL THEN participant.contact_id END,
			CASE WHEN participant.id IS NOT NULL THEN survey.program_id END,
			CASE WHEN participant.id IS NOT NULL THEN participant.id END,
			CASE WHEN participant.id IS NOT NULL THEN
				COALESCE(NULLIF(BTRIM(contact.custom_name),''),
					NULLIF(BTRIM(CONCAT_WS(' ',contact.name,contact.last_name)),''),
					NULLIF(BTRIM(contact.push_name),''),NULLIF(BTRIM(contact.phone),''),'Contacto')
			ELSE '' END,
			CASE WHEN participant.id IS NOT NULL THEN COALESCE(contact.phone,'') ELSE '' END,
			response.source,response.started_at,response.completed_at,response.created_at
		FROM survey_responses response
		JOIN surveys survey ON survey.id=response.survey_id AND survey.account_id=response.account_id
		LEFT JOIN program_participants participant
		  ON survey.audience_mode='program_participants'
		 AND participant.id=response.program_participant_id
		 AND participant.program_id=survey.program_id
		 AND participant.contact_id=response.contact_id
		LEFT JOIN contacts contact
		  ON contact.account_id=survey.account_id AND contact.id=participant.contact_id
		WHERE response.account_id=$1 AND response.survey_id=$2 AND response.id=$3
	`, accountID, surveyID, responseID).Scan(&resp.ID, &resp.SurveyID, &resp.AccountID,
		&resp.RespondentToken, &resp.LeadID, &resp.RecipientID, &resp.ContactID,
		&resp.ProgramID, &resp.ProgramParticipantID, &resp.ContactName, &resp.ContactPhone,
		&resp.Source, &resp.StartedAt, &resp.CompletedAt, &resp.CreatedAt)
	if err != nil {
		return nil, err
	}
	ansRows, err := r.db.Query(ctx, `
		SELECT answer.id,answer.response_id,answer.question_id,answer.value,
			answer.file_url,answer.survey_upload_id,answer.created_at
		FROM survey_answers answer
		JOIN survey_responses response
		  ON response.survey_id=answer.survey_id AND response.id=answer.response_id
		WHERE response.account_id=$1 AND response.survey_id=$2 AND response.id=$3
		ORDER BY answer.created_at,answer.id
	`, accountID, surveyID, responseID)
	if err != nil {
		return nil, err
	}
	defer ansRows.Close()
	resp.Answers = []domain.SurveyAnswer{}
	for ansRows.Next() {
		a := domain.SurveyAnswer{}
		if err := ansRows.Scan(&a.ID, &a.ResponseID, &a.QuestionID, &a.Value, &a.FileURL, &a.UploadID, &a.CreatedAt); err != nil {
			return nil, err
		}
		resp.Answers = append(resp.Answers, a)
	}
	return resp, ansRows.Err()
}

func (r *SurveyRepository) DeleteResponse(ctx context.Context, responseID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM survey_responses WHERE id=$1`, responseID)
	return err
}

func (r *SurveyRepository) DeleteResponseScoped(ctx context.Context, accountID, surveyID, responseID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var recipientID *uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT recipient_id
		FROM survey_responses
		WHERE account_id=$1 AND survey_id=$2 AND id=$3
		FOR UPDATE
	`, accountID, surveyID, responseID).Scan(&recipientID)
	if err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM survey_responses WHERE account_id=$1 AND survey_id=$2 AND id=$3`, accountID, surveyID, responseID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if recipientID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE survey_instance_recipients
			SET status=CASE WHEN opened_at IS NULL THEN 'pending' ELSE 'opened' END,
			    completed_at=NULL,updated_at=NOW()
			WHERE account_id=$1 AND survey_id=$2 AND id=$3
		`, accountID, surveyID, *recipientID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ─── Analytics ────────────────────────────────────────────────────────────────

func (r *SurveyRepository) GetAnalytics(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyAnalytics, error) {
	analytics := &domain.SurveyAnalytics{}
	var exists bool
	if err := r.db.QueryRow(ctx, `
		SELECT EXISTS(SELECT 1 FROM surveys WHERE account_id=$1 AND id=$2)
	`, accountID, surveyID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, pgx.ErrNoRows
	}

	// Total responses + avg completion time
	err := r.db.QueryRow(ctx, `
		SELECT
			COUNT(*) AS total,
			COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 0) AS avg_seconds
		FROM survey_responses
		WHERE account_id = $1 AND survey_id = $2 AND completed_at IS NOT NULL
	`, accountID, surveyID).Scan(&analytics.TotalResponses, &analytics.AvgCompletionSec)
	if err != nil {
		return nil, err
	}

	// Completion rate (completed / total started)
	var totalStarted int
	_ = r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM survey_responses WHERE account_id=$1 AND survey_id=$2
	`, accountID, surveyID).Scan(&totalStarted)
	if totalStarted > 0 {
		analytics.CompletionRate = float64(analytics.TotalResponses) / float64(totalStarted) * 100
	}

	// Per-question stats
	questions, err := r.GetQuestionsScoped(ctx, accountID, surveyID)
	if err != nil {
		return nil, err
	}

	for _, q := range questions {
		stat := domain.SurveyQuestionStats{
			QuestionID:   q.ID,
			QuestionType: q.Type,
			Title:        q.Title,
		}

		// Count total answers for this question
		_ = r.db.QueryRow(ctx, `
			SELECT COUNT(*) FROM survey_answers sa
			JOIN survey_responses sr ON sr.id = sa.response_id
			WHERE sa.question_id = $1 AND sr.account_id = $2 AND sr.survey_id = $3
				AND sr.completed_at IS NOT NULL
		`, q.ID, accountID, surveyID).Scan(&stat.TotalAnswers)

		switch q.Type {
		case "single_choice", "multiple_choice":
			stat.OptionCounts = make(map[string]int)
			rows, err := r.db.Query(ctx, `
				SELECT sa.value, COUNT(*) FROM survey_answers sa
				JOIN survey_responses sr ON sr.id = sa.response_id
				WHERE sa.question_id = $1 AND sr.account_id = $2 AND sr.survey_id = $3
					AND sr.completed_at IS NOT NULL AND sa.value != ''
				GROUP BY sa.value
			`, q.ID, accountID, surveyID)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var val string
					var cnt int
					if rows.Scan(&val, &cnt) == nil {
						// For multiple_choice, value is JSON array like ["A","B"]
						if q.Type == "multiple_choice" {
							var opts []string
							if json.Unmarshal([]byte(val), &opts) == nil {
								for _, o := range opts {
									stat.OptionCounts[o] += cnt
								}
							} else {
								stat.OptionCounts[val] += cnt
							}
						} else {
							stat.OptionCounts[val] = cnt
						}
					}
				}
			}

		case "rating", "likert":
			var avg float64
			err := r.db.QueryRow(ctx, `
				SELECT COALESCE(AVG(sa.value::numeric), 0) FROM survey_answers sa
				JOIN survey_responses sr ON sr.id = sa.response_id
				WHERE sa.question_id = $1 AND sr.account_id = $2 AND sr.survey_id = $3
					AND sr.completed_at IS NOT NULL AND sa.value ~ '^\d+(\.\d+)?$'
			`, q.ID, accountID, surveyID).Scan(&avg)
			if err == nil {
				stat.Average = &avg
			}
			// Distribution
			stat.Distribution = make(map[string]int)
			rows, err := r.db.Query(ctx, `
				SELECT sa.value, COUNT(*) FROM survey_answers sa
				JOIN survey_responses sr ON sr.id = sa.response_id
				WHERE sa.question_id = $1 AND sr.account_id = $2 AND sr.survey_id = $3
					AND sr.completed_at IS NOT NULL AND sa.value != ''
				GROUP BY sa.value ORDER BY sa.value
			`, q.ID, accountID, surveyID)
			if err == nil {
				defer rows.Close()
				for rows.Next() {
					var val string
					var cnt int
					if rows.Scan(&val, &cnt) == nil {
						stat.Distribution[val] = cnt
					}
				}
			}
		}

		analytics.QuestionStats = append(analytics.QuestionStats, stat)
	}

	if analytics.QuestionStats == nil {
		analytics.QuestionStats = []domain.SurveyQuestionStats{}
	}

	return analytics, nil
}

type surveyExportRecord struct {
	ResponseID           uuid.UUID
	ContactID            *uuid.UUID
	ProgramParticipantID *uuid.UUID
	ContactName          string
	ContactPhone         string
	Token                string
	Source               string
	StartedAt            time.Time
	CompletedAt          *time.Time
	QuestionID           *uuid.UUID
	Value                *string
	FileURL              *string
}

func surveyExportHeader(question *domain.SurveyQuestion) string {
	title := strings.TrimSpace(question.Title)
	if title == "" {
		title = "Sin título"
	}
	return fmt.Sprintf("P%03d [%s] %s", question.OrderIndex+1, question.ID.String(), title)
}

func buildSurveyExportData(programAudience bool, questions []*domain.SurveyQuestion, records []surveyExportRecord) *domain.SurveyExportData {
	headers := []string{"response_id"}
	if programAudience {
		headers = append(headers, "contact_id", "program_participant_id", "nombre", "telefono")
	}
	headers = append(headers, "token", "source", "started_at", "completed_at")

	questionColumns := make(map[uuid.UUID]int, len(questions))
	for _, question := range questions {
		questionColumns[question.ID] = len(headers)
		headers = append(headers, surveyExportHeader(question))
	}

	data := &domain.SurveyExportData{Headers: headers, Rows: make([][]string, 0)}
	responseRows := make(map[uuid.UUID]int)
	for _, record := range records {
		rowIndex, exists := responseRows[record.ResponseID]
		if !exists {
			row := make([]string, len(headers))
			column := 0
			row[column] = record.ResponseID.String()
			column++
			if programAudience {
				if record.ContactID != nil {
					row[column] = record.ContactID.String()
				}
				column++
				if record.ProgramParticipantID != nil {
					row[column] = record.ProgramParticipantID.String()
				}
				column++
				row[column] = record.ContactName
				column++
				row[column] = record.ContactPhone
				column++
			}
			row[column] = record.Token
			column++
			row[column] = record.Source
			column++
			row[column] = record.StartedAt.UTC().Format(time.RFC3339)
			column++
			if record.CompletedAt != nil {
				row[column] = record.CompletedAt.UTC().Format(time.RFC3339)
			}
			data.Rows = append(data.Rows, row)
			rowIndex = len(data.Rows) - 1
			responseRows[record.ResponseID] = rowIndex
		}

		if record.QuestionID == nil {
			continue
		}
		answerColumn, exists := questionColumns[*record.QuestionID]
		if !exists {
			continue
		}
		value := ""
		if record.Value != nil {
			value = *record.Value
		}
		if record.FileURL != nil && *record.FileURL != "" {
			value = *record.FileURL
		}
		data.Rows[rowIndex][answerColumn] = value
	}
	return data
}

// GetAllAnswersForExport returns every completed response using a stable
// positional schema. The LEFT JOIN deliberately preserves completed responses
// without answers (for example, a form made entirely of optional questions).
func (r *SurveyRepository) GetAllAnswersForExport(ctx context.Context, accountID, surveyID uuid.UUID) (*domain.SurveyExportData, error) {
	var audienceMode string
	if err := r.db.QueryRow(ctx, `
		SELECT audience_mode FROM surveys WHERE account_id=$1 AND id=$2
	`, accountID, surveyID).Scan(&audienceMode); err != nil {
		return nil, err
	}
	programAudience := audienceMode == "program_participants"

	questions, err := r.GetQuestionsScoped(ctx, accountID, surveyID)
	if err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx, `
		SELECT response.id,
			CASE WHEN participant.id IS NOT NULL THEN participant.contact_id END,
			CASE WHEN participant.id IS NOT NULL THEN participant.id END,
			CASE WHEN participant.id IS NOT NULL THEN
				COALESCE(NULLIF(BTRIM(contact.custom_name),''),
					NULLIF(BTRIM(CONCAT_WS(' ',contact.name,contact.last_name)),''),
					NULLIF(BTRIM(contact.push_name),''),NULLIF(BTRIM(contact.phone),''),'Contacto')
			ELSE '' END,
			CASE WHEN participant.id IS NOT NULL THEN COALESCE(contact.phone,'') ELSE '' END,
			response.respondent_token,response.source,response.started_at,response.completed_at,
			answer.question_id,answer.value,answer.file_url
		FROM survey_responses response
		JOIN surveys survey ON survey.id=response.survey_id AND survey.account_id=response.account_id
		LEFT JOIN program_participants participant
		  ON survey.audience_mode='program_participants'
		 AND participant.id=response.program_participant_id
		 AND participant.program_id=survey.program_id
		 AND participant.contact_id=response.contact_id
		LEFT JOIN contacts contact
		  ON contact.account_id=survey.account_id AND contact.id=participant.contact_id
		LEFT JOIN survey_answers answer
		  ON answer.survey_id=response.survey_id AND answer.response_id=response.id
		LEFT JOIN survey_questions question
		  ON question.survey_id=survey.id AND question.id=answer.question_id
		WHERE survey.account_id=$1 AND survey.id=$2 AND response.completed_at IS NOT NULL
		ORDER BY response.created_at,response.id,question.order_index NULLS LAST,
			question.id NULLS LAST,answer.created_at NULLS LAST,answer.id NULLS LAST
	`, accountID, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]surveyExportRecord, 0)
	for rows.Next() {
		var record surveyExportRecord
		if err := rows.Scan(&record.ResponseID, &record.ContactID, &record.ProgramParticipantID,
			&record.ContactName, &record.ContactPhone, &record.Token, &record.Source,
			&record.StartedAt, &record.CompletedAt, &record.QuestionID, &record.Value,
			&record.FileURL); err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return buildSurveyExportData(programAudience, questions, records), nil
}

// GetResponseCount returns {completed, started} for views metrics
func (r *SurveyRepository) GetResponseCount(ctx context.Context, surveyID uuid.UUID) (completed, started int, err error) {
	err = r.db.QueryRow(ctx, `
		SELECT
			COUNT(*) FILTER (WHERE completed_at IS NOT NULL),
			COUNT(*)
		FROM survey_responses WHERE survey_id = $1
	`, surveyID).Scan(&completed, &started)
	return
}
