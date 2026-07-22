package database

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type builtInSurveyQuestionSeed struct {
	orderIdx int
	qtype    string
	title    string
	desc     string
	required bool
	config   string
}

type builtInSurveyTemplateSeed struct {
	slugSuffix  string
	name        string
	description string
	welcomeT    string
	welcomeD    string
	thankT      string
	thankM      string
	branding    string
	questions   []builtInSurveyQuestionSeed
}

// seedCanonicalSurveyTemplatesForAccount creates the built-in definitions
// directly in the non-answerable template catalog. One account is seeded in a
// single transaction, so a failed question insert can never expose a partial
// public survey. The account advisory lock also makes concurrent registration
// and startup seeding deterministic.
//
// Older installations may already have the former `tpl-*` survey rows. Those
// public slugs and any responses remain intact. We attach their canonical
// template, fill only missing positions while the built-in definition is still
// at revision 1, and repair a partial legacy question snapshot only when it has
// no responses.
func seedCanonicalSurveyTemplatesForAccount(ctx context.Context, db *pgxpool.Pool, rawAccountID string, templates []builtInSurveyTemplateSeed) error {
	accountID, err := uuid.Parse(rawAccountID)
	if err != nil {
		return fmt.Errorf("invalid account id for survey template seed: %w", err)
	}
	short := accountID.String()[:8]

	tx, err := db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin survey template seed: %w", err)
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, "survey-template-seed:"+accountID.String()); err != nil {
		return fmt.Errorf("lock survey template seed: %w", err)
	}

	created := make([]string, 0, len(templates))
	for _, definition := range templates {
		systemKey := "builtin:" + definition.slugSuffix
		legacySlug := fmt.Sprintf("tpl-%s-%s", definition.slugSuffix, short)

		templateID, revision, legacySurveyID, found, err := findBuiltInSurveyTemplate(ctx, tx, accountID, systemKey, legacySlug)
		if err != nil {
			return err
		}
		if !found {
			legacySurveyID, err = findLegacyBuiltInSurvey(ctx, tx, accountID, legacySlug)
			if err != nil {
				return err
			}
			err = tx.QueryRow(ctx, `
				INSERT INTO survey_templates (
					account_id,name,description,status,welcome_title,welcome_description,
					thank_you_title,thank_you_message,branding,revision,system_key,legacy_survey_id
				) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8::jsonb,1,$9,$10)
				RETURNING id,revision
			`, accountID, definition.name, definition.description, definition.welcomeT,
				definition.welcomeD, definition.thankT, definition.thankM,
				definition.branding, systemKey, legacySurveyID).Scan(&templateID, &revision)
			if err != nil {
				return fmt.Errorf("create canonical survey template %s: %w", systemKey, err)
			}
			created = append(created, definition.name)
		}

		// A revision greater than one proves that a user edited the template.
		// Never reinterpret an intentional edit as an interrupted seed.
		if revision == 1 {
			if err := repairBuiltInTemplateQuestions(ctx, tx, accountID, templateID, definition.questions); err != nil {
				return fmt.Errorf("repair canonical survey template %s: %w", systemKey, err)
			}
		}

		if legacySurveyID != nil {
			if err := linkLegacyBuiltInSurvey(ctx, tx, accountID, templateID, *legacySurveyID); err != nil {
				return fmt.Errorf("link legacy survey template %s: %w", systemKey, err)
			}
			if revision == 1 {
				if err := repairUnansweredLegacySurveyQuestions(ctx, tx, accountID, templateID, *legacySurveyID, definition.questions); err != nil {
					return fmt.Errorf("repair legacy survey template %s: %w", systemKey, err)
				}
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit survey template seed: %w", err)
	}
	for _, name := range created {
		log.Printf("[SEED] Created canonical survey template %q for account %s", name, short)
	}
	return nil
}

func findBuiltInSurveyTemplate(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, systemKey, legacySlug string) (uuid.UUID, int, *uuid.UUID, bool, error) {
	var templateID uuid.UUID
	var revision int
	var legacySurveyID *uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id,revision,legacy_survey_id
		FROM survey_templates
		WHERE account_id=$1 AND system_key=$2
		FOR UPDATE
	`, accountID, systemKey).Scan(&templateID, &revision, &legacySurveyID)
	if err == nil {
		return templateID, revision, legacySurveyID, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, 0, nil, false, fmt.Errorf("find survey template %s: %w", systemKey, err)
	}

	// Migrations created canonical templates from historical survey rows before
	// system_key existed. Claim only the exact account-scoped built-in slug.
	err = tx.QueryRow(ctx, `
		SELECT st.id,st.revision,st.legacy_survey_id
		FROM survey_templates st
		JOIN surveys s ON s.account_id=st.account_id AND s.id=st.legacy_survey_id
		WHERE st.account_id=$1 AND s.slug=$2
		  AND (st.system_key IS NULL OR st.system_key=$3)
		ORDER BY st.created_at,st.id
		LIMIT 1
		FOR UPDATE OF st
	`, accountID, legacySlug, systemKey).Scan(&templateID, &revision, &legacySurveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, 0, nil, false, nil
	}
	if err != nil {
		return uuid.Nil, 0, nil, false, fmt.Errorf("find legacy-backed survey template %s: %w", systemKey, err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE survey_templates SET system_key=$3
		WHERE account_id=$1 AND id=$2 AND system_key IS NULL
	`, accountID, templateID, systemKey); err != nil {
		return uuid.Nil, 0, nil, false, fmt.Errorf("claim legacy survey template %s: %w", systemKey, err)
	}
	return templateID, revision, legacySurveyID, true, nil
}

func findLegacyBuiltInSurvey(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, legacySlug string) (*uuid.UUID, error) {
	var legacySurveyID uuid.UUID
	err := tx.QueryRow(ctx, `
		SELECT id FROM surveys
		WHERE account_id=$1 AND slug=$2 AND is_template
		FOR UPDATE
	`, accountID, legacySlug).Scan(&legacySurveyID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("find legacy built-in survey %s: %w", legacySlug, err)
	}
	return &legacySurveyID, nil
}

func repairBuiltInTemplateQuestions(ctx context.Context, tx pgx.Tx, accountID, templateID uuid.UUID, questions []builtInSurveyQuestionSeed) error {
	for _, question := range questions {
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_template_questions (
				account_id,template_id,order_index,type,title,description,required,config,logic_rules,is_active
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'[]'::jsonb,TRUE)
			ON CONFLICT (account_id,template_id,order_index) WHERE is_active DO NOTHING
		`, accountID, templateID, question.orderIdx, question.qtype, question.title,
			question.desc, question.required, question.config); err != nil {
			return err
		}
	}
	return nil
}

func linkLegacyBuiltInSurvey(ctx context.Context, tx pgx.Tx, accountID, templateID, surveyID uuid.UUID) error {
	_, err := tx.Exec(ctx, `
		UPDATE surveys SET
			template_id=$3,template_revision=1,origin_type='standalone',program_id=NULL,
			origin_label=CASE WHEN origin_label='' THEN 'Aplicación heredada' ELSE origin_label END,
			legacy_instance=TRUE
		WHERE account_id=$1 AND id=$2
	`, accountID, surveyID, templateID)
	return err
}

func repairUnansweredLegacySurveyQuestions(ctx context.Context, tx pgx.Tx, accountID, templateID, surveyID uuid.UUID, questions []builtInSurveyQuestionSeed) error {
	var hasResponses bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM survey_responses WHERE account_id=$1 AND survey_id=$2)`, accountID, surveyID).Scan(&hasResponses); err != nil {
		return err
	}
	if hasResponses {
		return nil
	}
	for _, question := range questions {
		var sourceID uuid.UUID
		if err := tx.QueryRow(ctx, `
			SELECT id FROM survey_template_questions
			WHERE account_id=$1 AND template_id=$2 AND order_index=$3 AND is_active
		`, accountID, templateID, question.orderIdx).Scan(&sourceID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO survey_questions (
				survey_id,order_index,type,title,description,required,config,logic_rules,
				source_template_question_id,template_revision
			)
			SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,'[]'::jsonb,$8,1
			WHERE NOT EXISTS (
				SELECT 1 FROM survey_questions WHERE survey_id=$1 AND order_index=$2
			)
		`, surveyID, question.orderIdx, question.qtype, question.title, question.desc,
			question.required, question.config, sourceID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE survey_questions SET source_template_question_id=$3,template_revision=1
			WHERE survey_id=$1 AND order_index=$2 AND source_template_question_id IS NULL
		`, surveyID, question.orderIdx, sourceID); err != nil {
			return err
		}
	}
	return nil
}
