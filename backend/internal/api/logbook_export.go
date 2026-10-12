package api

import (
	"context"
	"encoding/csv"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/xuri/excelize/v2"
	"io"
	"os"
	"strings"
)

// XLSX string values are never formulas. CSV additionally protects spreadsheet
// importers that interpret formula-like user text even inside quoted cells.
func logbookCSVText(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if len(trimmed) > 0 && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}
func logbookExportRow(e *domain.EventLogbookEntry) []string {
	phone := ""
	if e.ParticipantPhone != nil {
		phone = *e.ParticipantPhone
	}
	stage := e.StageName
	if stage == "" {
		stage = "Sin etapa"
	}
	return []string{e.ParticipantID.String(), e.ParticipantName, phone, stage, e.Notes, e.CaptureStageKey}
}

type logbookEntryStream func(context.Context, func(*domain.EventLogbookEntry) error) error

func writeLogbookCSV(ctx context.Context, w io.Writer, lb *domain.EventLogbook, stream logbookEntryStream) error {
	csvw := csv.NewWriter(w)
	header := []string{"Fecha de bitácora", "Título", "Capturada el", "Participación", "Contacto actual", "Teléfono actual", "Etapa capturada", "Nota de bitácora", "Clave de etapa histórica"}
	if err := csvw.Write(header); err != nil {
		return err
	}
	captured := ""
	if lb.CapturedAt != nil {
		captured = lb.CapturedAt.Format("2006-01-02T15:04:05Z07:00")
	}
	err := stream(ctx, func(e *domain.EventLogbookEntry) error {
		row := append([]string{lb.Date.Format("2006-01-02"), lb.Title, captured}, logbookExportRow(e)...)
		for i := range row {
			row[i] = logbookCSVText(row[i])
		}
		return csvw.Write(row)
	})
	csvw.Flush()
	if err != nil {
		return err
	}
	return csvw.Error()
}
func writeLogbookXLSX(ctx context.Context, w io.Writer, lb *domain.EventLogbook, stream logbookEntryStream) error {
	book := excelize.NewFile()
	defer book.Close()
	if err := book.SetSheetName("Sheet1", "Bitácora"); err != nil {
		return err
	}
	headerStyle, err := book.NewStyle(&excelize.Style{Font: &excelize.Font{Bold: true, Color: "FFFFFF"}, Fill: excelize.Fill{Type: "pattern", Color: []string{"047857"}, Pattern: 1}})
	if err != nil {
		return err
	}
	for cell, value := range map[string]string{"A1": "Bitácora del evento", "A2": "Fecha de la bitácora", "B2": lb.Date.Format("2006-01-02"), "A3": "Título", "B3": lb.Title, "A4": "Estado", "B4": lb.Status, "A5": "Notas generales", "B5": lb.GeneralNotes, "A7": "La etapa y las notas corresponden a esta captura; los datos de identidad son los actuales del Contacto."} {
		if err = book.SetCellStr("Bitácora", cell, value); err != nil {
			return err
		}
	}
	if lb.CapturedAt != nil {
		if err = book.SetCellStr("Bitácora", "A6", "Capturada el"); err != nil {
			return err
		}
		if err = book.SetCellStr("Bitácora", "B6", lb.CapturedAt.Format("2006-01-02T15:04:05Z07:00")); err != nil {
			return err
		}
	}
	if err = book.SetColWidth("Bitácora", "A", "A", 28); err != nil {
		return err
	}
	if err = book.SetColWidth("Bitácora", "B", "B", 75); err != nil {
		return err
	}
	if _, err = book.NewSheet("Participantes"); err != nil {
		return err
	}
	writer, err := book.NewStreamWriter("Participantes")
	if err != nil {
		return err
	}
	if err = writer.SetColWidth(1, 6, 30); err != nil {
		return err
	}
	header := []interface{}{}
	for _, value := range []string{"Participación", "Contacto actual", "Teléfono actual", "Etapa capturada", "Nota de bitácora", "Clave de etapa histórica"} {
		header = append(header, excelize.Cell{StyleID: headerStyle, Value: value})
	}
	if err = writer.SetRow("A1", header); err != nil {
		return err
	}
	row := 2
	err = stream(ctx, func(e *domain.EventLogbookEntry) error {
		if row > 1048576 {
			return fmt.Errorf("el informe supera el límite de filas de Excel")
		}
		values := []interface{}{}
		for _, value := range logbookExportRow(e) {
			values = append(values, excelize.Cell{Value: value})
		}
		err := writer.SetRow(fmt.Sprintf("A%d", row), values)
		row++
		return err
	})
	if err != nil {
		return err
	}
	if err = writer.Flush(); err != nil {
		return err
	}
	return book.Write(w)
}
func (s *Server) handleExportLogbook(c *fiber.Ctx) error {
	account, event, id, err := logbookIDs(c)
	if err != nil {
		return writeLogbookError(c, err)
	}
	lb, err := s.repos.Logbook.Summary(c.Context(), account, event, id)
	if err != nil {
		return writeLogbookError(c, err)
	}
	if lb.CapturedAt == nil {
		return writeLogbookError(c, repository.ErrLogbookTransition)
	}
	format := c.Query("format", "xlsx")
	if format != "xlsx" && format != "csv" {
		return writeLogbookError(c, repository.ErrLogbookInvalid)
	}
	file, err := os.CreateTemp("", "clarin-logbook-*")
	if err != nil {
		return c.SendStatus(500)
	}
	name := file.Name()
	defer os.Remove(name)
	stream := func(ctx context.Context, visit func(*domain.EventLogbookEntry) error) error {
		return s.repos.Logbook.StreamEntries(ctx, account, event, id, lb.Version, visit)
	}
	if format == "csv" {
		_, err = file.WriteString("\uFEFF")
		if err == nil {
			err = writeLogbookCSV(c.Context(), file, lb, stream)
		}
	} else {
		err = writeLogbookXLSX(c.Context(), file, lb, stream)
	}
	if err != nil {
		file.Close()
		return writeLogbookError(c, err)
	}
	if _, err = file.Seek(0, 0); err != nil {
		file.Close()
		return c.SendStatus(500)
	}
	mime := "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	if format == "csv" {
		mime = "text/csv; charset=utf-8"
	}
	c.Set(fiber.HeaderContentType, mime)
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf(`attachment; filename="bitacora-%s.%s"`, lb.Date.Format("2006-01-02"), format))
	return c.SendStream(file)
}
