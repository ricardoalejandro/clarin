package api

import (
	"bytes"
	"context"
	"encoding/csv"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/xuri/excelize/v2"
	"strings"
	"testing"
	"time"
)

func TestLogbookExportsPreserveSnapshotAndTreatTextAsText(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 10, 12, 8, 0, 0, 0, time.UTC)
	lb := &domain.EventLogbook{Title: "=SUM(A1)", Date: now, CapturedAt: &now, Status: "completed", GeneralNotes: "Primera\nSegunda"}
	phone := "+51999999999"
	entry := &domain.EventLogbookEntry{ParticipantID: uuid.New(), ParticipantName: "=HYPERLINK(\"bad\")", ParticipantPhone: &phone, StageName: "Etapa histórica", Notes: "Línea 1\nLínea 2", CaptureStageKey: "historical"}
	stream := func(_ context.Context, visit func(*domain.EventLogbookEntry) error) error { return visit(entry) }
	var csvBuffer bytes.Buffer
	if err := writeLogbookCSV(ctx, &csvBuffer, lb, stream); err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(strings.NewReader(csvBuffer.String())).ReadAll()
	if err != nil || len(rows) != 2 || rows[1][4] != "'"+entry.ParticipantName || rows[1][7] != entry.Notes {
		t.Fatal("CSV lost notes or allows formulas", err)
	}
	var buffer bytes.Buffer
	if err = writeLogbookXLSX(ctx, &buffer, lb, stream); err != nil {
		t.Fatal(err)
	}
	file, err := excelize.OpenReader(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	for _, cell := range []string{"B2", "C2", "E2"} {
		formula, err := file.GetCellFormula("Participantes", cell)
		if err != nil || formula != "" {
			t.Fatal("user text became a formula", err)
		}
	}
	value, err := file.GetCellValue("Participantes", "B2")
	if err != nil || value != entry.ParticipantName {
		t.Fatal("XLSX changed user text", err)
	}
}
