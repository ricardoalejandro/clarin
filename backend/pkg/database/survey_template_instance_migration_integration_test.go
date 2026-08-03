package database

import (
	"bytes"
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
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
	actorA := uuid.New()
	surveyA, surveyB := uuid.New(), uuid.New()
	questionA, questionB := uuid.New(), uuid.New()
	responseA, responseB := uuid.New(), uuid.New()
	answerA, answerB := uuid.New(), uuid.New()
	fixtures := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts (id,name) VALUES ($1,'Encuestas A'),($2,'Encuestas B')`, []any{accountA, accountB}},
		{`INSERT INTO users(id,account_id,username,email,password_hash) VALUES($1,$2,$3,$4,'test')`, []any{actorA, accountA, "survey-a-" + actorA.String(), actorA.String() + "@test.invalid"}},
		{`INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,TRUE)`, []any{actorA, accountA}},
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
	deletedAccountID, historicalSurveyID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Cuenta de retiro de enlace')`, deletedAccountID); err != nil {
		t.Fatalf("seed disposable deleted account: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_public_slug_reservations(slug,owner_account_id,survey_id)
		VALUES ('enlace-de-cuenta-eliminada',$1,$2)
	`, deletedAccountID, historicalSurveyID); err != nil {
		t.Fatalf("reserve historical deleted-account slug: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM accounts WHERE id=$1`, deletedAccountID); err != nil {
		t.Fatalf("delete disposable account: %v", err)
	}
	var historicalReservationCount int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*) FROM survey_public_slug_reservations
		WHERE slug='enlace-de-cuenta-eliminada' AND owner_account_id=$1 AND survey_id=$2
	`, deletedAccountID, historicalSurveyID).Scan(&historicalReservationCount); err != nil || historicalReservationCount != 1 {
		t.Fatalf("account deletion released its historical public link: count=%d error=%v", historicalReservationCount, err)
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
	if legacySnapshot.CanDelete || !legacySnapshot.CanArchive || legacySnapshot.CanRestore {
		t.Fatalf("migrated legacy application cannot be preserved reversibly: %#v", legacySnapshot)
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
	trackedToken, abandonedToken := uuid.New(), uuid.New()
	for _, event := range []domain.SurveySessionEvent{
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: trackedToken, Phase: domain.SurveySessionOpened, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: trackedToken, Phase: domain.SurveySessionOpened, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: trackedToken, Phase: domain.SurveySessionStarted, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: trackedToken, Phase: domain.SurveySessionReached, QuestionID: &questionA, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: trackedToken, Phase: domain.SurveySessionAnswered, QuestionID: &questionA, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: abandonedToken, Phase: domain.SurveySessionOpened, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: abandonedToken, Phase: domain.SurveySessionStarted, Source: "direct"},
		{AccountID: accountA, SurveyID: surveyA, RespondentToken: abandonedToken, Phase: domain.SurveySessionReached, QuestionID: &questionA, Source: "direct"},
	} {
		if err := repos.Survey.TrackSession(ctx, event); err != nil {
			t.Fatalf("track survey session event %#v: %v", event, err)
		}
	}
	now := time.Now()
	trackedResponse := &domain.SurveyResponse{SurveyID: surveyA, AccountID: accountA, RespondentToken: trackedToken.String(), Source: "direct", StartedAt: now.Add(-time.Minute), CompletedAt: &now}
	if err := repos.Survey.CreateResponse(ctx, trackedResponse, []domain.SurveyAnswer{{QuestionID: questionA, Value: "Sí"}}); err != nil {
		t.Fatalf("complete tracked response: %v", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE survey_response_sessions SET last_activity_at=NOW()-INTERVAL '25 hours'
		WHERE account_id=$1 AND survey_id=$2 AND respondent_token=$3
	`, accountA, surveyA, abandonedToken); err != nil {
		t.Fatal(err)
	}
	analytics, err = repos.Survey.GetAnalytics(ctx, accountA, surveyA)
	if err != nil {
		t.Fatal(err)
	}
	if analytics.Funnel.OpenedCount != 2 || analytics.Funnel.StartedCount != 2 || analytics.Funnel.CompletedCount != 1 || analytics.Funnel.AbandonedCount != 1 {
		t.Fatalf("tracked funnel is not idempotent or accurate: %#v", analytics.Funnel)
	}
	if analytics.Funnel.StartToCompleteRate == nil || *analytics.Funnel.StartToCompleteRate != 50 {
		t.Fatalf("tracked completion rate=%v, want 50", analytics.Funnel.StartToCompleteRate)
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

	// A canonical template duplicate is an independent definition: it remaps
	// conditional destinations and never inherits applications or responses.
	duplicateSourceID, duplicateFirstID, duplicateSecondID := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_templates (id,account_id,name,status,measurement_config)
		VALUES ($1,$2,'Plantilla para copiar','archived','{"dimensions":[{"key":"impacto","name":"Impacto","minimum_answered_ratio":1}]}'::jsonb)
	`, duplicateSourceID, accountA); err != nil {
		t.Fatalf("seed duplicate template fixture: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_template_questions (id,account_id,template_id,order_index,type,title,config,logic_rules)
		VALUES ($3,$2,$1,0,'single_choice','Origen','{"options":["Sí","No"],"measurement":{"dimension_key":"impacto","weight":1,"option_scores":{"No":0,"Sí":100}}}'::jsonb,$5::jsonb),
		       ($4,$2,$1,1,'rating','Destino','{"max_rating":5,"measurement":{"dimension_key":"impacto","weight":1}}'::jsonb,'[]'::jsonb)
	`, duplicateSourceID, accountA, duplicateFirstID, duplicateSecondID,
		`[{"value":"Sí","operator":"eq","jump_to":"`+duplicateSecondID.String()+`"}]`); err != nil {
		t.Fatalf("seed duplicate template questions: %v", err)
	}
	copyTemplate, err := repos.SurveyTemplate.Duplicate(ctx, accountA, duplicateSourceID, "Copia independiente", nil)
	if err != nil {
		t.Fatalf("duplicate template: %v", err)
	}
	if copyTemplate.Status != "active" || copyTemplate.Revision != 1 || copyTemplate.QuestionCount != 2 || len(copyTemplate.MeasurementConfig.Dimensions) != 1 {
		t.Fatalf("unexpected duplicate summary: %#v", copyTemplate)
	}
	copiedQuestions, err := repos.SurveyTemplate.ListQuestions(ctx, accountA, copyTemplate.ID)
	if err != nil || len(copiedQuestions) != 2 {
		t.Fatalf("load copied questions: count=%d error=%v", len(copiedQuestions), err)
	}
	if copiedQuestions[0].ID == duplicateFirstID || copiedQuestions[1].ID == duplicateSecondID || len(copiedQuestions[0].LogicRules) != 1 || copiedQuestions[0].LogicRules[0].JumpTo != copiedQuestions[1].ID {
		t.Fatalf("duplicate did not remap question identity and logic: %#v", copiedQuestions)
	}
	var copiedApplications, copiedResponses int
	if err := db.QueryRow(ctx, `
		SELECT COUNT(*),COUNT(response.id)
		FROM surveys survey LEFT JOIN survey_responses response ON response.survey_id=survey.id
		WHERE survey.account_id=$1 AND survey.template_id=$2
	`, accountA, copyTemplate.ID).Scan(&copiedApplications, &copiedResponses); err != nil {
		t.Fatal(err)
	}
	if copiedApplications != 0 || copiedResponses != 0 {
		t.Fatalf("duplicate inherited applications=%d responses=%d", copiedApplications, copiedResponses)
	}
	measurementSignature := "integration-compatible-signature"
	createdApplication, err := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
		TemplateID: copyTemplate.ID, AccountID: accountA, Name: "Aplicación de copia",
		Slug: "aplicacion-de-copia", Status: "active", AudienceMode: "public",
		MeasurementConfig: copyTemplate.MeasurementConfig, MeasurementSignature: measurementSignature,
	})
	if err != nil {
		t.Fatalf("create immutable application snapshot: %v", err)
	}
	if createdApplication.MeasurementSignature != measurementSignature || createdApplication.AnalyticsTrackingStartedAt.IsZero() {
		t.Fatalf("application did not freeze measurement/tracking metadata: %#v", createdApplication)
	}
	if !createdApplication.CanDelete || !createdApplication.CanArchive || createdApplication.CanRestore {
		t.Fatalf("new application returned stale lifecycle capabilities: %#v", createdApplication)
	}
	applicationQuestions, err := repos.Survey.GetQuestionsScoped(ctx, accountA, createdApplication.ID)
	if err != nil || len(applicationQuestions) != 2 || applicationQuestions[0].ID == copiedQuestions[0].ID {
		t.Fatalf("application did not freeze independent question identities: count=%d error=%v", len(applicationQuestions), err)
	}
	if _, err := repos.Survey.ListTextAnswers(ctx, accountA, createdApplication.ID, applicationQuestions[0].ID, 25, nil, nil); !errors.Is(err, repository.ErrSurveyQuestionNotText) {
		t.Fatalf("non-text question accepted by text answers endpoint: %v", err)
	}

	// Global slug reservation is the serialization point. Two accounts may ask
	// for the same friendly URL concurrently; both creations succeed, but only
	// one receives the exact value and the other receives a non-leaking suffix.
	type concurrentSlugResult struct {
		instance *domain.SurveyInstanceSummary
		err      error
	}
	concurrentResults := make(chan concurrentSlugResult, 2)
	surveyTemplateService := service.NewSurveyTemplateService(repos)
	for _, request := range []domain.CreateSurveyInstanceInput{
		{TemplateID: copyTemplate.ID, AccountID: accountA, Name: "Colisión global A", Slug: "enlace-global-concurrente", Status: "active", AudienceMode: "public"},
		{TemplateID: templateB, AccountID: accountB, Name: "Colisión global B", Slug: "enlace-global-concurrente", Status: "active", AudienceMode: "public"},
	} {
		request := request
		go func() {
			instance, createErr := surveyTemplateService.CreateInstance(ctx, request)
			concurrentResults <- concurrentSlugResult{instance: instance, err: createErr}
		}()
	}
	exactSlugCount := 0
	for range 2 {
		result := <-concurrentResults
		if result.err != nil || result.instance == nil {
			t.Fatalf("concurrent global slug creation failed: %#v", result)
		}
		if result.instance.Slug == "enlace-global-concurrente" {
			exactSlugCount++
		} else if !strings.HasPrefix(result.instance.Slug, "enlace-global-concurrente-") {
			t.Fatalf("unexpected concurrent slug variant: %q", result.instance.Slug)
		}
	}
	if exactSlugCount != 1 {
		t.Fatalf("exact public slug owners=%d, want 1", exactSlugCount)
	}

	// Application archive/restore is reversible but never reopens implicitly.
	lifecycleApplication, err := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
		TemplateID: canonicalTemplateID, AccountID: accountA, Name: "Aplicación para archivar",
		Slug: "aplicacion-para-archivar", Status: "active", AudienceMode: "public",
	})
	if err != nil {
		t.Fatalf("create lifecycle application: %v", err)
	}
	if err := repos.Survey.Archive(ctx, accountA, lifecycleApplication.ID, actorA); err != nil {
		t.Fatalf("archive lifecycle application: %v", err)
	}
	archivedApplication, err := repos.Survey.GetByID(ctx, lifecycleApplication.ID, accountA)
	if err != nil || archivedApplication.ArchivedAt == nil || archivedApplication.ArchivedBy == nil || *archivedApplication.ArchivedBy != actorA || archivedApplication.ArchivedFromStatus != "active" || archivedApplication.Status != "closed" {
		t.Fatalf("archive did not retain source status and close application: %#v error=%v", archivedApplication, err)
	}
	var archivedWorkbook bytes.Buffer
	if filename, exportErr := service.NewSurveyService(repos).WriteSurveyResultsXLSX(
		ctx, accountA, lifecycleApplication.ID, service.SurveyXLSXExportRequest{}, &archivedWorkbook,
	); exportErr != nil || archivedWorkbook.Len() == 0 || !strings.HasSuffix(filename, ".xlsx") {
		t.Fatalf("archived zero-response application did not export: filename=%q bytes=%d error=%v", filename, archivedWorkbook.Len(), exportErr)
	}
	if _, exportErr := service.NewSurveyService(repos).WriteSurveyResultsXLSX(
		ctx, accountB, lifecycleApplication.ID, service.SurveyXLSXExportRequest{}, &bytes.Buffer{},
	); !errors.Is(exportErr, pgx.ErrNoRows) {
		t.Fatalf("cross-account XLSX export error=%v", exportErr)
	}
	if _, exportErr := service.NewSurveyService(repos).WriteSurveyResultsXLSX(
		ctx, accountA, canonicalTemplateID, service.SurveyXLSXExportRequest{}, &bytes.Buffer{},
	); !errors.Is(exportErr, service.ErrSurveyApplicationRequired) {
		t.Fatalf("template XLSX export error=%v", exportErr)
	}
	activeApplications, err := repos.SurveyTemplate.ListTemplateInstances(ctx, accountA, canonicalTemplateID, false)
	if err != nil {
		t.Fatal(err)
	}
	for _, application := range activeApplications {
		if application.ID == lifecycleApplication.ID {
			t.Fatal("archived application leaked into the active-only list")
		}
	}
	allApplications, err := repos.SurveyTemplate.ListTemplateInstances(ctx, accountA, canonicalTemplateID, true)
	if err != nil {
		t.Fatal(err)
	}
	var foundArchived bool
	for _, application := range allApplications {
		foundArchived = foundArchived || application.ID == lifecycleApplication.ID && application.ArchivedAt != nil
	}
	if !foundArchived {
		t.Fatal("archived application was absent from the explicit history list")
	}
	if err := repos.Survey.Restore(ctx, accountA, lifecycleApplication.ID); err != nil {
		t.Fatalf("restore lifecycle application: %v", err)
	}
	restoredApplication, err := repos.Survey.GetByID(ctx, lifecycleApplication.ID, accountA)
	if err != nil || restoredApplication.ArchivedAt != nil || restoredApplication.ArchivedFromStatus != "" || restoredApplication.Status != "closed" {
		t.Fatalf("restore reopened or retained archive metadata: %#v error=%v", restoredApplication, err)
	}
	if err := repos.Survey.Delete(ctx, lifecycleApplication.ID, accountB); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("cross-account delete error=%v", err)
	}
	// A frozen recipient that remains pending is audience metadata, not an
	// interaction. Even when it already has an invitation timestamp it must not
	// force an otherwise untouched application into archival retention.
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_instance_recipients (account_id,survey_id,status,invited_at)
		VALUES ($1,$2,'pending',NOW())
	`, accountA, lifecycleApplication.ID); err != nil {
		t.Fatalf("seed pending frozen recipient: %v", err)
	}
	if err := repos.Survey.Delete(ctx, lifecycleApplication.ID, accountA); err != nil {
		t.Fatalf("delete empty canonical application: %v", err)
	}
	if _, err := repos.Survey.GetBySlug(ctx, lifecycleApplication.Slug); !errors.Is(err, repository.ErrSurveyLinkRetired) {
		t.Fatalf("deleted public link did not become a permanent 410 tombstone: %v", err)
	}
	retiredUnavailable, err := repos.Survey.SlugExists(ctx, lifecycleApplication.Slug, nil)
	if err != nil || !retiredUnavailable {
		t.Fatalf("retired public link became available: exists=%t error=%v", retiredUnavailable, err)
	}
	replacement, err := service.NewSurveyTemplateService(repos).CreateInstance(ctx, domain.CreateSurveyInstanceInput{
		TemplateID: canonicalTemplateID, AccountID: accountA, Name: "Aplicación posterior al retiro",
		Slug: lifecycleApplication.Slug, Status: "active", AudienceMode: "public",
	})
	if err != nil {
		t.Fatalf("create safe replacement after retired link: %v", err)
	}
	if replacement.Slug == lifecycleApplication.Slug || !strings.HasPrefix(replacement.Slug, lifecycleApplication.Slug+"-") {
		t.Fatalf("retired slug was reused instead of receiving a suffix: %q", replacement.Slug)
	}

	createLifecycleApplication := func(name, slug string) *domain.SurveyInstanceSummary {
		t.Helper()
		application, createErr := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
			TemplateID: canonicalTemplateID, AccountID: accountA, Name: name,
			Slug: slug, Status: "active", AudienceMode: "public",
		})
		if createErr != nil {
			t.Fatalf("create %s: %v", name, createErr)
		}
		return application
	}
	activityApplication := createLifecycleApplication("Aplicación con apertura", "aplicacion-con-apertura")
	if err := repos.Survey.TrackSession(ctx, domain.SurveySessionEvent{
		AccountID: accountA, SurveyID: activityApplication.ID, RespondentToken: uuid.New(),
		Phase: domain.SurveySessionOpened, Source: "direct",
	}); err != nil {
		t.Fatalf("track lifecycle opening: %v", err)
	}
	if err := repos.Survey.Delete(ctx, activityApplication.ID, accountA); !errors.Is(err, repository.ErrSurveyDeleteHasActivity) {
		t.Fatalf("application with opening delete error=%v", err)
	}

	recipientApplication := createLifecycleApplication("Aplicación con destinatario abierto", "aplicacion-destinatario-abierto")
	recipientID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_instance_recipients (id,account_id,survey_id,status)
		VALUES ($1,$2,$3,'pending')
	`, recipientID, accountA, recipientApplication.ID); err != nil {
		t.Fatalf("seed lifecycle recipient: %v", err)
	}
	if err := repos.SurveyTemplate.MarkRecipientOpened(ctx, recipientID, accountA); err != nil {
		t.Fatalf("mark lifecycle recipient opened: %v", err)
	}
	if err := repos.Survey.Delete(ctx, recipientApplication.ID, accountA); !errors.Is(err, repository.ErrSurveyDeleteHasActivity) {
		t.Fatalf("application with recipient opening delete error=%v", err)
	}

	archivedRaceApplication := createLifecycleApplication("Aplicación archivada antes de abrir", "archivada-antes-de-abrir")
	archivedRecipientID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_instance_recipients (id,account_id,survey_id,status)
		VALUES ($1,$2,$3,'pending')
	`, archivedRecipientID, accountA, archivedRaceApplication.ID); err != nil {
		t.Fatalf("seed archived lifecycle recipient: %v", err)
	}
	if err := repos.Survey.Archive(ctx, accountA, archivedRaceApplication.ID, actorA); err != nil {
		t.Fatalf("archive before recipient opening: %v", err)
	}
	if err := repos.Survey.TrackSession(ctx, domain.SurveySessionEvent{
		AccountID: accountA, SurveyID: archivedRaceApplication.ID, RecipientID: &archivedRecipientID,
		RespondentToken: uuid.New(), Phase: domain.SurveySessionOpened, Source: "direct",
	}); !errors.Is(err, repository.ErrSurveyArchived) {
		t.Fatalf("session opening after archive error=%v", err)
	}
	if err := repos.SurveyTemplate.MarkRecipientOpened(ctx, archivedRecipientID, accountA); !errors.Is(err, repository.ErrSurveyArchived) {
		t.Fatalf("recipient opening after archive error=%v", err)
	}
	archivedQuestions, err := repos.Survey.GetQuestionsScoped(ctx, accountA, archivedRaceApplication.ID)
	if err != nil || len(archivedQuestions) != 1 {
		t.Fatalf("load archived lifecycle question: count=%d error=%v", len(archivedQuestions), err)
	}
	archivedResponseAt := time.Now()
	archivedResponse := &domain.SurveyResponse{
		SurveyID: archivedRaceApplication.ID, AccountID: accountA, RespondentToken: uuid.NewString(),
		Source: "direct", StartedAt: archivedResponseAt.Add(-time.Minute), CompletedAt: &archivedResponseAt,
	}
	if err := repos.Survey.CreateResponse(ctx, archivedResponse, []domain.SurveyAnswer{{QuestionID: archivedQuestions[0].ID, Value: "No debe guardarse"}}); !errors.Is(err, repository.ErrSurveyArchived) {
		t.Fatalf("response after archive error=%v", err)
	}
	var archivedRecipientStatus string
	var archivedRecipientOpenedAt *time.Time
	if err := db.QueryRow(ctx, `
		SELECT status,opened_at FROM survey_instance_recipients
		WHERE account_id=$1 AND survey_id=$2 AND id=$3
	`, accountA, archivedRaceApplication.ID, archivedRecipientID).Scan(&archivedRecipientStatus, &archivedRecipientOpenedAt); err != nil {
		t.Fatal(err)
	}
	if archivedRecipientStatus != "pending" || archivedRecipientOpenedAt != nil {
		t.Fatalf("archived recipient was mutated: status=%q opened_at=%v", archivedRecipientStatus, archivedRecipientOpenedAt)
	}

	uploadApplication := createLifecycleApplication("Aplicación con archivo", "aplicacion-con-archivo")
	uploadQuestions, err := repos.Survey.GetQuestionsScoped(ctx, accountA, uploadApplication.ID)
	if err != nil || len(uploadQuestions) != 1 {
		t.Fatalf("load upload lifecycle question: count=%d error=%v", len(uploadQuestions), err)
	}
	if _, err := db.Exec(ctx, `UPDATE survey_questions SET type='file_upload' WHERE survey_id=$1 AND id=$2`, uploadApplication.ID, uploadQuestions[0].ID); err != nil {
		t.Fatalf("prepare file question fixture: %v", err)
	}
	preparedUpload, err := repos.Survey.PrepareSurveyFileUpload(ctx, repository.PrepareSurveyFileUploadInput{
		AccountID: accountA, SurveyID: uploadApplication.ID, QuestionID: uploadQuestions[0].ID,
		RespondentToken: uuid.NewString(), ObjectKey: accountA.String() + "/survey-uploads/test",
		OriginalFilename: "evidencia.png", ContentType: "image/png", SizeBytes: 128,
		ContentHash: "integration-survey-upload", ExpiresAt: time.Now().Add(time.Hour),
	})
	if err != nil {
		t.Fatalf("prepare lifecycle upload: %v", err)
	}
	if err := repos.Survey.Delete(ctx, uploadApplication.ID, accountA); !errors.Is(err, repository.ErrSurveyDeleteHasUploads) {
		t.Fatalf("application with live upload delete error=%v", err)
	}
	if _, err := db.Exec(ctx, `
		UPDATE survey_file_uploads SET status='deleted',updated_at=NOW()
		WHERE account_id=$1 AND survey_id=$2 AND id=$3
	`, accountA, uploadApplication.ID, preparedUpload.ID); err != nil {
		t.Fatalf("mark lifecycle upload deleted: %v", err)
	}
	if err := repos.Survey.Delete(ctx, uploadApplication.ID, accountA); err != nil {
		t.Fatalf("deleted upload still blocked canonical deletion: %v", err)
	}
	incompleteApplication := createLifecycleApplication("Aplicación con respuesta incompleta", "aplicacion-respuesta-incompleta")
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_responses (survey_id,account_id,respondent_token,started_at,completed_at)
		VALUES ($1,$2,$3,NOW(),NULL)
	`, incompleteApplication.ID, accountA, uuid.NewString()); err != nil {
		t.Fatalf("seed incomplete lifecycle response: %v", err)
	}
	if err := repos.Survey.Delete(ctx, incompleteApplication.ID, accountA); !errors.Is(err, repository.ErrSurveyDeleteHasResponses) {
		t.Fatalf("application with incomplete response delete error=%v", err)
	}

	// Free-text inspection is completed-only, account-scoped and does not put
	// unbounded values into the analytics payload.
	textApplication, err := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
		TemplateID: canonicalTemplateID, AccountID: accountA, Name: "Aplicación de texto",
		Slug: "aplicacion-de-texto", Status: "active", AudienceMode: "public",
	})
	if err != nil {
		t.Fatalf("create text application: %v", err)
	}
	textQuestions, err := repos.Survey.GetQuestionsScoped(ctx, accountA, textApplication.ID)
	if err != nil || len(textQuestions) != 1 {
		t.Fatalf("load text application question: count=%d error=%v", len(textQuestions), err)
	}
	textCompletedAt := time.Now().UTC().Truncate(time.Microsecond)
	textResponse := &domain.SurveyResponse{SurveyID: textApplication.ID, AccountID: accountA, RespondentToken: uuid.NewString(), Source: "direct", StartedAt: textCompletedAt.Add(-time.Minute), CompletedAt: &textCompletedAt}
	if err := repos.Survey.CreateResponse(ctx, textResponse, []domain.SurveyAnswer{{QuestionID: textQuestions[0].ID, Value: "Primera línea\nSegunda línea"}}); err != nil {
		t.Fatalf("save text response: %v", err)
	}
	unicodeText := "Observación ágil — 你好 — 🙂\n" + strings.Repeat("detalle ", 120)
	secondTextResponse := &domain.SurveyResponse{SurveyID: textApplication.ID, AccountID: accountA, RespondentToken: uuid.NewString(), Source: "direct", StartedAt: textCompletedAt.Add(-time.Minute), CompletedAt: &textCompletedAt}
	if err := repos.Survey.CreateResponse(ctx, secondTextResponse, []domain.SurveyAnswer{{QuestionID: textQuestions[0].ID, Value: unicodeText}}); err != nil {
		t.Fatalf("save unicode text response: %v", err)
	}
	incompleteResponseID := uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_responses (id,survey_id,account_id,respondent_token,started_at,completed_at)
		VALUES ($1,$2,$3,$4,NOW(),NULL)
	`, incompleteResponseID, textApplication.ID, accountA, uuid.NewString()); err != nil {
		t.Fatalf("seed incomplete text response: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO survey_answers (response_id,survey_id,question_id,value)
		VALUES ($1,$2,$3,'No debe aparecer')
	`, incompleteResponseID, textApplication.ID, textQuestions[0].ID); err != nil {
		t.Fatalf("seed incomplete text answer: %v", err)
	}
	textService := service.NewSurveyService(repos)
	firstTextPage, err := textService.ListTextAnswers(ctx, accountA, textApplication.ID, textQuestions[0].ID, 1, "")
	if err != nil || firstTextPage.Total != 2 || len(firstTextPage.Items) != 1 || firstTextPage.NextCursor == "" || firstTextPage.Items[0].ContactName != "" {
		t.Fatalf("unexpected first text answer page: %#v error=%v", firstTextPage, err)
	}
	secondTextPage, err := textService.ListTextAnswers(ctx, accountA, textApplication.ID, textQuestions[0].ID, 1, firstTextPage.NextCursor)
	if err != nil || secondTextPage.Total != 2 || len(secondTextPage.Items) != 1 || secondTextPage.NextCursor != "" {
		t.Fatalf("unexpected second text answer page: %#v error=%v", secondTextPage, err)
	}
	if firstTextPage.Items[0].ResponseID == secondTextPage.Items[0].ResponseID {
		t.Fatal("text cursor repeated a response")
	}
	values := map[string]bool{firstTextPage.Items[0].Value: true, secondTextPage.Items[0].Value: true}
	if !values["Primera línea\nSegunda línea"] || !values[unicodeText] || values["No debe aparecer"] {
		t.Fatalf("text pagination lost or leaked values: %#v", values)
	}
	if _, err := repos.Survey.ListTextAnswers(ctx, accountB, textApplication.ID, textQuestions[0].ID, 25, nil, nil); !errors.Is(err, repository.ErrSurveyQuestionNotFound) {
		t.Fatalf("cross-account text answers error=%v", err)
	}
	if err := repos.Survey.Delete(ctx, textApplication.ID, accountA); !errors.Is(err, repository.ErrSurveyDeleteHasResponses) {
		t.Fatalf("application with response delete error=%v", err)
	}
	measurementContactID, measurementParticipantID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `
		INSERT INTO contacts (id,account_id,jid,phone,name) VALUES ($1,$2,$3,$4,'Participante de medición')
	`, measurementContactID, accountA, measurementContactID.String()+"@test", "51999990001"); err != nil {
		t.Fatalf("seed measurement contact: %v", err)
	}
	if _, err := db.Exec(ctx, `
		INSERT INTO program_participants (id,program_id,contact_id,status) VALUES ($1,$2,$3,'active')
	`, measurementParticipantID, programID, measurementContactID); err != nil {
		t.Fatalf("seed measurement participant: %v", err)
	}
	programTextApplication, err := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
		TemplateID: canonicalTemplateID, AccountID: accountA, ProgramID: &programID,
		Name: "Observaciones del programa", Slug: "observaciones-del-programa", Status: "active",
		AudienceMode: "program_participants",
	})
	if err != nil {
		t.Fatalf("create program text application: %v", err)
	}
	programTextQuestions, err := repos.Survey.GetQuestionsScoped(ctx, accountA, programTextApplication.ID)
	if err != nil || len(programTextQuestions) != 1 {
		t.Fatalf("load program text question: count=%d error=%v", len(programTextQuestions), err)
	}
	var programTextRecipientID uuid.UUID
	if err := db.QueryRow(ctx, `
		SELECT id FROM survey_instance_recipients
		WHERE account_id=$1 AND survey_id=$2 AND program_participant_id=$3
	`, accountA, programTextApplication.ID, measurementParticipantID).Scan(&programTextRecipientID); err != nil {
		t.Fatalf("load program text recipient: %v", err)
	}
	programTextCompletedAt := time.Now()
	programTextResponse := &domain.SurveyResponse{
		SurveyID: programTextApplication.ID, AccountID: accountA, RespondentToken: uuid.NewString(),
		RecipientID: &programTextRecipientID, ContactID: &measurementContactID, ProgramID: &programID,
		ProgramParticipantID: &measurementParticipantID, Source: "direct",
		StartedAt: programTextCompletedAt.Add(-time.Minute), CompletedAt: &programTextCompletedAt,
	}
	if err := repos.Survey.CreateResponse(ctx, programTextResponse, []domain.SurveyAnswer{{
		QuestionID: programTextQuestions[0].ID, Value: "Observación específica del programa",
	}}); err != nil {
		t.Fatalf("save program text response: %v", err)
	}
	programTextPage, err := service.NewSurveyService(repos).ListTextAnswers(
		ctx, accountA, programTextApplication.ID, programTextQuestions[0].ID, 25, "",
	)
	if err != nil || len(programTextPage.Items) != 1 || programTextPage.Items[0].ContactID == nil ||
		*programTextPage.Items[0].ContactID != measurementContactID || programTextPage.Items[0].ProgramParticipantID == nil ||
		*programTextPage.Items[0].ProgramParticipantID != measurementParticipantID || programTextPage.Items[0].ContactName != "Participante de medición" {
		t.Fatalf("program text identity is not participation-specific: %#v error=%v", programTextPage, err)
	}
	programApplications := make([]*domain.SurveyInstanceSummary, 0, 2)
	for index, name := range []string{"Medición inicial", "Medición final"} {
		application, createErr := repos.SurveyTemplate.CreateInstance(ctx, domain.CreateSurveyInstanceInput{
			TemplateID: copyTemplate.ID, AccountID: accountA, ProgramID: &programID,
			Name: name, Slug: "medicion-programa-" + string(rune('a'+index)), Status: "active",
			AudienceMode: "program_participants", MeasurementConfig: copyTemplate.MeasurementConfig,
			MeasurementSignature: measurementSignature,
		})
		if createErr != nil {
			t.Fatalf("create program measurement application %d: %v", index, createErr)
		}
		programApplications = append(programApplications, application)
		questions, loadErr := repos.Survey.GetQuestionsScoped(ctx, accountA, application.ID)
		if loadErr != nil || len(questions) != 2 {
			t.Fatalf("load program measurement questions: count=%d error=%v", len(questions), loadErr)
		}
		var recipientID uuid.UUID
		if err := db.QueryRow(ctx, `
			SELECT id FROM survey_instance_recipients
			WHERE account_id=$1 AND survey_id=$2 AND program_participant_id=$3
		`, accountA, application.ID, measurementParticipantID).Scan(&recipientID); err != nil {
			t.Fatalf("load frozen measurement recipient: %v", err)
		}
		completedAt := time.Now().Add(time.Duration(index) * time.Minute)
		response := &domain.SurveyResponse{
			SurveyID: application.ID, AccountID: accountA, RespondentToken: uuid.NewString(),
			RecipientID: &recipientID, ContactID: &measurementContactID, ProgramID: &programID,
			ProgramParticipantID: &measurementParticipantID, Source: "direct",
			StartedAt: completedAt.Add(-time.Minute), CompletedAt: &completedAt,
		}
		if err := repos.Survey.CreateResponse(ctx, response, []domain.SurveyAnswer{
			{QuestionID: questions[0].ID, Value: "No"},
			{QuestionID: questions[1].ID, Value: []string{"5", "4"}[index]},
		}); err != nil {
			t.Fatalf("save program measurement response: %v", err)
		}
	}
	series, err := repos.SurveyTemplate.GetProgramMeasurementSeries(
		ctx, accountA, programID, copyTemplate.ID, measurementSignature,
		&programApplications[0].ID, &programApplications[1].ID,
	)
	if err != nil {
		t.Fatalf("load compatible measurement series: %v", err)
	}
	if len(series.Applications) != 2 || len(series.Participants) != 2 || len(series.PairedChanges) != 1 || series.PairedChanges[0].SampleSize != 1 {
		t.Fatalf("unexpected compatible measurement series: %#v", series)
	}
	if _, err := repos.SurveyTemplate.Duplicate(ctx, accountB, duplicateSourceID, "Cruce", nil); !errors.Is(err, repository.ErrSurveyTemplateNotFound) {
		t.Fatalf("cross-account duplicate error=%v", err)
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
	// File reservations are now accepted only while an application is active.
	// Open this isolated fixture for the reservation and close it again before
	// exercising the merge so the test does not model an impossible public
	// upload against the closed immutable application.
	if _, err := db.Exec(ctx, `UPDATE surveys SET status='active' WHERE account_id=$1 AND id=$2`, accountA, canonicalSurveyID); err != nil {
		t.Fatalf("open contact-merge upload fixture: %v", err)
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
	if _, err := db.Exec(ctx, `UPDATE surveys SET status='closed' WHERE account_id=$1 AND id=$2`, accountA, canonicalSurveyID); err != nil {
		t.Fatalf("close contact-merge upload fixture: %v", err)
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
