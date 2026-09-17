package repository

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestOfflineV3TaskCreateStrictFunctionalContract(t *testing.T) {
	input, err := parseOfflineV3TaskCreate(json.RawMessage(`{"title":"  Cerrar informe  ","description":"Descripción\nsegunda línea","start_at":null,"due_at":"2026-09-15T13:00:00Z","due_end_at":null,"is_all_day":false,"priority":"high"}`))
	if err != nil || input.Title != "Cerrar informe" || input.Priority != "high" || input.DueAt == nil {
		t.Fatalf("valid create rejected: %v", err)
	}
	for name, raw := range map[string]string{
		"empty": "{}", "null": "null", "array": "[]", "case folded": `{"TITLE":"x"}`,
		"duplicate": `{"title":"a","title":"b"}`, "account injection": `{"title":"x","account_id":"a"}`,
		"list injection": `{"title":"x","list_id":"a"}`, "actor injection": `{"title":"x","assigned_to":"a"}`,
		"extra operation": `{"title":"x"} {}`, "date": `{"title":"x","due_at":"yesterday"}`,
		"end without due": `{"title":"x","due_end_at":"2026-09-15T00:00:00Z"}`,
		"reversed dates":  `{"title":"x","start_at":"2026-09-16T00:00:00Z","due_at":"2026-09-15T00:00:00Z"}`,
		"priority":        `{"title":"x","priority":"critical"}`, "too long": `{"title":"` + strings.Repeat("x", 501) + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseOfflineV3TaskCreate(json.RawMessage(raw)); err == nil {
				t.Fatal("invalid create accepted")
			}
		})
	}
}

func TestOfflineV3TaskResultDoesNotSerializeCRMOrAccountMetadata(t *testing.T) {
	contact := uuid.New()
	account := uuid.New()
	task := &domain.Task{ID: uuid.New(), AccountID: account, Title: "Selected task", ContactID: &contact, ContactName: "Private Contact", LeadName: "Private Lead", EventName: "Private Event", ProgramName: "Private Program", Notes: "Internal notes", Version: 7, StatusDetail: &domain.TaskStatus{Category: domain.TaskStatusCategoryDone}}
	raw, err := json.Marshal(OfflineV3TaskProjection(task))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"Private", "Internal notes", contact.String(), account.String(), "contact_id", "account_id", "notes", "lead_name", "program_name"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("unselected metadata leaked: %s", forbidden)
		}
	}
	if !strings.Contains(string(raw), `"status_category":"done"`) || !strings.Contains(string(raw), `"version":7`) {
		t.Fatal("canonical task status/version omitted")
	}
}

func TestOfflineV3TaskBindingNeverFallsBackBetweenUsersOrAccounts(t *testing.T) {
	record := &OfflineV3AuthRecord{OfflineV3Grant: domain.OfflineV3Grant{OfflineV3Tuple: domain.OfflineV3Tuple{GrantID: uuid.New(), AccountID: uuid.New(), UserID: uuid.New(), BrowserProfileID: uuid.New()}}}
	base := domain.OfflineV3Operation{ProtocolVersion: 3, GrantID: record.GrantID, AccountID: record.AccountID, UserID: record.UserID, BrowserProfileID: record.BrowserProfileID, OperationID: uuid.New(), ResourceID: uuid.New(), SelectionID: uuid.New(), Action: domain.OfflineV3ActionTasksCreate, OccurredAt: time.Now()}
	if !offlineV3TaskBindingValid(record, base, strings.Repeat("a", 64)) {
		t.Fatal("valid binding rejected")
	}
	for name, mutate := range map[string]func(*domain.OfflineV3Operation){
		"user": func(o *domain.OfflineV3Operation) { o.UserID = uuid.New() }, "account": func(o *domain.OfflineV3Operation) { o.AccountID = uuid.New() }, "browser": func(o *domain.OfflineV3Operation) { o.BrowserProfileID = uuid.New() }, "grant": func(o *domain.OfflineV3Operation) { o.GrantID = uuid.New() }, "v2": func(o *domain.OfflineV3Operation) { o.ProtocolVersion = 2 }, "unsupported write": func(o *domain.OfflineV3Operation) { o.Action = "task.update_simple" }, "future": func(o *domain.OfflineV3Operation) { o.OccurredAt = time.Now().Add(time.Hour) },
	} {
		t.Run(name, func(t *testing.T) {
			operation := base
			mutate(&operation)
			if offlineV3TaskBindingValid(record, operation, strings.Repeat("a", 64)) {
				t.Fatal("foreign binding accepted")
			}
		})
	}
	if offlineV3TaskBindingValid(nil, base, strings.Repeat("a", 64)) || offlineV3TaskBindingValid(record, base, "invalid") {
		t.Fatal("missing authority accepted")
	}
}
