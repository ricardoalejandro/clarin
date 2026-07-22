package service

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func surveyQuestion(id uuid.UUID, questionType string, required bool, config domain.SurveyQuestionConfig) *domain.SurveyQuestion {
	return &domain.SurveyQuestion{ID: id, Type: questionType, Title: "Pregunta", Required: required, Config: config}
}

func TestValidateSurveyAnswersRejectsForeignAndMissingRequiredQuestions(t *testing.T) {
	questionID := uuid.New()
	questions := []*domain.SurveyQuestion{surveyQuestion(questionID, "short_text", true, domain.SurveyQuestionConfig{})}
	if err := ValidateSurveyAnswers(questions, []domain.SurveyAnswer{{QuestionID: uuid.New(), Value: "respuesta"}}); err == nil {
		t.Fatal("foreign question id must be rejected")
	}
	if err := ValidateSurveyAnswers(questions, nil); err == nil {
		t.Fatal("missing required answer must be rejected")
	}
}

func TestValidateSurveyAnswersRejectsDuplicateAndInvalidChoices(t *testing.T) {
	questionID := uuid.New()
	questions := []*domain.SurveyQuestion{surveyQuestion(questionID, "single_choice", true, domain.SurveyQuestionConfig{Options: []string{"Sí", "No"}})}
	if err := ValidateSurveyAnswers(questions, []domain.SurveyAnswer{
		{QuestionID: questionID, Value: "Sí"},
		{QuestionID: questionID, Value: "No"},
	}); err == nil {
		t.Fatal("duplicate answers must be rejected")
	}
	if err := ValidateSurveyAnswers(questions, []domain.SurveyAnswer{{QuestionID: questionID, Value: "Tal vez"}}); err == nil {
		t.Fatal("choice outside the snapshot must be rejected")
	}
}

func TestValidateSurveyAnswersAcceptsValidSnapshotPayload(t *testing.T) {
	choiceID, ratingID, optionalID := uuid.New(), uuid.New(), uuid.New()
	questions := []*domain.SurveyQuestion{
		surveyQuestion(choiceID, "multiple_choice", true, domain.SurveyQuestionConfig{Options: []string{"A", "B", "C"}}),
		surveyQuestion(ratingID, "rating", true, domain.SurveyQuestionConfig{MaxRating: 5}),
		surveyQuestion(optionalID, "long_text", false, domain.SurveyQuestionConfig{}),
	}
	answers := []domain.SurveyAnswer{
		{QuestionID: choiceID, Value: `["A","C"]`},
		{QuestionID: ratingID, Value: "4"},
	}
	if err := ValidateSurveyAnswers(questions, answers); err != nil {
		t.Fatalf("valid answers were rejected: %v", err)
	}
}

func TestValidateSurveyAnswersRequiresOwnedUploadReference(t *testing.T) {
	questionID := uuid.New()
	uploadID := uuid.New()
	questions := []*domain.SurveyQuestion{surveyQuestion(questionID, "file_upload", true, domain.SurveyQuestionConfig{})}
	if err := ValidateSurveyAnswers(questions, []domain.SurveyAnswer{{QuestionID: questionID, FileURL: "https://attacker.invalid/file"}}); err == nil {
		t.Fatal("an arbitrary file URL must not be accepted")
	}
	if err := ValidateSurveyAnswers(questions, []domain.SurveyAnswer{{QuestionID: questionID, UploadID: &uploadID}}); err != nil {
		t.Fatalf("a staged upload reference was rejected before ownership validation: %v", err)
	}
	textQuestionID := uuid.New()
	if err := ValidateSurveyAnswers(
		[]*domain.SurveyQuestion{surveyQuestion(textQuestionID, "short_text", false, domain.SurveyQuestionConfig{})},
		[]domain.SurveyAnswer{{QuestionID: textQuestionID, Value: "texto", UploadID: &uploadID}},
	); err == nil {
		t.Fatal("an upload attached to a non-file question must be rejected")
	}
}

func TestValidateSurveyAnswersAllowsSubmissionWhenReachedRouteSkipsRequiredQuestion(t *testing.T) {
	firstID, skippedID, finalID := uuid.New(), uuid.New(), uuid.New()
	questions := []*domain.SurveyQuestion{
		{
			ID:       firstID,
			Type:     "single_choice",
			Title:    "¿Desea saltar?",
			Required: true,
			Config:   domain.SurveyQuestionConfig{Options: []string{"Sí", "No"}},
			LogicRules: []domain.SurveyLogicRule{{
				Value: "Sí", Operator: "eq", JumpTo: finalID,
			}},
		},
		{ID: skippedID, Type: "short_text", Title: "Pregunta omitida", Required: true},
		{ID: finalID, Type: "short_text", Title: "Pregunta final", Required: true},
	}
	answers := []domain.SurveyAnswer{
		{QuestionID: firstID, Value: "Sí"},
		{QuestionID: finalID, Value: "Listo"},
	}
	if err := ValidateSurveyAnswers(questions, answers); err != nil {
		t.Fatalf("a required question skipped by the reached route must not block submission: %v", err)
	}
	if err := ValidateSurveyAnswers(questions, answers[:1]); err == nil {
		t.Fatal("the reached required destination must still be enforced")
	}
}

func TestValidateSurveyLogicOnlyAllowsForwardAcyclicJumps(t *testing.T) {
	firstID, secondID, thirdID := uuid.New(), uuid.New(), uuid.New()
	if err := validateForwardSurveyLogic(
		[]uuid.UUID{firstID, secondID, thirdID},
		[][]domain.SurveyLogicRule{{{Value: "Sí", JumpTo: thirdID}}, nil, nil},
	); err != nil {
		t.Fatalf("a forward jump must be accepted: %v", err)
	}
	if err := validateForwardSurveyLogic(
		[]uuid.UUID{firstID, secondID, thirdID},
		[][]domain.SurveyLogicRule{nil, {{Value: "Atrás", JumpTo: firstID}}, nil},
	); err == nil {
		t.Fatal("a backward jump that can form a cycle must be rejected")
	}
	if err := validateForwardSurveyLogic(
		[]uuid.UUID{firstID, secondID},
		[][]domain.SurveyLogicRule{{{Value: "Fuera", JumpTo: thirdID}}, nil},
	); err == nil {
		t.Fatal("a jump outside the questionnaire must be rejected")
	}
}

func TestValidateTemplateQuestionsRequiresUsableOptionsAndScales(t *testing.T) {
	if err := validateTemplateQuestions([]domain.SurveyTemplateQuestion{{Type: "single_choice", Title: "Elige", Config: domain.SurveyQuestionConfig{Options: []string{"Solo una"}}}}); err == nil {
		t.Fatal("single-choice question with one option must be rejected")
	}
	if err := validateTemplateQuestions([]domain.SurveyTemplateQuestion{{Type: "rating", Title: "Califica", Config: domain.SurveyQuestionConfig{MaxRating: 11}}}); err == nil {
		t.Fatal("rating greater than ten must be rejected")
	}
}

func TestPublishedSurveyInstancesAreImmutable(t *testing.T) {
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "active"}, 0); err == nil {
		t.Fatal("a published canonical instance must be immutable even without responses")
	}
	templateID := uuid.New()
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "draft", TemplateID: &templateID}, 0); err == nil {
		t.Fatal("a canonical draft linked to a template must be immutable")
	}
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "draft"}, 1); err == nil {
		t.Fatal("a draft instance with a response must be immutable")
	}
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "draft"}, 0); err != nil {
		t.Fatalf("a response-free raw compatibility draft should remain editable: %v", err)
	}
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "active", TemplateID: &templateID, LegacyInstance: true}, 0); err == nil {
		t.Fatal("an active legacy row without responses must be immutable")
	}
	if err := validateSurveyQuestionMutation(&domain.Survey{Status: "draft", TemplateID: &templateID, LegacyInstance: true}, 0); err != nil {
		t.Fatalf("a response-free legacy draft should preserve compatibility: %v", err)
	}
}

func TestRawSurveyCreationAndDuplicationAreDisabledInService(t *testing.T) {
	svc := &SurveyService{}
	if err := svc.CreateSurvey(context.Background(), &domain.Survey{Name: "Cruda"}); !errors.Is(err, repository.ErrRawSurveyMutationDisabled) {
		t.Fatalf("raw survey creation error=%v", err)
	}
	if _, err := svc.DuplicateSurvey(context.Background(), uuid.New(), uuid.New()); !errors.Is(err, repository.ErrRawSurveyMutationDisabled) {
		t.Fatalf("raw survey duplication error=%v", err)
	}
}

func TestPublishedSurveyStatusNeverReturnsToDraft(t *testing.T) {
	for _, current := range []string{"active", "closed"} {
		if err := validateSurveyStatusTransition(current, "draft"); err == nil {
			t.Fatalf("%s application returned to draft", current)
		}
	}
	if err := validateSurveyStatusTransition("draft", "active"); err != nil {
		t.Fatalf("publishing a draft was rejected: %v", err)
	}
	if err := validateSurveyStatusTransition("closed", "active"); err != nil {
		t.Fatalf("reopening without mutating the snapshot was rejected: %v", err)
	}
}

func TestPublishedCanonicalSurveyPresentationIsImmutable(t *testing.T) {
	templateID := uuid.New()
	current := &domain.Survey{
		Status:             "active",
		Name:               "Aplicación v1",
		Description:        "Descripción congelada",
		Slug:               "aplicacion-v1",
		WelcomeTitle:       "Bienvenida",
		ThankYouTitle:      "Gracias",
		Branding:           domain.SurveyBranding{AccentColor: "#10b981"},
		LegacyInstance:     false,
		TemplateID:         &templateID,
		TemplateRevision:   1,
		WelcomeDescription: "Texto",
	}
	unchanged := *current
	unchanged.Status = "closed"
	if err := validateSurveyPresentationMutation(current, &unchanged); err != nil {
		t.Fatalf("closing an unchanged snapshot was rejected: %v", err)
	}

	changed := unchanged
	changed.Branding.AccentColor = "#f59e0b"
	if err := validateSurveyPresentationMutation(current, &changed); err == nil {
		t.Fatal("published canonical branding mutation was accepted")
	}

	legacy := *current
	legacy.LegacyInstance = true
	if err := validateSurveyPresentationMutation(&legacy, &changed); err == nil {
		t.Fatal("active legacy presentation mutation was accepted")
	}

	legacyDraft := legacy
	legacyDraft.Status = "draft"
	changedLegacyDraft := legacyDraft
	changedLegacyDraft.Name = "Compatibilidad legacy"
	if err := validateSurveyPresentationMutation(&legacyDraft, &changedLegacyDraft); err != nil {
		t.Fatalf("legacy draft presentation compatibility was rejected: %v", err)
	}

	canonicalDraft := *current
	canonicalDraft.Status = "draft"
	changedDraft := canonicalDraft
	changedDraft.Name = "Mutación de borrador"
	if err := validateSurveyPresentationMutation(&canonicalDraft, &changedDraft); err == nil {
		t.Fatal("canonical draft presentation mutation was accepted")
	}

	rawDraft := canonicalDraft
	rawDraft.TemplateID = nil
	changedRawDraft := rawDraft
	changedRawDraft.Name = "Compatibilidad"
	if err := validateSurveyPresentationMutation(&rawDraft, &changedRawDraft); err != nil {
		t.Fatalf("raw compatibility draft presentation mutation was rejected: %v", err)
	}
}
