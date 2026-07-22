package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestBuildSurveyExportDataKeepsStableQuestionColumnsAndEmptyResponses(t *testing.T) {
	firstQuestionID := uuid.New()
	secondQuestionID := uuid.New()
	responseWithAnswersID := uuid.New()
	emptyResponseID := uuid.New()
	contactID := uuid.New()
	participantID := uuid.New()
	completedAt := time.Date(2026, 7, 22, 16, 30, 0, 0, time.FixedZone("PET", -5*60*60))
	answerOne := "Primera respuesta"
	answerTwo := "Segunda respuesta"

	questions := []*domain.SurveyQuestion{
		{ID: firstQuestionID, OrderIndex: 0, Title: "Título repetido"},
		{ID: secondQuestionID, OrderIndex: 1, Title: "Título repetido"},
	}
	records := []surveyExportRecord{
		{
			ResponseID: responseWithAnswersID, ContactID: &contactID,
			ProgramParticipantID: &participantID, ContactName: "Ana", ContactPhone: "51999999999",
			Token: "token-1", Source: "direct", StartedAt: completedAt.Add(-time.Minute),
			CompletedAt: &completedAt, QuestionID: &firstQuestionID, Value: &answerOne,
		},
		{
			ResponseID: responseWithAnswersID, ContactID: &contactID,
			ProgramParticipantID: &participantID, ContactName: "Ana", ContactPhone: "51999999999",
			Token: "token-1", Source: "direct", StartedAt: completedAt.Add(-time.Minute),
			CompletedAt: &completedAt, QuestionID: &secondQuestionID, Value: &answerTwo,
		},
		{
			ResponseID: emptyResponseID, Token: "token-2", Source: "qr",
			StartedAt: completedAt, CompletedAt: &completedAt,
		},
	}

	data := buildSurveyExportData(true, questions, records)
	if len(data.Rows) != 2 {
		t.Fatalf("expected the response without answers to be retained, got %d rows", len(data.Rows))
	}
	if got, want := len(data.Headers), 11; got != want {
		t.Fatalf("expected %d headers, got %d: %#v", want, got, data.Headers)
	}
	firstHeader := data.Headers[len(data.Headers)-2]
	secondHeader := data.Headers[len(data.Headers)-1]
	if firstHeader == secondHeader {
		t.Fatalf("duplicate question titles collided: %q", firstHeader)
	}
	if !strings.Contains(firstHeader, firstQuestionID.String()) || !strings.Contains(secondHeader, secondQuestionID.String()) {
		t.Fatalf("question headers must contain stable IDs: %#v", data.Headers)
	}
	if got := data.Rows[0][len(data.Headers)-2]; got != answerOne {
		t.Fatalf("first answer moved out of question order: %q", got)
	}
	if got := data.Rows[0][len(data.Headers)-1]; got != answerTwo {
		t.Fatalf("second answer moved out of question order: %q", got)
	}
	if got := data.Rows[1][0]; got != emptyResponseID.String() {
		t.Fatalf("response order was not preserved: %q", got)
	}
}

func TestBuildSurveyExportDataKeepsPublicResponsesAnonymous(t *testing.T) {
	contactID := uuid.New()
	participantID := uuid.New()
	responseID := uuid.New()
	now := time.Now()

	data := buildSurveyExportData(false, nil, []surveyExportRecord{{
		ResponseID: responseID, ContactID: &contactID, ProgramParticipantID: &participantID,
		ContactName: "No debe salir", ContactPhone: "51999999999", Token: "anon-token",
		Source: "direct", StartedAt: now, CompletedAt: &now,
	}})

	joinedHeaders := strings.Join(data.Headers, ",")
	for _, forbidden := range []string{"contact_id", "program_participant_id", "nombre", "telefono"} {
		if strings.Contains(joinedHeaders, forbidden) {
			t.Fatalf("public export exposed identity header %q: %s", forbidden, joinedHeaders)
		}
	}
	joinedRow := strings.Join(data.Rows[0], ",")
	if strings.Contains(joinedRow, contactID.String()) || strings.Contains(joinedRow, participantID.String()) || strings.Contains(joinedRow, "No debe salir") || strings.Contains(joinedRow, "51999999999") {
		t.Fatalf("public export exposed participant identity: %s", joinedRow)
	}
}
