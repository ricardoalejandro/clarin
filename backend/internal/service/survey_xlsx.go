package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/xuri/excelize/v2"
)

var (
	ErrSurveyApplicationRequired = errors.New("la exportación requiere una aplicación de encuesta")
	ErrSurveyXLSXRequestInvalid  = errors.New("la configuración de exportación es inválida")
)

type SurveyXLSXExportRequest struct {
	ChartTypes map[uuid.UUID]string
	BaselineID *uuid.UUID
	FollowupID *uuid.UUID
}

type surveyWorkbookModel struct {
	Survey      *domain.Survey
	Questions   []*domain.SurveyQuestion
	Analytics   *domain.SurveyAnalytics
	Evolution   *domain.SurveyMeasurementSeries
	ChartTypes  map[uuid.UUID]string
	GeneratedAt time.Time
}

type surveyWorkbookStyles struct {
	title, section, header, label, text, date, percent, decimal int
}

type surveyReportResponseWalker func(func(domain.SurveyReportResponse) error) error
type surveyReportTextWalker func(func(domain.SurveyReportTextAnswer) error) error

func (svc *SurveyService) WriteSurveyResultsXLSX(
	ctx context.Context,
	accountID, surveyID uuid.UUID,
	request SurveyXLSXExportRequest,
	output io.Writer,
) (string, error) {
	survey, err := svc.repo.Survey.GetByID(ctx, surveyID, accountID)
	if err != nil {
		if errors.Is(err, repository.ErrSurveyInstanceNotFound) || errors.Is(err, pgx.ErrNoRows) {
			if _, templateErr := svc.repo.SurveyTemplate.Get(ctx, accountID, surveyID); templateErr == nil {
				return "", ErrSurveyApplicationRequired
			}
		}
		return "", err
	}
	if survey.TemplateID == nil {
		return "", ErrSurveyApplicationRequired
	}
	questions, err := svc.repo.Survey.GetQuestionsScoped(ctx, accountID, surveyID)
	if err != nil {
		return "", err
	}
	questionIDs := make(map[uuid.UUID]struct{}, len(questions))
	chartTypes := make(map[uuid.UUID]string, len(questions))
	for _, question := range questions {
		questionIDs[question.ID] = struct{}{}
		chartTypes[question.ID] = "bar"
	}
	for questionID, chartType := range request.ChartTypes {
		if _, exists := questionIDs[questionID]; !exists {
			return "", fmt.Errorf("%w: la pregunta no pertenece a la aplicación", ErrSurveyXLSXRequestInvalid)
		}
		switch chartType {
		case "bar", "pie", "radar":
			chartTypes[questionID] = chartType
		default:
			return "", fmt.Errorf("%w: tipo de gráfico desconocido", ErrSurveyXLSXRequestInvalid)
		}
	}
	analytics, err := svc.repo.Survey.GetAnalytics(ctx, accountID, surveyID)
	if err != nil {
		return "", err
	}

	var evolution *domain.SurveyMeasurementSeries
	comparisonRequested := request.BaselineID != nil || request.FollowupID != nil
	if survey.ProgramID != nil && survey.TemplateID != nil && survey.MeasurementSignature != "" {
		evolution, err = svc.repo.SurveyTemplate.GetProgramMeasurementSeries(
			ctx, accountID, *survey.ProgramID, *survey.TemplateID,
			survey.MeasurementSignature, request.BaselineID, request.FollowupID,
		)
		if err != nil {
			return "", err
		}
	} else if comparisonRequested {
		return "", fmt.Errorf("%w: la aplicación no admite comparación de evolución", ErrSurveyXLSXRequestInvalid)
	}

	model := surveyWorkbookModel{
		Survey: survey, Questions: questions, Analytics: analytics, Evolution: evolution,
		ChartTypes: chartTypes, GeneratedAt: time.Now().UTC(),
	}
	if err := writeSurveyWorkbook(
		model,
		output,
		func(visit func(domain.SurveyReportResponse) error) error {
			return svc.repo.Survey.WalkCompletedSurveyReportResponses(ctx, accountID, surveyID, visit)
		},
		func(visit func(domain.SurveyReportTextAnswer) error) error {
			return svc.repo.Survey.WalkCompletedSurveyReportTextAnswers(ctx, accountID, surveyID, visit)
		},
	); err != nil {
		return "", err
	}
	namePart := Slugify(survey.Name)
	if namePart == "" {
		namePart = "encuesta"
	}
	return fmt.Sprintf("resultados_%s_%s.xlsx", namePart, model.GeneratedAt.Format("2006-01-02")), nil
}

func writeSurveyWorkbook(model surveyWorkbookModel, output io.Writer, walkResponses surveyReportResponseWalker, walkTexts surveyReportTextWalker) error {
	file := excelize.NewFile()
	defer file.Close()
	if err := file.SetSheetName("Sheet1", "RESUMEN"); err != nil {
		return err
	}
	for _, sheet := range []string{"RESULTADOS", "RESPUESTAS", "TEXTOS"} {
		if _, err := file.NewSheet(sheet); err != nil {
			return err
		}
	}
	if model.Evolution != nil && len(model.Evolution.Applications) > 0 {
		if _, err := file.NewSheet("EVOLUCIÓN"); err != nil {
			return err
		}
	}
	if _, err := file.NewSheet("DATOS_GRÁFICOS"); err != nil {
		return err
	}
	styles, err := newSurveyWorkbookStyles(file)
	if err != nil {
		return err
	}
	if err := writeSurveySummarySheet(file, model, styles); err != nil {
		return err
	}
	if err := writeSurveyResultsSheet(file, model, styles); err != nil {
		return err
	}
	if err := writeSurveyResponsesSheet(file, model, styles, walkResponses); err != nil {
		return err
	}
	if err := writeSurveyTextsSheet(file, model, styles, walkTexts); err != nil {
		return err
	}
	if model.Evolution != nil && len(model.Evolution.Applications) > 0 {
		if err := writeSurveyEvolutionSheet(file, model, styles); err != nil {
			return err
		}
	}
	if err := file.SetSheetVisible("DATOS_GRÁFICOS", false); err != nil {
		return err
	}
	file.SetActiveSheet(0)
	return file.Write(output)
}

func newSurveyWorkbookStyles(file *excelize.File) (surveyWorkbookStyles, error) {
	var styles surveyWorkbookStyles
	var err error
	styles.title, err = file.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 20, Color: "183153"},
		Alignment: &excelize.Alignment{Vertical: "center"},
	})
	if err != nil {
		return styles, err
	}
	styles.section, err = file.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Size: 13, Color: "FFFFFF"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"079669"}, Pattern: 1},
		Alignment: &excelize.Alignment{Vertical: "center"},
	})
	if err != nil {
		return styles, err
	}
	styles.header, err = file.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "183153"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"E8F5F0"}, Pattern: 1},
		Border:    []excelize.Border{{Type: "bottom", Color: "B8D8CC", Style: 1}},
		Alignment: &excelize.Alignment{Vertical: "center", WrapText: true},
	})
	if err != nil {
		return styles, err
	}
	styles.label, err = file.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Color: "52657D"}})
	if err != nil {
		return styles, err
	}
	textFormat := "@"
	styles.text, err = file.NewStyle(&excelize.Style{
		CustomNumFmt: &textFormat,
		Alignment:    &excelize.Alignment{Vertical: "top", WrapText: true},
	})
	if err != nil {
		return styles, err
	}
	dateFormat := "yyyy-mm-dd hh:mm"
	styles.date, err = file.NewStyle(&excelize.Style{CustomNumFmt: &dateFormat})
	if err != nil {
		return styles, err
	}
	percentFormat := `0.0"%"`
	styles.percent, err = file.NewStyle(&excelize.Style{CustomNumFmt: &percentFormat})
	if err != nil {
		return styles, err
	}
	decimalFormat := "0.00"
	styles.decimal, err = file.NewStyle(&excelize.Style{CustomNumFmt: &decimalFormat})
	return styles, err
}

func writeSurveySummarySheet(file *excelize.File, model surveyWorkbookModel, styles surveyWorkbookStyles) error {
	const sheet = "RESUMEN"
	if err := file.MergeCell(sheet, "A1", "F1"); err != nil {
		return err
	}
	if err := file.SetCellValue(sheet, "A1", "Resultados de encuesta"); err != nil {
		return err
	}
	_ = file.SetCellStyle(sheet, "A1", "F1", styles.title)
	_ = file.SetRowHeight(sheet, 1, 34)
	rows := []struct {
		label string
		value interface{}
		style int
	}{
		{"Aplicación", model.Survey.Name, styles.text},
		{"Revisión", model.Survey.TemplateRevision, 0},
		{"Origen", model.Survey.OriginLabel, styles.text},
		{"Estado", surveyStatusLabel(model.Survey), styles.text},
		{"Creada", model.Survey.CreatedAt, styles.date},
		{"Informe generado", model.GeneratedAt, styles.date},
		{"Respuestas completadas", model.Analytics.TotalResponses, 0},
		{"Aperturas", model.Analytics.Funnel.OpenedCount, 0},
		{"Inicios", model.Analytics.Funnel.StartedCount, 0},
		{"Completados desde seguimiento", model.Analytics.Funnel.CompletedCount, 0},
		{"Abandonos", model.Analytics.Funnel.AbandonedCount, 0},
		{"Cobertura", optionalPercent(model.Analytics.Funnel.RecipientCompletionRate, model.Analytics.CompletionRate), styles.percent},
		{"Tiempo promedio (segundos)", optionalFloat(model.Analytics.AvgCompletionSec), styles.decimal},
		{"Tiempo mediano (segundos)", optionalFloat(model.Analytics.Funnel.MedianCompletionSec), styles.decimal},
	}
	for index, row := range rows {
		line := index + 3
		labelCell, _ := excelize.CoordinatesToCellName(1, line)
		valueCell, _ := excelize.CoordinatesToCellName(2, line)
		_ = file.SetCellValue(sheet, labelCell, row.label)
		_ = file.SetCellStyle(sheet, labelCell, labelCell, styles.label)
		_ = file.SetCellValue(sheet, valueCell, row.value)
		if row.style != 0 {
			_ = file.SetCellStyle(sheet, valueCell, valueCell, row.style)
		}
		if row.label == "Origen" {
			_ = file.SetRowHeight(sheet, line, 30)
		}
	}
	_ = file.SetColWidth(sheet, "A", "A", 34)
	_ = file.SetColWidth(sheet, "B", "B", 24)
	_ = file.SetColWidth(sheet, "C", "C", 2)
	_ = file.SetColWidth(sheet, "D", "L", 13)
	_ = file.SetSheetDimension(sheet, "A1:L20")
	_ = file.SetPageLayout(sheet, &excelize.PageLayoutOptions{Orientation: stringPtr("landscape"), FitToWidth: intPtr(1), FitToHeight: intPtr(0)})

	data := [][]interface{}{
		{"Etapa", "Cantidad"},
		{"Aperturas", model.Analytics.Funnel.OpenedCount},
		{"Inicios", model.Analytics.Funnel.StartedCount},
		{"Completados", model.Analytics.Funnel.CompletedCount},
		{"Abandonos", model.Analytics.Funnel.AbandonedCount},
	}
	for index, row := range data {
		cell, _ := excelize.CoordinatesToCellName(1, index+1)
		if err := file.SetSheetRow("DATOS_GRÁFICOS", cell, &row); err != nil {
			return err
		}
	}
	return file.AddChart(sheet, "D3", &excelize.Chart{
		Type: excelize.Col,
		Series: []excelize.ChartSeries{{
			Name: "'DATOS_GRÁFICOS'!$B$1", Categories: "'DATOS_GRÁFICOS'!$A$2:$A$5", Values: "'DATOS_GRÁFICOS'!$B$2:$B$5",
			Fill: excelize.Fill{Color: []string{"079669"}},
		}},
		Title:     excelize.ChartTitle{Paragraph: []excelize.RichTextRun{{Text: "Embudo de participación"}}},
		Legend:    excelize.ChartLegend{Position: "bottom"},
		Dimension: excelize.ChartDimension{Width: 400, Height: 300},
	})
}

func writeSurveyResultsSheet(file *excelize.File, model surveyWorkbookModel, styles surveyWorkbookStyles) error {
	const sheet = "RESULTADOS"
	_ = file.MergeCell(sheet, "A1", "L1")
	_ = file.SetCellValue(sheet, "A1", "Resultados por pregunta")
	_ = file.SetCellStyle(sheet, "A1", "L1", styles.title)
	_ = file.SetRowHeight(sheet, 1, 34)
	_ = file.SetColWidth(sheet, "A", "A", 4)
	_ = file.SetColWidth(sheet, "B", "B", 38)
	_ = file.SetColWidth(sheet, "C", "E", 16)
	_ = file.SetColWidth(sheet, "G", "N", 12)
	statsByQuestion := make(map[uuid.UUID]domain.SurveyQuestionStats, len(model.Analytics.QuestionStats))
	for _, stat := range model.Analytics.QuestionStats {
		statsByQuestion[stat.QuestionID] = stat
	}
	dataRow := 8
	resultRow := 3
	for questionIndex, question := range model.Questions {
		stat := statsByQuestion[question.ID]
		sectionEnd := resultRow + 1
		_ = file.MergeCell(sheet, fmt.Sprintf("A%d", resultRow), fmt.Sprintf("L%d", resultRow))
		_ = file.SetCellValue(sheet, fmt.Sprintf("A%d", resultRow), fmt.Sprintf("%d. %s", questionIndex+1, question.Title))
		_ = file.SetCellStyle(sheet, fmt.Sprintf("A%d", resultRow), fmt.Sprintf("L%d", resultRow), styles.section)
		_ = file.SetCellValue(sheet, fmt.Sprintf("B%d", resultRow+1), "Tipo")
		_ = file.SetCellValue(sheet, fmt.Sprintf("C%d", resultRow+1), questionTypeLabel(question.Type))
		_ = file.SetCellValue(sheet, fmt.Sprintf("D%d", resultRow+1), "Muestra")
		_ = file.SetCellValue(sheet, fmt.Sprintf("E%d", resultRow+1), stat.TotalAnswers)
		_ = file.SetCellStyle(sheet, fmt.Sprintf("B%d", resultRow+1), fmt.Sprintf("B%d", resultRow+1), styles.label)
		_ = file.SetCellStyle(sheet, fmt.Sprintf("D%d", resultRow+1), fmt.Sprintf("D%d", resultRow+1), styles.label)
		if stat.Average != nil {
			_ = file.SetCellValue(sheet, fmt.Sprintf("B%d", resultRow+2), "Promedio")
			_ = file.SetCellValue(sheet, fmt.Sprintf("C%d", resultRow+2), *stat.Average)
			_ = file.SetCellStyle(sheet, fmt.Sprintf("B%d", resultRow+2), fmt.Sprintf("B%d", resultRow+2), styles.label)
			_ = file.SetCellStyle(sheet, fmt.Sprintf("C%d", resultRow+2), fmt.Sprintf("C%d", resultRow+2), styles.decimal)
			sectionEnd = resultRow + 2
		}
		labels, counts := questionDistribution(question, stat)
		if len(labels) == 0 {
			message := "Sin respuestas para representar"
			if question.Type == "short_text" || question.Type == "long_text" {
				message = "Las respuestas completas están en la hoja TEXTOS"
			}
			_ = file.SetCellValue(sheet, fmt.Sprintf("B%d", sectionEnd+2), message)
			_ = file.SetCellStyle(sheet, fmt.Sprintf("B%d", sectionEnd+2), fmt.Sprintf("E%d", sectionEnd+2), styles.text)
			resultRow = sectionEnd + 6
			continue
		}
		tableHeader := sectionEnd + 2
		for column, value := range []string{"Opción", "Cantidad", "Porcentaje"} {
			cell, _ := excelize.CoordinatesToCellName(column+2, tableHeader)
			_ = file.SetCellValue(sheet, cell, value)
			_ = file.SetCellStyle(sheet, cell, cell, styles.header)
		}
		total := 0
		for _, count := range counts {
			total += count
		}
		for index := range labels {
			line := tableHeader + index + 1
			_ = file.SetCellValue(sheet, fmt.Sprintf("B%d", line), labels[index])
			_ = file.SetCellStyle(sheet, fmt.Sprintf("B%d", line), fmt.Sprintf("B%d", line), styles.text)
			_ = file.SetCellValue(sheet, fmt.Sprintf("C%d", line), counts[index])
			percentage := float64(0)
			if total > 0 {
				percentage = float64(counts[index]) / float64(total) * 100
			}
			_ = file.SetCellValue(sheet, fmt.Sprintf("D%d", line), percentage)
			_ = file.SetCellStyle(sheet, fmt.Sprintf("D%d", line), fmt.Sprintf("D%d", line), styles.percent)
		}

		dataTitleRow := dataRow
		_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("D%d", dataTitleRow), question.Title)
		_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("D%d", dataTitleRow+1), "Opción")
		_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("E%d", dataTitleRow+1), "Cantidad")
		for index := range labels {
			_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("D%d", dataTitleRow+index+2), labels[index])
			_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("E%d", dataTitleRow+index+2), counts[index])
		}
		chartType := excelChartType(model.ChartTypes[question.ID])
		chart := &excelize.Chart{
			Type: chartType,
			Series: []excelize.ChartSeries{{
				Name:       fmt.Sprintf("'DATOS_GRÁFICOS'!$E$%d", dataTitleRow+1),
				Categories: fmt.Sprintf("'DATOS_GRÁFICOS'!$D$%d:$D$%d", dataTitleRow+2, dataTitleRow+1+len(labels)),
				Values:     fmt.Sprintf("'DATOS_GRÁFICOS'!$E$%d:$E$%d", dataTitleRow+2, dataTitleRow+1+len(labels)),
				Fill:       excelize.Fill{Color: []string{"079669"}},
			}},
			Title:     excelize.ChartTitle{Paragraph: []excelize.RichTextRun{{Text: question.Title}}},
			Legend:    excelize.ChartLegend{Position: "bottom"},
			Dimension: excelize.ChartDimension{Width: 470, Height: 280},
			PlotArea:  excelize.ChartPlotArea{ShowPercent: chartType == excelize.Pie, ShowVal: true},
		}
		if err := file.AddChart(sheet, fmt.Sprintf("F%d", tableHeader), chart); err != nil {
			return err
		}
		dataRow += len(labels) + 4
		chartBottom := tableHeader + 15
		tableBottom := tableHeader + len(labels) + 1
		if tableBottom > chartBottom {
			chartBottom = tableBottom
		}
		resultRow = chartBottom + 2
	}
	_ = file.SetPageLayout(sheet, &excelize.PageLayoutOptions{Orientation: stringPtr("landscape"), FitToWidth: intPtr(1), FitToHeight: intPtr(0)})
	_ = file.SetSheetDimension(sheet, fmt.Sprintf("A1:N%d", maxInt(resultRow, 20)))
	_ = file.SetSheetDimension("DATOS_GRÁFICOS", fmt.Sprintf("A1:E%d", maxInt(dataRow, 16)))
	return nil
}

func writeSurveyResponsesSheet(
	file *excelize.File,
	model surveyWorkbookModel,
	styles surveyWorkbookStyles,
	walk surveyReportResponseWalker,
) error {
	const sheet = "RESPUESTAS"
	programAudience := model.Survey.AudienceMode == "program_participants"
	headers := []string{"Respuesta", "Origen", "Inicio", "Completada"}
	if programAudience {
		headers = []string{"contact_id", "program_participant_id", "Contacto", "Teléfono", "Origen", "Inicio", "Completada"}
	}
	for index, question := range model.Questions {
		headers = append(headers, excelQuestionHeader(index, question))
	}
	lastColumn, _ := excelize.ColumnNumberToName(len(headers))
	if err := file.SetSheetDimension(sheet, fmt.Sprintf("A1:%s%d", lastColumn, maxInt(model.Analytics.TotalResponses+1, 2))); err != nil {
		return err
	}
	stream, err := file.NewStreamWriter(sheet)
	if err != nil {
		return err
	}
	headerRow := make([]interface{}, len(headers))
	for index, header := range headers {
		headerRow[index] = excelize.Cell{StyleID: styles.header, Value: header}
	}
	if err := stream.SetRow("A1", headerRow, excelize.RowOpts{Height: 32}); err != nil {
		return err
	}
	_ = stream.SetPanes(&excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	_ = stream.SetColWidth(1, len(headers), 18)
	if programAudience {
		_ = stream.SetColWidth(3, 4, 24)
	} else {
		_ = stream.SetColWidth(1, 1, 24)
	}
	if len(headers) > 7 {
		_ = stream.SetColWidth(8, len(headers), 32)
	}
	rowNumber := 1
	err = walk(func(response domain.SurveyReportResponse) error {
		rowNumber++
		row := make([]interface{}, 0, len(headers))
		if programAudience {
			row = append(row,
				textCell(optionalUUID(response.ContactID), styles.text),
				textCell(optionalUUID(response.ProgramParticipantID), styles.text),
				textCell(response.ContactName, styles.text),
				textCell(response.ContactPhone, styles.text),
			)
		} else {
			row = append(row, textCell(fmt.Sprintf("Respuesta anónima %d", response.AnonymousIndex), styles.text))
		}
		row = append(row,
			textCell(response.Source, styles.text),
			excelize.Cell{StyleID: styles.date, Value: response.StartedAt},
			excelize.Cell{StyleID: styles.date, Value: response.CompletedAt},
		)
		for _, question := range model.Questions {
			row = append(row, textCell(response.Answers[question.ID], styles.text))
		}
		cell, _ := excelize.CoordinatesToCellName(1, rowNumber)
		return stream.SetRow(cell, row)
	})
	if err != nil {
		return err
	}
	if err := stream.AddTable(&excelize.Table{
		Range: fmt.Sprintf("A1:%s%d", lastColumn, rowNumber),
		Name:  "RespuestasCompletadas", StyleName: "TableStyleMedium4", ShowRowStripes: boolPtr(true),
	}); err != nil {
		return err
	}
	if err := stream.Flush(); err != nil {
		return err
	}
	return file.SetSheetDimension(sheet, fmt.Sprintf("A1:%s%d", lastColumn, maxInt(rowNumber, 2)))
}

func writeSurveyTextsSheet(
	file *excelize.File,
	model surveyWorkbookModel,
	styles surveyWorkbookStyles,
	walk surveyReportTextWalker,
) error {
	const sheet = "TEXTOS"
	programAudience := model.Survey.AudienceMode == "program_participants"
	headers := []string{"Respuesta", "Pregunta", "Tipo", "Texto", "Completada"}
	if programAudience {
		headers = []string{"contact_id", "program_participant_id", "Contacto", "Pregunta", "Tipo", "Texto", "Completada"}
	}
	textAnswerCount := 0
	for _, stat := range model.Analytics.QuestionStats {
		if stat.QuestionType == "short_text" || stat.QuestionType == "long_text" {
			textAnswerCount += stat.TotalAnswers
		}
	}
	lastColumn, _ := excelize.ColumnNumberToName(len(headers))
	if err := file.SetSheetDimension(sheet, fmt.Sprintf("A1:%s%d", lastColumn, maxInt(textAnswerCount+1, 2))); err != nil {
		return err
	}
	stream, err := file.NewStreamWriter(sheet)
	if err != nil {
		return err
	}
	headerRow := make([]interface{}, len(headers))
	for index, header := range headers {
		headerRow[index] = excelize.Cell{StyleID: styles.header, Value: header}
	}
	if err := stream.SetRow("A1", headerRow, excelize.RowOpts{Height: 32}); err != nil {
		return err
	}
	_ = stream.SetPanes(&excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})
	_ = stream.SetColWidth(1, len(headers), 22)
	textColumn := 4
	if programAudience {
		textColumn = 6
	}
	_ = stream.SetColWidth(textColumn, textColumn, 64)
	rowNumber := 1
	err = walk(func(answer domain.SurveyReportTextAnswer) error {
		rowNumber++
		row := make([]interface{}, 0, len(headers))
		if programAudience {
			row = append(row,
				textCell(optionalUUID(answer.ContactID), styles.text),
				textCell(optionalUUID(answer.ProgramParticipantID), styles.text),
				textCell(answer.ContactName, styles.text),
			)
		} else {
			row = append(row, textCell(fmt.Sprintf("Respuesta anónima %d", answer.AnonymousIndex), styles.text))
		}
		row = append(row,
			textCell(answer.QuestionTitle, styles.text),
			textCell(questionTypeLabel(answer.QuestionType), styles.text),
			textCell(answer.Value, styles.text),
			excelize.Cell{StyleID: styles.date, Value: answer.CompletedAt},
		)
		cell, _ := excelize.CoordinatesToCellName(1, rowNumber)
		return stream.SetRow(cell, row, excelize.RowOpts{Height: 32})
	})
	if err != nil {
		return err
	}
	if err := stream.AddTable(&excelize.Table{
		Range: fmt.Sprintf("A1:%s%d", lastColumn, rowNumber),
		Name:  "RespuestasDeTexto", StyleName: "TableStyleMedium4", ShowRowStripes: boolPtr(true),
	}); err != nil {
		return err
	}
	if err := stream.Flush(); err != nil {
		return err
	}
	return file.SetSheetDimension(sheet, fmt.Sprintf("A1:%s%d", lastColumn, maxInt(rowNumber, 2)))
}

func writeSurveyEvolutionSheet(file *excelize.File, model surveyWorkbookModel, styles surveyWorkbookStyles) error {
	const sheet = "EVOLUCIÓN"
	_ = file.MergeCell(sheet, "A1", "H1")
	_ = file.SetCellValue(sheet, "A1", "Evolución del programa")
	_ = file.SetCellStyle(sheet, "A1", "H1", styles.title)
	_ = file.SetColWidth(sheet, "A", "A", 24)
	_ = file.SetColWidth(sheet, "B", "H", 14)
	row := 3
	_ = file.SetCellValue(sheet, fmt.Sprintf("A%d", row), "Aplicaciones compatibles")
	_ = file.SetCellStyle(sheet, fmt.Sprintf("A%d", row), fmt.Sprintf("H%d", row), styles.section)
	row++
	dimensionNames := make(map[string]string, len(model.Survey.MeasurementConfig.Dimensions))
	dimensionKeys := make([]string, 0, len(model.Survey.MeasurementConfig.Dimensions))
	applicationHeaders := []string{"Aplicación", "Fecha", "Respuestas"}
	for _, dimension := range model.Survey.MeasurementConfig.Dimensions {
		dimensionNames[dimension.Key] = dimension.Name
		dimensionKeys = append(dimensionKeys, dimension.Key)
		applicationHeaders = append(applicationHeaders, dimension.Name)
	}
	for index, header := range applicationHeaders {
		cell, _ := excelize.CoordinatesToCellName(index+1, row)
		_ = file.SetCellValue(sheet, cell, header)
		_ = file.SetCellStyle(sheet, cell, cell, styles.header)
	}
	for applicationIndex, application := range model.Evolution.Applications {
		row++
		_ = file.SetCellValue(sheet, fmt.Sprintf("A%d", row), application.Name)
		_ = file.SetCellStyle(sheet, fmt.Sprintf("A%d", row), fmt.Sprintf("A%d", row), styles.text)
		_ = file.SetCellValue(sheet, fmt.Sprintf("B%d", row), application.CreatedAt)
		_ = file.SetCellStyle(sheet, fmt.Sprintf("B%d", row), fmt.Sprintf("B%d", row), styles.date)
		_ = file.SetCellValue(sheet, fmt.Sprintf("C%d", row), application.ResponseCount)
		dimensions := make(map[string]domain.SurveyMeasurementDimensionStats, len(application.Dimensions))
		for _, dimension := range application.Dimensions {
			dimensions[dimension.Key] = dimension
		}
		_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("G%d", applicationIndex+2), application.Name)
		for dimensionIndex, key := range dimensionKeys {
			column, _ := excelize.ColumnNumberToName(dimensionIndex + 4)
			average := dimensions[key].Average
			_ = file.SetCellValue(sheet, fmt.Sprintf("%s%d", column, row), optionalFloat(average))
			_ = file.SetCellStyle(sheet, fmt.Sprintf("%s%d", column, row), fmt.Sprintf("%s%d", column, row), styles.decimal)
			hiddenColumn, _ := excelize.ColumnNumberToName(dimensionIndex + 8)
			_ = file.SetCellValue("DATOS_GRÁFICOS", fmt.Sprintf("%s%d", hiddenColumn, applicationIndex+2), optionalFloat(average))
		}
	}
	_ = file.SetCellValue("DATOS_GRÁFICOS", "G1", "Aplicación")
	for dimensionIndex, key := range dimensionKeys {
		hiddenColumn, _ := excelize.ColumnNumberToName(dimensionIndex + 8)
		_ = file.SetCellValue("DATOS_GRÁFICOS", hiddenColumn+"1", dimensionNames[key])
	}
	if len(model.Evolution.Applications) > 1 && len(dimensionKeys) > 0 {
		series := make([]excelize.ChartSeries, 0, len(dimensionKeys))
		for dimensionIndex := range dimensionKeys {
			hiddenColumn, _ := excelize.ColumnNumberToName(dimensionIndex + 8)
			series = append(series, excelize.ChartSeries{
				Name:       fmt.Sprintf("'DATOS_GRÁFICOS'!$%s$1", hiddenColumn),
				Categories: fmt.Sprintf("'DATOS_GRÁFICOS'!$G$2:$G$%d", len(model.Evolution.Applications)+1),
				Values:     fmt.Sprintf("'DATOS_GRÁFICOS'!$%s$2:$%s$%d", hiddenColumn, hiddenColumn, len(model.Evolution.Applications)+1),
			})
		}
		if err := file.AddChart(sheet, "F3", &excelize.Chart{
			Type: excelize.Line, Series: series,
			Title:     excelize.ChartTitle{Paragraph: []excelize.RichTextRun{{Text: "Evolución por dimensión"}}},
			Legend:    excelize.ChartLegend{Position: "bottom"},
			Dimension: excelize.ChartDimension{Width: 420, Height: 300},
		}); err != nil {
			return err
		}
	}
	row += 3
	_ = file.SetCellValue(sheet, fmt.Sprintf("A%d", row), "Cambios pareados")
	_ = file.SetCellStyle(sheet, fmt.Sprintf("A%d", row), fmt.Sprintf("H%d", row), styles.section)
	row++
	for index, header := range []string{"Dimensión", "Muestra pareada", "Inicial", "Final", "Cambio"} {
		cell, _ := excelize.CoordinatesToCellName(index+1, row)
		_ = file.SetCellValue(sheet, cell, header)
		_ = file.SetCellStyle(sheet, cell, cell, styles.header)
	}
	for _, change := range model.Evolution.PairedChanges {
		row++
		name := dimensionNames[change.DimensionKey]
		if name == "" {
			name = change.DimensionKey
		}
		values := []interface{}{name, change.SampleSize, optionalFloat(change.Baseline), optionalFloat(change.Followup), optionalFloat(change.Delta)}
		for index, value := range values {
			cell, _ := excelize.CoordinatesToCellName(index+1, row)
			_ = file.SetCellValue(sheet, cell, value)
			if index >= 2 {
				_ = file.SetCellStyle(sheet, cell, cell, styles.decimal)
			}
		}
	}
	_ = file.SetPageLayout(sheet, &excelize.PageLayoutOptions{Orientation: stringPtr("landscape"), FitToWidth: intPtr(1), FitToHeight: intPtr(0)})
	_ = file.SetSheetDimension(sheet, fmt.Sprintf("A1:O%d", maxInt(row, 24)))
	lastDataRow := maxInt(chartDataLastRow(model), len(model.Evolution.Applications)+1)
	lastDataColumn, _ := excelize.ColumnNumberToName(maxInt(8+len(dimensionKeys)-1, 5))
	_ = file.SetSheetDimension("DATOS_GRÁFICOS", fmt.Sprintf("A1:%s%d", lastDataColumn, maxInt(lastDataRow, 16)))
	return nil
}

func questionDistribution(question *domain.SurveyQuestion, stat domain.SurveyQuestionStats) ([]string, []int) {
	values := stat.OptionCounts
	if len(values) == 0 {
		values = stat.Distribution
	}
	if len(values) == 0 {
		return nil, nil
	}
	labels := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	if question.Type == "single_choice" || question.Type == "multiple_choice" {
		for _, option := range question.Config.Options {
			labels = append(labels, option)
			seen[option] = struct{}{}
		}
	}
	extras := make([]string, 0)
	for label := range values {
		if _, exists := seen[label]; !exists {
			extras = append(extras, label)
		}
	}
	sort.Strings(extras)
	labels = append(labels, extras...)
	counts := make([]int, len(labels))
	for index, label := range labels {
		counts[index] = values[label]
	}
	return labels, counts
}

func excelQuestionHeader(index int, question *domain.SurveyQuestion) string {
	title := []rune(strings.TrimSpace(question.Title))
	if len(title) > 160 {
		title = title[:160]
	}
	return fmt.Sprintf("P%03d [%s] %s", index+1, question.ID.String(), string(title))
}

func chartDataLastRow(model surveyWorkbookModel) int {
	statsByQuestion := make(map[uuid.UUID]domain.SurveyQuestionStats, len(model.Analytics.QuestionStats))
	for _, stat := range model.Analytics.QuestionStats {
		statsByQuestion[stat.QuestionID] = stat
	}
	row := 8
	for _, question := range model.Questions {
		labels, _ := questionDistribution(question, statsByQuestion[question.ID])
		if len(labels) > 0 {
			row += len(labels) + 4
		}
	}
	return row
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func excelChartType(value string) excelize.ChartType {
	switch value {
	case "pie":
		return excelize.Pie
	case "radar":
		return excelize.Radar
	default:
		return excelize.Col
	}
}

func questionTypeLabel(value string) string {
	labels := map[string]string{
		"short_text": "Texto corto", "long_text": "Texto largo", "single_choice": "Opción única",
		"multiple_choice": "Opción múltiple", "rating": "Calificación", "likert": "Escala Likert",
		"date": "Fecha", "email": "Correo electrónico", "phone": "Teléfono", "file_upload": "Archivo",
	}
	if label := labels[value]; label != "" {
		return label
	}
	return value
}

func surveyStatusLabel(survey *domain.Survey) string {
	if survey.ArchivedAt != nil {
		return "Archivada"
	}
	switch survey.Status {
	case "active":
		return "Activa"
	case "closed":
		return "Cerrada"
	default:
		return "Borrador"
	}
}

func textCell(value string, style int) excelize.Cell {
	return excelize.Cell{StyleID: style, Value: strings.ToValidUTF8(value, "�")}
}

func optionalUUID(value *uuid.UUID) string {
	if value == nil {
		return ""
	}
	return value.String()
}

func optionalFloat(value *float64) interface{} {
	if value == nil {
		return ""
	}
	return *value
}

func optionalPercent(primary, fallback *float64) interface{} {
	if primary != nil {
		return *primary
	}
	return optionalFloat(fallback)
}

func stringPtr(value string) *string { return &value }
func intPtr(value int) *int          { return &value }
func boolPtr(value bool) *bool       { return &value }
