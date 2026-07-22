package api

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestNeutralizeSpreadsheetFormula(t *testing.T) {
	tests := map[string]string{
		"=SUM(A1:A2)": "'=SUM(A1:A2)",
		"+cmd":        "'+cmd",
		"-10":         "'-10",
		"@payload":    "'@payload",
		"\t=payload":  "'\t=payload",
		"\r=payload":  "'\r=payload",
		"\n=payload":  "'\n=payload",
		"  =payload":  "'  =payload",
		"respuesta":   "respuesta",
		"'ya-seguro":  "'ya-seguro",
		"":            "",
	}
	for input, expected := range tests {
		if got := neutralizeSpreadsheetFormula(input); got != expected {
			t.Errorf("neutralizeSpreadsheetFormula(%q) = %q; want %q", input, got, expected)
		}
	}
}

func TestWriteSurveyCSVNeutralizesEveryUntrustedCell(t *testing.T) {
	data := &domain.SurveyExportData{
		Headers: []string{"response_id", "=cabecera"},
		Rows: [][]string{
			{"+respuesta", "@valor"},
			{"normal", "\tformula"},
		},
	}
	var output bytes.Buffer
	if err := writeSurveyCSV(&output, data); err != nil {
		t.Fatalf("writeSurveyCSV returned error: %v", err)
	}

	reader := csv.NewReader(strings.NewReader(output.String()))
	records, err := reader.ReadAll()
	if err != nil {
		t.Fatalf("generated invalid CSV: %v", err)
	}
	want := [][]string{
		{"response_id", "'=cabecera"},
		{"'+respuesta", "'@valor"},
		{"normal", "'\tformula"},
	}
	if len(records) != len(want) {
		t.Fatalf("got %d records; want %d", len(records), len(want))
	}
	for rowIndex := range want {
		for columnIndex := range want[rowIndex] {
			if records[rowIndex][columnIndex] != want[rowIndex][columnIndex] {
				t.Fatalf("cell [%d,%d] = %q; want %q", rowIndex, columnIndex, records[rowIndex][columnIndex], want[rowIndex][columnIndex])
			}
		}
	}
}
