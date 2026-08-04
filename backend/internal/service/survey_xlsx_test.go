package service

import (
	"archive/zip"
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/xuri/excelize/v2"
)

func TestWriteSurveyWorkbookProducesEditableInternalChartsAndSafeText(t *testing.T) {
	now := time.Date(2026, 8, 2, 4, 15, 0, 0, time.UTC)
	templateID := uuid.MustParse("10000000-0000-0000-0000-000000000001")
	surveyID := uuid.MustParse("20000000-0000-0000-0000-000000000001")
	choiceID := uuid.MustParse("30000000-0000-0000-0000-000000000001")
	textID := uuid.MustParse("30000000-0000-0000-0000-000000000002")
	ratingID := uuid.MustParse("30000000-0000-0000-0000-000000000003")
	formulaLikeText := "=SUM(A1:A2)\nLínea Unicode: ñ 日本語"
	average := 5.0
	completion := 75.0
	model := surveyWorkbookModel{
		Survey: &domain.Survey{
			ID: surveyID, TemplateID: &templateID, TemplateRevision: 4,
			Name: "Encuesta de prueba", Slug: "encuesta-prueba", Status: "active",
			OriginLabel: "Aplicación independiente", AudienceMode: "public", CreatedAt: now,
		},
		Questions: []*domain.SurveyQuestion{
			{ID: choiceID, SurveyID: surveyID, OrderIndex: 0, Type: "single_choice", Title: "Pregunta repetida", Config: domain.SurveyQuestionConfig{Options: []string{"Sí", "No"}}},
			{ID: textID, SurveyID: surveyID, OrderIndex: 1, Type: "long_text", Title: "Pregunta repetida"},
			{ID: ratingID, SurveyID: surveyID, OrderIndex: 2, Type: "rating", Title: "Valoración"},
		},
		Analytics: &domain.SurveyAnalytics{
			TotalResponses: 1, CompletionRate: &completion, AvgCompletionSec: floatPtr(42),
			Funnel: domain.SurveyFunnelAnalytics{OpenedCount: 2, StartedCount: 1, CompletedCount: 1, AbandonedCount: 0},
			QuestionStats: []domain.SurveyQuestionStats{
				{QuestionID: choiceID, QuestionType: "single_choice", Title: "Pregunta repetida", TotalAnswers: 1, OptionCounts: map[string]int{"Sí": 1, "No": 0}},
				{QuestionID: textID, QuestionType: "long_text", Title: "Pregunta repetida", TotalAnswers: 1},
				{QuestionID: ratingID, QuestionType: "rating", Title: "Valoración", TotalAnswers: 1, Average: &average, Distribution: map[string]int{"5": 1}},
			},
		},
		ChartTypes:  map[uuid.UUID]string{choiceID: "pie", textID: "bar", ratingID: "radar"},
		GeneratedAt: now,
	}
	responseID := uuid.MustParse("40000000-0000-0000-0000-000000000001")
	walkResponses := func(visit func(domain.SurveyReportResponse) error) error {
		return visit(domain.SurveyReportResponse{
			ResponseID: responseID, AnonymousIndex: 1, Source: "direct", StartedAt: now.Add(-time.Minute), CompletedAt: now,
			Answers: map[uuid.UUID]string{choiceID: "Sí", textID: formulaLikeText, ratingID: "5"},
		})
	}
	walkTexts := func(visit func(domain.SurveyReportTextAnswer) error) error {
		return visit(domain.SurveyReportTextAnswer{
			AnonymousIndex: 1, ResponseID: responseID, QuestionID: textID, QuestionTitle: "Pregunta repetida",
			QuestionType: "long_text", Value: formulaLikeText, CompletedAt: now,
		})
	}
	var output bytes.Buffer
	if err := writeSurveyWorkbook(model, &output, walkResponses, walkTexts); err != nil {
		t.Fatalf("write workbook: %v", err)
	}
	if outputPath := os.Getenv("CLARIN_XLSX_QA_OUTPUT"); outputPath != "" {
		if err := os.WriteFile(outputPath, output.Bytes(), 0o600); err != nil {
			t.Fatalf("write QA workbook: %v", err)
		}
	}

	workbook, err := excelize.OpenReader(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatalf("reopen workbook: %v", err)
	}
	defer workbook.Close()
	wantSheets := []string{"RESUMEN", "RESULTADOS", "RESPUESTAS", "DATOS_GRÁFICOS"}
	if got := workbook.GetSheetList(); strings.Join(got, "|") != strings.Join(wantSheets, "|") {
		t.Fatalf("unexpected sheets: %v", got)
	}
	visible, err := workbook.GetSheetVisible("DATOS_GRÁFICOS")
	if err != nil || visible {
		t.Fatalf("chart data sheet should be hidden, visible=%v err=%v", visible, err)
	}
	for _, cell := range []string{"F2"} {
		value, _ := workbook.GetCellValue("RESPUESTAS", cell)
		if value != formulaLikeText {
			t.Fatalf("response text changed: %q", value)
		}
		formula, _ := workbook.GetCellFormula("RESPUESTAS", cell)
		if formula != "" {
			t.Fatalf("formula-like response became a formula: %q", formula)
		}
	}
	textValue, _ := workbook.GetCellValue("RESULTADOS", "C27")
	if textValue != formulaLikeText {
		t.Fatalf("inline text table lost multiline/unicode content: %q", textValue)
	}
	textFormula, _ := workbook.GetCellFormula("RESULTADOS", "C27")
	if textFormula != "" {
		t.Fatalf("formula-like inline text became a formula: %q", textFormula)
	}
	if value, _ := workbook.GetCellValue("RESULTADOS", "B26"); value != "Respuesta" {
		t.Fatalf("missing inline text table header: %q", value)
	}

	archive, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
	if err != nil {
		t.Fatalf("open XLSX zip: %v", err)
	}
	chartCount := 0
	for _, entry := range archive.File {
		if !strings.HasPrefix(entry.Name, "xl/charts/chart") || !strings.HasSuffix(entry.Name, ".xml") {
			continue
		}
		chartCount++
		reader, openErr := entry.Open()
		if openErr != nil {
			t.Fatal(openErr)
		}
		content, readErr := io.ReadAll(reader)
		_ = reader.Close()
		if readErr != nil {
			t.Fatal(readErr)
		}
		if !bytes.Contains(content, []byte("DATOS_GRÁFICOS")) {
			t.Fatalf("chart %s does not reference the internal data sheet", entry.Name)
		}
		if bytes.Contains(content, []byte("externalData")) || bytes.Contains(content, []byte("externalLink")) {
			t.Fatalf("chart %s contains an external connection", entry.Name)
		}
	}
	if chartCount != 3 {
		t.Fatalf("expected funnel plus two question charts, got %d", chartCount)
	}
}

func TestWriteSurveyWorkbookIsValidWithoutResponses(t *testing.T) {
	now := time.Date(2026, 8, 2, 4, 15, 0, 0, time.UTC)
	templateID, surveyID := uuid.New(), uuid.New()
	model := surveyWorkbookModel{
		Survey:    &domain.Survey{ID: surveyID, TemplateID: &templateID, Name: "Vacía", Status: "closed", AudienceMode: "public", CreatedAt: now},
		Analytics: &domain.SurveyAnalytics{QuestionStats: []domain.SurveyQuestionStats{}},
		Questions: []*domain.SurveyQuestion{}, ChartTypes: map[uuid.UUID]string{}, GeneratedAt: now,
	}
	emptyResponses := func(func(domain.SurveyReportResponse) error) error { return nil }
	emptyTexts := func(func(domain.SurveyReportTextAnswer) error) error { return nil }
	var output bytes.Buffer
	if err := writeSurveyWorkbook(model, &output, emptyResponses, emptyTexts); err != nil {
		t.Fatalf("write empty workbook: %v", err)
	}
	workbook, err := excelize.OpenReader(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatalf("reopen empty workbook: %v", err)
	}
	defer workbook.Close()
	if value, _ := workbook.GetCellValue("RESPUESTAS", "A1"); value != "Respuesta" {
		t.Fatalf("missing response header: %q", value)
	}
}

func TestWriteSurveyWorkbookKeepsProgramIdentityInInlineTextTable(t *testing.T) {
	now := time.Date(2026, 8, 3, 2, 0, 0, 0, time.UTC)
	surveyID, templateID, questionID := uuid.New(), uuid.New(), uuid.New()
	contactID, participantID := uuid.New(), uuid.New()
	model := surveyWorkbookModel{
		Survey: &domain.Survey{
			ID: surveyID, TemplateID: &templateID, Name: "Seguimiento", Status: "closed",
			AudienceMode: "program_participants", CreatedAt: now,
		},
		Questions: []*domain.SurveyQuestion{{ID: questionID, SurveyID: surveyID, Type: "long_text", Title: "Comentario"}},
		Analytics: &domain.SurveyAnalytics{TotalResponses: 1, QuestionStats: []domain.SurveyQuestionStats{{
			QuestionID: questionID, QuestionType: "long_text", Title: "Comentario", TotalAnswers: 1,
		}}},
		ChartTypes: map[uuid.UUID]string{}, GeneratedAt: now,
	}
	emptyResponses := func(func(domain.SurveyReportResponse) error) error { return nil }
	walkTexts := func(visit func(domain.SurveyReportTextAnswer) error) error {
		return visit(domain.SurveyReportTextAnswer{
			QuestionID: questionID, QuestionTitle: "Comentario", QuestionType: "long_text",
			Value: "Acompañamiento pendiente", CompletedAt: now, ContactID: &contactID,
			ProgramParticipantID: &participantID, ContactName: "Ana Torres",
		})
	}
	var output bytes.Buffer
	if err := writeSurveyWorkbook(model, &output, emptyResponses, walkTexts); err != nil {
		t.Fatalf("write workbook: %v", err)
	}
	workbook, err := excelize.OpenReader(bytes.NewReader(output.Bytes()))
	if err != nil {
		t.Fatalf("reopen workbook: %v", err)
	}
	defer workbook.Close()
	checks := map[string]string{
		"B6": "contact_id", "C6": "program_participant_id", "D6": "Contacto", "E6": "Texto",
		"B7": contactID.String(), "C7": participantID.String(), "D7": "Ana Torres", "E7": "Acompañamiento pendiente",
	}
	for cell, expected := range checks {
		if value, _ := workbook.GetCellValue("RESULTADOS", cell); value != expected {
			t.Fatalf("cell %s=%q want %q", cell, value, expected)
		}
	}
}

func floatPtr(value float64) *float64 { return &value }
