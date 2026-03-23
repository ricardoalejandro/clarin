package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type SurveyRepository struct {
	db *pgxpool.Pool
}

// ─── Survey CRUD ──────────────────────────────────────────────────────────────

func (r *SurveyRepository) Create(ctx context.Context, s *domain.Survey) error {
	brandingJSON, _ := json.Marshal(s.Branding)
	return r.db.QueryRow(ctx, `
		INSERT INTO surveys (account_id, name, description, slug, status,
			welcome_title, welcome_description, thank_you_title, thank_you_message,
			thank_you_redirect_url, branding, created_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id, created_at, updated_at
	`, s.AccountID, s.Name, s.Description, s.Slug, s.Status,
		s.WelcomeTitle, s.WelcomeDescription, s.ThankYouTitle, s.ThankYouMessage,
		s.ThankYouRedirectURL, brandingJSON, s.CreatedBy,
	).Scan(&s.ID, &s.CreatedAt, &s.UpdatedAt)
}

func (r *SurveyRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Survey, error) {
	s := &domain.Survey{}
	var brandingJSON []byte
	err := r.db.QueryRow(ctx, `
		SELECT s.id, s.account_id, s.name, s.description, s.slug, s.status,
			s.welcome_title, s.welcome_description, s.thank_you_title, s.thank_you_message,
			s.thank_you_redirect_url, s.branding, s.is_template, s.created_by, s.created_at, s.updated_at,
			(SELECT COUNT(*) FROM survey_questions WHERE survey_id = s.id) AS question_count,
			(SELECT COUNT(*) FROM survey_responses WHERE survey_id = s.id AND completed_at IS NOT NULL) AS response_count
		FROM surveys s
		WHERE s.id = $1 AND s.account_id = $2
	`, id, accountID).Scan(
		&s.ID, &s.AccountID, &s.Name, &s.Description, &s.Slug, &s.Status,
		&s.WelcomeTitle, &s.WelcomeDescription, &s.ThankYouTitle, &s.ThankYouMessage,
		&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
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
			s.thank_you_redirect_url, s.branding, s.is_template, s.created_by, s.created_at, s.updated_at,
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
			&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
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
	_, err := r.db.Exec(ctx, `
		UPDATE surveys SET name=$1, description=$2, slug=$3, status=$4,
			welcome_title=$5, welcome_description=$6, thank_you_title=$7, thank_you_message=$8,
			thank_you_redirect_url=$9, branding=$10, updated_at=NOW()
		WHERE id=$11 AND account_id=$12
	`, s.Name, s.Description, s.Slug, s.Status,
		s.WelcomeTitle, s.WelcomeDescription, s.ThankYouTitle, s.ThankYouMessage,
		s.ThankYouRedirectURL, brandingJSON, s.ID, s.AccountID,
	)
	return err
}

func (r *SurveyRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM surveys WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *SurveyRepository) SetStatus(ctx context.Context, id, accountID uuid.UUID, status string) error {
	_, err := r.db.Exec(ctx, `UPDATE surveys SET status=$1, updated_at=NOW() WHERE id=$2 AND account_id=$3`, status, id, accountID)
	return err
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
			thank_you_redirect_url, branding, is_template, created_by, created_at, updated_at
		FROM surveys WHERE slug = $1
	`, slug).Scan(
		&s.ID, &s.AccountID, &s.Name, &s.Description, &s.Slug, &s.Status,
		&s.WelcomeTitle, &s.WelcomeDescription, &s.ThankYouTitle, &s.ThankYouMessage,
		&s.ThankYouRedirectURL, &brandingJSON, &s.IsTemplate, &s.CreatedBy, &s.CreatedAt, &s.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(brandingJSON, &s.Branding)
	return s, nil
}

func (r *SurveyRepository) Duplicate(ctx context.Context, srcID, accountID uuid.UUID, newName, newSlug string) (*domain.Survey, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Copy survey
	newSurvey := &domain.Survey{}
	var brandingJSON []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO surveys (account_id, name, description, slug, status,
			welcome_title, welcome_description, thank_you_title, thank_you_message,
			thank_you_redirect_url, branding, created_by)
		SELECT account_id, $3, description, $4, 'draft',
			welcome_title, welcome_description, thank_you_title, thank_you_message,
			thank_you_redirect_url, branding, created_by
		FROM surveys WHERE id = $1 AND account_id = $2
		RETURNING id, account_id, name, description, slug, status,
			welcome_title, welcome_description, thank_you_title, thank_you_message,
			thank_you_redirect_url, branding, created_by, created_at, updated_at
	`, srcID, accountID, newName, newSlug).Scan(
		&newSurvey.ID, &newSurvey.AccountID, &newSurvey.Name, &newSurvey.Description,
		&newSurvey.Slug, &newSurvey.Status,
		&newSurvey.WelcomeTitle, &newSurvey.WelcomeDescription,
		&newSurvey.ThankYouTitle, &newSurvey.ThankYouMessage,
		&newSurvey.ThankYouRedirectURL, &brandingJSON, &newSurvey.CreatedBy,
		&newSurvey.CreatedAt, &newSurvey.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(brandingJSON, &newSurvey.Branding)

	// Copy questions
	_, err = tx.Exec(ctx, `
		INSERT INTO survey_questions (survey_id, order_index, type, title, description, required, config, logic_rules)
		SELECT $2, order_index, type, title, description, required, config, '[]'::jsonb
		FROM survey_questions WHERE survey_id = $1
		ORDER BY order_index
	`, srcID, newSurvey.ID)
	if err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return newSurvey, nil
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

// BulkUpsertQuestions replaces all questions for a survey with the given set.
// Uses DELETE + INSERT in a transaction for simplicity and correctness.
func (r *SurveyRepository) BulkUpsertQuestions(ctx context.Context, surveyID uuid.UUID, questions []domain.SurveyQuestion) ([]*domain.SurveyQuestion, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	// Delete existing questions (CASCADE deletes answers too)
	_, err = tx.Exec(ctx, `DELETE FROM survey_questions WHERE survey_id = $1`, surveyID)
	if err != nil {
		return nil, err
	}

	result := make([]*domain.SurveyQuestion, 0, len(questions))
	for i, q := range questions {
		configJSON, _ := json.Marshal(q.Config)
		logicJSON, _ := json.Marshal(q.LogicRules)
		if logicJSON == nil || string(logicJSON) == "null" {
			logicJSON = []byte("[]")
		}

		saved := &domain.SurveyQuestion{}
		var cfgOut, logicOut []byte
		err := tx.QueryRow(ctx, `
			INSERT INTO survey_questions (survey_id, order_index, type, title, description, required, config, logic_rules)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			RETURNING id, survey_id, order_index, type, title, description, required, config, logic_rules, created_at, updated_at
		`, surveyID, i, q.Type, q.Title, q.Description, q.Required, configJSON, logicJSON,
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
		INSERT INTO survey_responses (survey_id, account_id, respondent_token, lead_id, source, ip_address, user_agent, started_at, completed_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING id, created_at
	`, resp.SurveyID, resp.AccountID, resp.RespondentToken, resp.LeadID, resp.Source,
		resp.IPAddress, resp.UserAgent, resp.StartedAt, resp.CompletedAt,
	).Scan(&resp.ID, &resp.CreatedAt)
	if err != nil {
		return err
	}

	for i := range answers {
		answers[i].ResponseID = resp.ID
		err = tx.QueryRow(ctx, `
			INSERT INTO survey_answers (response_id, question_id, value, file_url)
			VALUES ($1,$2,$3,$4)
			RETURNING id, created_at
		`, answers[i].ResponseID, answers[i].QuestionID, answers[i].Value, answers[i].FileURL,
		).Scan(&answers[i].ID, &answers[i].CreatedAt)
		if err != nil {
			return err
		}
	}
	resp.Answers = answers

	return tx.Commit(ctx)
}

func (r *SurveyRepository) ListResponses(ctx context.Context, surveyID uuid.UUID, limit, offset int) ([]*domain.SurveyResponse, int, error) {
	var total int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_responses WHERE survey_id=$1 AND completed_at IS NOT NULL`, surveyID).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	rows, err := r.db.Query(ctx, `
		SELECT id, survey_id, account_id, respondent_token, lead_id, source, started_at, completed_at, created_at
		FROM survey_responses WHERE survey_id=$1 AND completed_at IS NOT NULL
		ORDER BY created_at DESC LIMIT $2 OFFSET $3
	`, surveyID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var responses []*domain.SurveyResponse
	for rows.Next() {
		r := &domain.SurveyResponse{}
		if err := rows.Scan(&r.ID, &r.SurveyID, &r.AccountID, &r.RespondentToken, &r.LeadID,
			&r.Source, &r.StartedAt, &r.CompletedAt, &r.CreatedAt); err != nil {
			return nil, 0, err
		}
		responses = append(responses, r)
	}
	return responses, total, nil
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
		SELECT id, response_id, question_id, value, file_url, created_at
		FROM survey_answers WHERE response_id=$1 ORDER BY created_at
	`, responseID)
	if err != nil {
		return nil, err
	}
	defer ansRows.Close()
	for ansRows.Next() {
		a := domain.SurveyAnswer{}
		if err := ansRows.Scan(&a.ID, &a.ResponseID, &a.QuestionID, &a.Value, &a.FileURL, &a.CreatedAt); err != nil {
			return nil, err
		}
		resp.Answers = append(resp.Answers, a)
	}
	return resp, nil
}

func (r *SurveyRepository) DeleteResponse(ctx context.Context, responseID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM survey_responses WHERE id=$1`, responseID)
	return err
}

// ─── Analytics ────────────────────────────────────────────────────────────────

func (r *SurveyRepository) GetAnalytics(ctx context.Context, surveyID uuid.UUID) (*domain.SurveyAnalytics, error) {
	analytics := &domain.SurveyAnalytics{}

	// Total responses + avg completion time
	err := r.db.QueryRow(ctx, `
		SELECT
			COUNT(*) AS total,
			COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at))), 0) AS avg_seconds
		FROM survey_responses
		WHERE survey_id = $1 AND completed_at IS NOT NULL
	`, surveyID).Scan(&analytics.TotalResponses, &analytics.AvgCompletionSec)
	if err != nil {
		return nil, err
	}

	// Completion rate (completed / total started)
	var totalStarted int
	_ = r.db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_responses WHERE survey_id=$1`, surveyID).Scan(&totalStarted)
	if totalStarted > 0 {
		analytics.CompletionRate = float64(analytics.TotalResponses) / float64(totalStarted) * 100
	}

	// Per-question stats
	questions, err := r.GetQuestions(ctx, surveyID)
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
			WHERE sa.question_id = $1 AND sr.completed_at IS NOT NULL
		`, q.ID).Scan(&stat.TotalAnswers)

		switch q.Type {
		case "single_choice", "multiple_choice":
			stat.OptionCounts = make(map[string]int)
			rows, err := r.db.Query(ctx, `
				SELECT sa.value, COUNT(*) FROM survey_answers sa
				JOIN survey_responses sr ON sr.id = sa.response_id
				WHERE sa.question_id = $1 AND sr.completed_at IS NOT NULL AND sa.value != ''
				GROUP BY sa.value
			`, q.ID)
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
				WHERE sa.question_id = $1 AND sr.completed_at IS NOT NULL AND sa.value ~ '^\d+(\.\d+)?$'
			`, q.ID).Scan(&avg)
			if err == nil {
				stat.Average = &avg
			}
			// Distribution
			stat.Distribution = make(map[string]int)
			rows, err := r.db.Query(ctx, `
				SELECT sa.value, COUNT(*) FROM survey_answers sa
				JOIN survey_responses sr ON sr.id = sa.response_id
				WHERE sa.question_id = $1 AND sr.completed_at IS NOT NULL AND sa.value != ''
				GROUP BY sa.value ORDER BY sa.value
			`, q.ID)
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

// GetAllAnswersForExport returns all answers for a survey in a flat format suitable for CSV export.
func (r *SurveyRepository) GetAllAnswersForExport(ctx context.Context, surveyID uuid.UUID) ([]map[string]string, error) {
	// Get questions for header order
	questions, err := r.GetQuestions(ctx, surveyID)
	if err != nil {
		return nil, err
	}

	rows, err := r.db.Query(ctx, `
		SELECT sr.id, sr.respondent_token, sr.source, sr.started_at, sr.completed_at,
			sa.question_id, sa.value, sa.file_url
		FROM survey_responses sr
		JOIN survey_answers sa ON sa.response_id = sr.id
		WHERE sr.survey_id = $1 AND sr.completed_at IS NOT NULL
		ORDER BY sr.created_at, sa.question_id
	`, surveyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	// Build question ID → title map
	qMap := make(map[uuid.UUID]string)
	for _, q := range questions {
		qMap[q.ID] = q.Title
	}

	// Group by response
	type answerRow struct {
		respID     uuid.UUID
		token      string
		source     string
		startedAt  string
		completedAt string
		questionID uuid.UUID
		value      string
		fileURL    string
	}

	responseMap := make(map[uuid.UUID]map[string]string)
	var responseOrder []uuid.UUID

	for rows.Next() {
		var ar answerRow
		var startedAt, completedAt interface{}
		if err := rows.Scan(&ar.respID, &ar.token, &ar.source, &startedAt, &completedAt,
			&ar.questionID, &ar.value, &ar.fileURL); err != nil {
			continue
		}

		if _, ok := responseMap[ar.respID]; !ok {
			responseMap[ar.respID] = map[string]string{
				"response_id": ar.respID.String(),
				"token":       ar.token,
				"source":      ar.source,
			}
			responseOrder = append(responseOrder, ar.respID)
		}
		title := qMap[ar.questionID]
		val := ar.value
		if ar.fileURL != "" {
			val = ar.fileURL
		}
		responseMap[ar.respID][title] = val
	}

	result := make([]map[string]string, 0, len(responseOrder))
	for _, rid := range responseOrder {
		result = append(result, responseMap[rid])
	}
	return result, nil
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
