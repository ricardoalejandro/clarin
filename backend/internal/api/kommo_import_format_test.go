package api

import (
	"strings"
	"testing"
)

func TestValidateKommoIquitosV2HeadersAcceptsApprovedSchema(t *testing.T) {
	headers := append([]string(nil), kommoIquitosV2Headers...)
	if err := validateKommoIquitosV2Headers(headers); err != nil {
		t.Fatalf("approved schema was rejected: %v", err)
	}
}

func TestValidateKommoIquitosV2HeadersRejectsStructuralChanges(t *testing.T) {
	tests := []struct {
		name    string
		headers []string
	}{
		{name: "missing column", headers: append([]string(nil), kommoIquitosV2Headers[:len(kommoIquitosV2Headers)-1]...)},
		{name: "renamed column", headers: func() []string {
			headers := append([]string(nil), kommoIquitosV2Headers...)
			headers[18] = "Nueva atención"
			return headers
		}()},
		{name: "reordered columns", headers: func() []string {
			headers := append([]string(nil), kommoIquitosV2Headers...)
			headers[18], headers[19] = headers[19], headers[18]
			return headers
		}()},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateKommoIquitosV2Headers(tt.headers)
			if err == nil || !strings.Contains(err.Error(), "FORMATO_KOMMO_INCOMPATIBLE") {
				t.Fatalf("expected a blocking format error, got %v", err)
			}
		})
	}
}

func TestShouldBlockCSVImportContact(t *testing.T) {
	tests := []struct {
		name       string
		strict     bool
		importType string
		active     int
		want       bool
	}{
		{name: "open lead blocks Kommo lead import", strict: true, importType: "leads", active: 1, want: true},
		{name: "multiple open leads still block", strict: true, importType: "both", active: 2, want: true},
		{name: "no open lead allows creation", strict: true, importType: "leads", active: 0, want: false},
		{name: "contact-only import is unaffected", strict: true, importType: "contacts", active: 1, want: false},
		{name: "generic import keeps legacy behavior", strict: false, importType: "leads", active: 1, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldBlockCSVImportContact(tt.strict, tt.importType, tt.active); got != tt.want {
				t.Fatalf("shouldBlockCSVImportContact() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestMarkCSVImportRuntimeDuplicateCorrectsPlannedCounters(t *testing.T) {
	summary := csvImportSummary{New: 2, NewOpportunities: 2, NewContacts: 2, Skipped: 3}
	markCSVImportRuntimeDuplicate(&summary, csvImportRecord{WillCreateContact: true})
	if summary.New != 1 || summary.NewOpportunities != 1 || summary.NewContacts != 1 {
		t.Fatalf("planned creation counters were not corrected: %+v", summary)
	}
	if summary.Skipped != 4 || summary.Duplicates != 1 || summary.DuplicateContactLeads != 1 {
		t.Fatalf("duplicate counters were not recorded: %+v", summary)
	}
}
