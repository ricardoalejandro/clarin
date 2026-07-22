package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// TestSurveyTemplateInstanceMigration runs only against an explicitly enabled
// disposable PostgreSQL database. It models rows created before templates and
// instances were separated, then proves lossless backfill, account isolation,
// composite answer integrity and idempotency.
func TestSurveyTemplateInstanceMigration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_SURVEY_TEMPLATE_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_SURVEY_TEMPLATE_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_survey_template_instance_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()

	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}

	accountA, accountB := uuid.New(), uuid.New()
	surveyA, surveyB := uuid.New(), uuid.New()
	questionA, questionB := uuid.New(), uuid.New()
	responseA, responseB := uuid.New(), uuid.New()
	answerA, answerB := uuid.New(), uuid.New()
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Encuestas A'),($2,'Encuestas B')`, []any{accountA, accountB}},
		{`INSERT INTO surveys (id,account_id,name,slug,status,is_template,template_id,legacy_instance)
		  VALUES ($1,$2,'Plantilla histórica A','historica-a','active',TRUE,NULL,FALSE),
		         ($3,$4,'Encuesta histórica B','historica-b','closed',FALSE,NULL,FALSE)`, []any{surveyA, accountA, surveyB, accountB}},
		{`INSERT INTO survey_questions (id,survey_id,order_index,type,title,required,config)
		  VALUES ($1,$2,0,'single_choice','Pregunta A',TRUE,'{"options":["Sí","No"]}'),
		         ($3,$4,0,'short_text','Pregunta B',FALSE,'{}')`, []any{questionA, surveyA, questionB, surveyB}},
		{`INSERT INTO survey_responses (id,survey_id,account_id,respondent_token,completed_at)
		  VALUES ($1,$2,$3,'token-a',NOW()),($4,$5,$6,'token-b',NOW())`, []any{responseA, surveyA, accountA, responseB, surveyB, accountB}},
		{`INSERT INTO survey_answers (id,response_id,survey_id,question_id,value)
		  VALUES ($1,$2,$3,$4,'Sí'),($5,$6,$7,$8,'Texto')`, []any{answerA, responseA, surveyA, questionA, answerB, responseB, surveyB, questionB}},
	}
	for _, fixture := range fixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed legacy survey fixture: %v\n%s", err, fixture.query)
		}
	}

	// Reproduce the pre-migration answer shape while retaining the rest of the
	// already-created schema needed by this focused integration test.
	for _, statement := range []string{
		`ALTER TABLE survey_answers DROP CONSTRAINT IF EXISTS survey_answers_survey_response_fkey`,
		`ALTER TABLE survey_answers DROP CONSTRAINT IF EXISTS survey_answers_survey_question_fkey`,
		`ALTER TABLE survey_answers ALTER COLUMN survey_id DROP NOT NULL`,
		`UPDATE survey_answers SET survey_id=NULL`,
	} {
		if _, err := db.Exec(ctx, statement); err != nil {
			t.Fatalf("prepare legacy answer shape: %v\n%s", err, statement)
		}
	}

	if err := Migrate(db); err != nil {
		t.Fatalf("survey split migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent survey split migrate: %v", err)
	}

	var templateA, templateB uuid.UUID
	var templateCount, templateQuestionCount, responseCount, answerCount int
	if err := db.QueryRow(ctx, `SELECT id FROM survey_templates WHERE account_id=$1 AND legacy_survey_id=$2`, accountA, surveyA).Scan(&templateA); err != nil {
		t.Fatalf("load account A template: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM survey_templates WHERE account_id=$1 AND legacy_survey_id=$2`, accountB, surveyB).Scan(&templateB); err != nil {
		t.Fatalf("load account B template: %v", err)
	}
	if templateA == templateB {
		t.Fatal("different accounts unexpectedly share one survey template")
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_templates WHERE legacy_survey_id=ANY($1::uuid[])`, []uuid.UUID{surveyA, surveyB}).Scan(&templateCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_template_questions WHERE id=ANY($1::uuid[])`, []uuid.UUID{questionA, questionB}).Scan(&templateQuestionCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_responses WHERE id=ANY($1::uuid[])`, []uuid.UUID{responseA, responseB}).Scan(&responseCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_answers WHERE id=ANY($1::uuid[]) AND survey_id IS NOT NULL`, []uuid.UUID{answerA, answerB}).Scan(&answerCount); err != nil {
		t.Fatal(err)
	}
	if templateCount != 2 || templateQuestionCount != 2 || responseCount != 2 || answerCount != 2 {
		t.Fatalf("lossless/idempotent backfill failed: templates=%d questions=%d responses=%d answers=%d", templateCount, templateQuestionCount, responseCount, answerCount)
	}

	var linkedTemplate uuid.UUID
	var legacy bool
	var slug, status string
	if err := db.QueryRow(ctx, `SELECT template_id,legacy_instance,slug,status FROM surveys WHERE account_id=$1 AND id=$2`, accountA, surveyA).Scan(&linkedTemplate, &legacy, &slug, &status); err != nil {
		t.Fatal(err)
	}
	if linkedTemplate != templateA || !legacy || slug != "historica-a" || status != "active" {
		t.Fatalf("legacy application contract changed: template=%s legacy=%t slug=%q status=%q", linkedTemplate, legacy, slug, status)
	}
	legacySnapshot, err := repository.NewRepositories(db).Survey.GetByID(ctx, surveyA, accountA)
	if err != nil {
		t.Fatal(err)
	}
	legacySnapshot.Name = "Mutación legacy activa"
	if err := repository.NewRepositories(db).Survey.Update(ctx, legacySnapshot); !errors.Is(err, repository.ErrSurveyPublishedImmutable) {
		t.Fatalf("active legacy presentation mutation error=%v", err)
	}

	// The composite foreign key must reject a question from another survey,
	// even when all UUIDs individually exist.
	if _, err := db.Exec(ctx, `INSERT INTO survey_answers (response_id,survey_id,question_id,value) VALUES ($1,$2,$3,'cruce')`, responseA, surveyA, questionB); err == nil {
		t.Fatal("cross-survey answer was accepted")
	}

	// Protected analytics must carry account isolation into every data query,
	// rather than trusting a survey UUID validated elsewhere.
	repos := repository.NewRepositories(db)
	analytics, err := repos.Survey.GetAnalytics(ctx, accountA, surveyA)
	if err != nil {
		t.Fatalf("load scoped analytics: %v", err)
	}
	if analytics.TotalResponses != 1 {
		t.Fatalf("account A analytics responses=%d, want 1", analytics.TotalResponses)
	}
	if _, err := repos.Survey.GetAnalytics(ctx, accountB, surveyA); err == nil {
		t.Fatal("cross-account survey analytics was accepted")
	}

	// Reproduce a real restart after creating a canonical program application.
	// The legacy backfill must never promote the application into a new template
	// or detach it from its program.
	canonicalTemplateID := uuid.New()
	canonicalTemplateQuestionID := uuid.New()
	canonicalSurveyID := uuid.New()
	canonicalSurveyQuestionID := uuid.New()
	programID := uuid.New()
	canonicalFixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO programs (id,account_id,name,type) VALUES ($1,$2,'Programa de encuesta','course')`, []any{programID, accountA}},
		{`INSERT INTO survey_templates (id,account_id,name,status,revision) VALUES ($1,$2,'Plantilla canónica','active',3)`, []any{canonicalTemplateID, accountA}},
		{`INSERT INTO survey_template_questions (id,account_id,template_id,order_index,type,title,required,config)
		  VALUES ($1,$2,$3,0,'short_text','Pregunta canónica',TRUE,'{}')`, []any{canonicalTemplateQuestionID, accountA, canonicalTemplateID}},
		{`INSERT INTO surveys (
			id,account_id,name,slug,status,is_template,template_id,template_revision,
			origin_type,program_id,origin_label,audience_mode,legacy_instance
		  ) VALUES ($1,$2,'Aplicación canónica','aplicacion-canonica','draft',FALSE,$3,3,
			'program',$4,'Programa de encuesta','program_participants',FALSE)`, []any{canonicalSurveyID, accountA, canonicalTemplateID, programID}},
		{`INSERT INTO survey_questions (
			id,survey_id,order_index,type,title,required,config,source_template_question_id,template_revision
		  ) VALUES ($1,$2,0,'short_text','Pregunta canónica',TRUE,'{}',$3,3)`, []any{canonicalSurveyQuestionID, canonicalSurveyID, canonicalTemplateQuestionID}},
	}
	for _, fixture := range canonicalFixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed canonical survey fixture: %v\n%s", err, fixture.query)
		}
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("restart migration after canonical application: %v", err)
	}

	var gotTemplateID, gotProgramID uuid.UUID
	var gotOrigin string
	var gotLegacy bool
	if err := db.QueryRow(ctx, `
		SELECT template_id,program_id,origin_type,legacy_instance
		FROM surveys WHERE account_id=$1 AND id=$2
	`, accountA, canonicalSurveyID).Scan(&gotTemplateID, &gotProgramID, &gotOrigin, &gotLegacy); err != nil {
		t.Fatal(err)
	}
	if gotTemplateID != canonicalTemplateID || gotProgramID != programID || gotOrigin != "program" || gotLegacy {
		t.Fatalf("canonical application changed after restart: template=%s program=%s origin=%q legacy=%t",
			gotTemplateID, gotProgramID, gotOrigin, gotLegacy)
	}
	var accidentalTemplateCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_templates WHERE account_id=$1 AND legacy_survey_id=$2`, accountA, canonicalSurveyID).Scan(&accidentalTemplateCount); err != nil {
		t.Fatal(err)
	}
	if accidentalTemplateCount != 0 {
		t.Fatalf("restart created %d accidental templates from a canonical application", accidentalTemplateCount)
	}

	// Repository guards are atomic too: a concurrent request cannot mutate the
	// presentation/questions of a canonical snapshot, not even while it is a
	// draft, or send it back to draft after publication.
	canonicalSnapshot, err := repos.Survey.GetByID(ctx, canonicalSurveyID, accountA)
	if err != nil {
		t.Fatal(err)
	}
	canonicalSnapshot.Name = "Mutación prohibida"
	if err := repos.Survey.Update(ctx, canonicalSnapshot); !errors.Is(err, repository.ErrSurveyPublishedImmutable) {
		t.Fatalf("canonical draft presentation mutation error=%v", err)
	}
	if _, err := repos.Survey.BulkUpsertQuestions(ctx, accountA, canonicalSurveyID, []domain.SurveyQuestion{{Type: "short_text", Title: "Mutación"}}); !errors.Is(err, repository.ErrSurveyPublishedImmutable) {
		t.Fatalf("canonical draft question mutation error=%v", err)
	}
	if err := repos.Survey.SetStatus(ctx, canonicalSurveyID, accountA, "active"); err != nil {
		t.Fatalf("publish immutable application: %v", err)
	}
	if err := repos.Survey.SetStatus(ctx, canonicalSurveyID, accountA, "closed"); err != nil {
		t.Fatalf("close immutable application: %v", err)
	}
	if err := repos.Survey.SetStatus(ctx, canonicalSurveyID, accountA, "draft"); !errors.Is(err, repository.ErrSurveyCannotReturnToDraft) {
		t.Fatalf("published application returned to draft: %v", err)
	}
	var immutableName, immutableStatus string
	if err := db.QueryRow(ctx, `SELECT name,status FROM surveys WHERE account_id=$1 AND id=$2`, accountA, canonicalSurveyID).Scan(&immutableName, &immutableStatus); err != nil {
		t.Fatal(err)
	}
	if immutableName != "Aplicación canónica" || immutableStatus != "closed" {
		t.Fatalf("immutable snapshot changed: name=%q status=%q", immutableName, immutableStatus)
	}

	// Contact deduplication must not erase a frozen survey audience, completed
	// responses or its durable uploads. When both contacts were enrolled in the
	// same program, the kept enrollment becomes the canonical identity and only
	// the one-to-one recipient pointer is collapsed; every response survives.
	keepContactID, sourceContactID, secondSourceContactID := uuid.New(), uuid.New(), uuid.New()
	keepParticipantID, sourceParticipantID := uuid.New(), uuid.New()
	keepRecipientID, sourceRecipientID := uuid.New(), uuid.New()
	keepRecipientAccessToken, sourceRecipientAccessToken := uuid.New(), uuid.New()
	keepResponseID, sourceResponseID := uuid.New(), uuid.New()
	programWithoutKeepID, surveyWithoutKeepID := uuid.New(), uuid.New()
	firstSourceOnlyParticipantID, secondSourceOnlyParticipantID := uuid.New(), uuid.New()
	firstSourceOnlyRecipientID, secondSourceOnlyRecipientID := uuid.New(), uuid.New()
	firstSourceOnlyAccessToken, secondSourceOnlyAccessToken := uuid.New(), uuid.New()
	firstSourceOnlyResponseID, secondSourceOnlyResponseID := uuid.New(), uuid.New()
	mergeFixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO contacts (id,account_id,jid,phone,name)
		  VALUES ($1,$2,'51900000001@s.whatsapp.net','51900000001','Contacto conservado'),
		         ($3,$2,'51900000002@s.whatsapp.net','51900000002','Contacto duplicado'),
		         ($4,$2,'51900000003@s.whatsapp.net','51900000003','Segundo duplicado')`, []any{keepContactID, accountA, sourceContactID, secondSourceContactID}},
		{`INSERT INTO programs (id,account_id,name,type) VALUES ($1,$2,'Programa sin contacto conservado','course')`, []any{programWithoutKeepID, accountA}},
		{`INSERT INTO surveys (
			id,account_id,name,slug,status,is_template,template_id,template_revision,
			origin_type,program_id,origin_label,audience_mode,legacy_instance
		  ) VALUES ($1,$2,'Aplicación sin contacto conservado','aplicacion-sin-conservado','active',FALSE,$3,3,
			'program',$4,'Programa sin contacto conservado','program_participants',FALSE)`, []any{surveyWithoutKeepID, accountA, canonicalTemplateID, programWithoutKeepID}},
		{`INSERT INTO program_participants (id,program_id,contact_id,status)
		  VALUES ($1,$2,$3,'enrolled'),($4,$2,$5,'enrolled'),
		         ($6,$7,$5,'enrolled'),($8,$7,$9,'enrolled')`, []any{
			keepParticipantID, programID, keepContactID, sourceParticipantID, sourceContactID,
			firstSourceOnlyParticipantID, programWithoutKeepID, secondSourceOnlyParticipantID, secondSourceContactID,
		}},
		{`INSERT INTO survey_instance_recipients (
			id,account_id,survey_id,program_id,program_participant_id,contact_id,access_token,status,invited_at,completed_at
		  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',NOW(),NULL),
		           ($8,$2,$3,$4,$9,$10,$11,'completed',NOW()-INTERVAL '1 day',NOW())`, []any{
			keepRecipientID, accountA, canonicalSurveyID, programID, keepParticipantID, keepContactID, keepRecipientAccessToken,
			sourceRecipientID, sourceParticipantID, sourceContactID, sourceRecipientAccessToken,
		}},
		{`INSERT INTO survey_instance_recipients (
			id,account_id,survey_id,program_id,program_participant_id,contact_id,access_token,status,invited_at,completed_at
		  ) VALUES ($1,$2,$3,$4,$5,$6,$7,'completed',NOW(),NOW()),
		           ($8,$2,$3,$4,$9,$10,$11,'completed',NOW(),NOW())`, []any{
			firstSourceOnlyRecipientID, accountA, surveyWithoutKeepID, programWithoutKeepID,
			firstSourceOnlyParticipantID, sourceContactID, firstSourceOnlyAccessToken,
			secondSourceOnlyRecipientID, secondSourceOnlyParticipantID, secondSourceContactID, secondSourceOnlyAccessToken,
		}},
		{`INSERT INTO survey_responses (
			id,survey_id,account_id,respondent_token,recipient_id,contact_id,program_id,program_participant_id,completed_at
		  ) VALUES ($1,$2,$3,'merge-keep',$4,$5,$6,$7,NOW()),
		           ($8,$2,$3,'merge-source',$9,$10,$6,$11,NOW())`, []any{
			keepResponseID, canonicalSurveyID, accountA, keepRecipientID, keepContactID, programID, keepParticipantID,
			sourceResponseID, sourceRecipientID, sourceContactID, sourceParticipantID,
		}},
		{`INSERT INTO survey_responses (
			id,survey_id,account_id,respondent_token,recipient_id,contact_id,program_id,program_participant_id,completed_at
		  ) VALUES ($1,$2,$3,'source-only-a',$4,$5,$6,$7,NOW()),
		           ($8,$2,$3,'source-only-b',$9,$10,$6,$11,NOW())`, []any{
			firstSourceOnlyResponseID, surveyWithoutKeepID, accountA, firstSourceOnlyRecipientID,
			sourceContactID, programWithoutKeepID, firstSourceOnlyParticipantID,
			secondSourceOnlyResponseID, secondSourceOnlyRecipientID, secondSourceContactID, secondSourceOnlyParticipantID,
		}},
	}
	for _, fixture := range mergeFixtures {
		if _, err := db.Exec(ctx, fixture.query, fixture.args...); err != nil {
			t.Fatalf("seed contact-merge survey fixture: %v\n%s", err, fixture.query)
		}
	}
	upload, err := repos.Survey.PrepareSurveyFileUpload(ctx, repository.PrepareSurveyFileUploadInput{
		AccountID:        accountA,
		SurveyID:         canonicalSurveyID,
		QuestionID:       canonicalSurveyQuestionID,
		RecipientID:      &sourceRecipientID,
		RespondentToken:  "merge-source",
		ObjectKey:        accountA.String() + "/surveys/merge-proof.txt",
		OriginalFilename: "evidencia.txt",
		ContentType:      "text/plain",
		SizeBytes:        12,
		ContentHash:      "merge-proof",
		ExpiresAt:        time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("seed contact-merge upload: %v", err)
	}
	if _, err := repos.Contact.MergeContacts(ctx, accountA, keepContactID, []uuid.UUID{sourceContactID, secondSourceContactID}, nil); err != nil {
		t.Fatalf("merge contacts with survey history: %v", err)
	}

	var participantCount, recipientCount, aliasCount, responseCountAfterMerge, responseRecipientCount, canonicalResponseCount int
	var mergedRecipientStatus string
	var mergedUploadRecipient uuid.UUID
	var mergedUploadStatus, mergedUploadRespondentToken string
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM program_participants WHERE program_id=$1 AND id=ANY($2::uuid[])`, programID, []uuid.UUID{keepParticipantID, sourceParticipantID}).Scan(&participantCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*),MIN(status) FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2 AND program_participant_id=$3`, accountA, canonicalSurveyID, keepParticipantID).Scan(&recipientCount, &mergedRecipientStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM survey_instance_recipients
		WHERE account_id=$1 AND survey_id=$2 AND id=$3
		  AND merged_into_recipient_id=$4 AND program_id IS NULL
		  AND program_participant_id IS NULL AND contact_id IS NULL
	`, accountA, canonicalSurveyID, sourceRecipientID, keepRecipientID).Scan(&aliasCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*),COUNT(recipient_id),COUNT(*) FILTER (
			WHERE contact_id=$3 AND program_id=$4 AND program_participant_id=$5
		)
		FROM survey_responses WHERE account_id=$1 AND survey_id=$2 AND id=ANY($6::uuid[])
	`, accountA, canonicalSurveyID, keepContactID, programID, keepParticipantID, []uuid.UUID{keepResponseID, sourceResponseID}).Scan(&responseCountAfterMerge, &responseRecipientCount, &canonicalResponseCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT recipient_id,status,respondent_token FROM survey_file_uploads WHERE account_id=$1 AND id=$2`, accountA, upload.ID).Scan(&mergedUploadRecipient, &mergedUploadStatus, &mergedUploadRespondentToken); err != nil {
		t.Fatal(err)
	}
	if participantCount != 1 || recipientCount != 1 || aliasCount != 1 || mergedRecipientStatus != "completed" {
		t.Fatalf("survey audience merge failed: participants=%d recipients=%d aliases=%d status=%q", participantCount, recipientCount, aliasCount, mergedRecipientStatus)
	}
	if responseCountAfterMerge != 2 || responseRecipientCount != 1 || canonicalResponseCount != 2 {
		t.Fatalf("survey responses were lost or misqualified: rows=%d recipient-links=%d canonical=%d", responseCountAfterMerge, responseRecipientCount, canonicalResponseCount)
	}
	if mergedUploadRecipient != keepRecipientID || mergedUploadStatus != "staged" || mergedUploadRespondentToken != "merge-source" {
		t.Fatalf("staged survey upload changed unexpectedly: recipient=%s status=%q respondent=%q", mergedUploadRecipient, mergedUploadStatus, mergedUploadRespondentToken)
	}
	resolvedRecipient, err := repos.SurveyTemplate.GetRecipientByToken(ctx, canonicalSurveyID, sourceRecipientAccessToken)
	if err != nil {
		t.Fatalf("old recipient token stopped resolving after contact merge: %v", err)
	}
	if resolvedRecipient.ID != keepRecipientID || resolvedRecipient.ProgramParticipantID == nil || *resolvedRecipient.ProgramParticipantID != keepParticipantID {
		t.Fatalf("old recipient token resolved to recipient=%s participant=%v", resolvedRecipient.ID, resolvedRecipient.ProgramParticipantID)
	}
	mergedInstance, err := repos.SurveyTemplate.GetInstance(ctx, accountA, canonicalSurveyID)
	if err != nil {
		t.Fatal(err)
	}
	if mergedInstance.RecipientCount != 1 {
		t.Fatalf("recipient aliases inflated the active audience to %d", mergedInstance.RecipientCount)
	}

	var participantWithoutKeepID, recipientWithoutKeepID uuid.UUID
	var participantsWithoutKeep, aliasesWithoutKeep, responsesWithoutKeep int
	if err := db.QueryRow(ctx, `SELECT COUNT(*),(ARRAY_AGG(id ORDER BY id))[1] FROM program_participants WHERE program_id=$1 AND contact_id=$2`, programWithoutKeepID, keepContactID).Scan(&participantsWithoutKeep, &participantWithoutKeepID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2 AND program_participant_id=$3`, accountA, surveyWithoutKeepID, participantWithoutKeepID).Scan(&recipientWithoutKeepID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_instance_recipients WHERE account_id=$1 AND survey_id=$2 AND merged_into_recipient_id=$3`, accountA, surveyWithoutKeepID, recipientWithoutKeepID).Scan(&aliasesWithoutKeep); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_responses WHERE account_id=$1 AND survey_id=$2 AND contact_id=$3 AND program_participant_id=$4`, accountA, surveyWithoutKeepID, keepContactID, participantWithoutKeepID).Scan(&responsesWithoutKeep); err != nil {
		t.Fatal(err)
	}
	if participantsWithoutKeep != 1 || aliasesWithoutKeep != 1 || responsesWithoutKeep != 2 {
		t.Fatalf("multi-source survey merge without a pre-existing destination failed: participants=%d aliases=%d responses=%d", participantsWithoutKeep, aliasesWithoutKeep, responsesWithoutKeep)
	}
	for _, oldToken := range []uuid.UUID{firstSourceOnlyAccessToken, secondSourceOnlyAccessToken} {
		resolved, err := repos.SurveyTemplate.GetRecipientByToken(ctx, surveyWithoutKeepID, oldToken)
		if err != nil || resolved.ID != recipientWithoutKeepID {
			t.Fatalf("old multi-source token %s resolved to %v (error=%v), want %s", oldToken, resolved, err, recipientWithoutKeepID)
		}
	}

	var cascadingRecipientFKs int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM pg_constraint
		WHERE conrelid='survey_instance_recipients'::regclass
		  AND conname IN (
			'survey_instance_recipients_program_participant_fkey',
			'survey_instance_recipients_program_contact_fkey',
			'survey_instance_recipients_program_identity_fkey'
		  ) AND confupdtype='c'
	`).Scan(&cascadingRecipientFKs); err != nil {
		t.Fatal(err)
	}
	if cascadingRecipientFKs != 3 {
		t.Fatalf("recipient identity FKs with ON UPDATE CASCADE=%d, want 3", cascadingRecipientFKs)
	}

	// Built-ins now seed directly into the non-answerable catalog. Repeating the
	// seed must neither create public survey rows nor duplicate definitions.
	var surveysBefore, surveysAfter int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM surveys WHERE account_id=$1`, accountA).Scan(&surveysBefore); err != nil {
		t.Fatal(err)
	}
	if err := SeedTemplateSurveysForAccount(db, accountA.String()); err != nil {
		t.Fatalf("seed canonical built-ins: %v", err)
	}
	if err := SeedTemplateSurveysForAccount(db, accountA.String()); err != nil {
		t.Fatalf("repeat canonical built-in seed: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM surveys WHERE account_id=$1`, accountA).Scan(&surveysAfter); err != nil {
		t.Fatal(err)
	}
	var builtInTemplates, builtInQuestions int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_templates WHERE account_id=$1 AND system_key LIKE 'builtin:%'`, accountA).Scan(&builtInTemplates); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM survey_template_questions q
		JOIN survey_templates t ON t.account_id=q.account_id AND t.id=q.template_id
		WHERE t.account_id=$1 AND t.system_key LIKE 'builtin:%' AND q.is_active
	`, accountA).Scan(&builtInQuestions); err != nil {
		t.Fatal(err)
	}
	if surveysAfter != surveysBefore || builtInTemplates != 3 || builtInQuestions != 27 {
		t.Fatalf("canonical seed was not idempotent/non-answerable: surveys=%d->%d templates=%d questions=%d",
			surveysBefore, surveysAfter, builtInTemplates, builtInQuestions)
	}

	// A revision-1 partial template is an interrupted seed, not a user edit.
	// The next run restores only the missing position without rewriting rows.
	var habitsTemplate uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM survey_templates WHERE account_id=$1 AND system_key='builtin:habitos'`, accountA).Scan(&habitsTemplate); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM survey_template_questions WHERE account_id=$1 AND template_id=$2 AND order_index=9`, accountA, habitsTemplate); err != nil {
		t.Fatal(err)
	}
	if err := SeedTemplateSurveysForAccount(db, accountA.String()); err != nil {
		t.Fatalf("repair interrupted canonical seed: %v", err)
	}
	var repaired bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM survey_template_questions WHERE account_id=$1 AND template_id=$2 AND order_index=9 AND is_active)`, accountA, habitsTemplate).Scan(&repaired); err != nil {
		t.Fatal(err)
	}
	if !repaired {
		t.Fatal("interrupted canonical survey seed was not repaired")
	}

	// All three built-ins belong to one transaction. Invalid seed JSON after a
	// valid first definition must roll back the entire account seed.
	rollbackAccount := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts (id,name) VALUES ($1,'Seed rollback')`, rollbackAccount); err != nil {
		t.Fatal(err)
	}
	brokenDefinitions := []builtInSurveyTemplateSeed{
		{slugSuffix: "valid", name: "Valid", branding: `{}`, questions: []builtInSurveyQuestionSeed{{0, "short_text", "Pregunta", "", true, `{}`}}},
		{slugSuffix: "broken", name: "Broken", branding: `{}`, questions: []builtInSurveyQuestionSeed{{0, "short_text", "Pregunta", "", true, `{invalid`}}},
	}
	if err := seedCanonicalSurveyTemplatesForAccount(ctx, db, rollbackAccount.String(), brokenDefinitions); err == nil {
		t.Fatal("broken survey seed unexpectedly committed")
	}
	var rolledBackTemplates int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_templates WHERE account_id=$1`, rollbackAccount).Scan(&rolledBackTemplates); err != nil {
		t.Fatal(err)
	}
	if rolledBackTemplates != 0 {
		t.Fatalf("failed survey seed left %d partial templates", rolledBackTemplates)
	}

	// Historical built-in slugs remain compatible. If an old response-free
	// public row was left partial, attach it and complete its snapshot without
	// changing its slug or active status.
	legacySeedAccount, legacySeedSurvey := uuid.New(), uuid.New()
	legacySlug := "tpl-motivaciones-" + legacySeedAccount.String()[:8]
	if _, err := db.Exec(ctx, `INSERT INTO accounts (id,name) VALUES ($1,'Legacy seed repair')`, legacySeedAccount); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO surveys (id,account_id,name,slug,status,is_template)
		VALUES ($1,$2,'Motivaciones parcial',$3,'active',TRUE)
	`, legacySeedSurvey, legacySeedAccount, legacySlug); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO survey_questions (survey_id,order_index,type,title,config) VALUES ($1,0,'short_text','Parcial','{}')`, legacySeedSurvey); err != nil {
		t.Fatal(err)
	}
	if err := SeedTemplateSurveysForAccount(db, legacySeedAccount.String()); err != nil {
		t.Fatalf("repair historical built-in seed: %v", err)
	}
	var legacyQuestionCount int
	var legacyStatus, preservedSlug string
	var linkedLegacyTemplate uuid.UUID
	if err := db.QueryRow(ctx, `SELECT status,slug,template_id FROM surveys WHERE account_id=$1 AND id=$2`, legacySeedAccount, legacySeedSurvey).Scan(&legacyStatus, &preservedSlug, &linkedLegacyTemplate); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM survey_questions WHERE survey_id=$1`, legacySeedSurvey).Scan(&legacyQuestionCount); err != nil {
		t.Fatal(err)
	}
	if legacyStatus != "active" || preservedSlug != legacySlug || linkedLegacyTemplate == uuid.Nil || legacyQuestionCount != 8 {
		t.Fatalf("legacy partial repair changed compatibility: status=%q slug=%q template=%s questions=%d",
			legacyStatus, preservedSlug, linkedLegacyTemplate, legacyQuestionCount)
	}
}
