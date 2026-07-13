package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
)

func TestClassifyErosRunError(t *testing.T) {
	tests := []struct {
		message   string
		code      string
		transient bool
	}{
		{"context deadline exceeded", "timeout", true},
		{"bridge returned 500: Reconnecting... 2/5", "bridge_unavailable", true},
		{"codex_auth_revoked", "openai_auth", false},
		{"ACCOUNT_NOT_ALLOWED", "account_denied", false},
		{"unexpected response", "processing_error", false},
	}
	for _, test := range tests {
		code, _, transient := classifyErosRunError(errors.New(test.message))
		if code != test.code || transient != test.transient {
			t.Fatalf("%q: got (%s,%v), want (%s,%v)", test.message, code, transient, test.code, test.transient)
		}
	}
}

func TestQuickTaskPresetCannotBeWeakened(t *testing.T) {
	definition, ok := service.ErosQuickTaskByID(service.ErosQuickTaskLeadUnmanaged)
	if !ok {
		t.Fatal("lead unmanaged task missing")
	}
	if _, err := mergeQuickTaskParameters(definition, map[string]any{"conversation_state": "any"}); err == nil {
		t.Fatal("expected non-schema preset override to be rejected")
	}
}

func TestPerformanceQuickTaskRequiresEveryReportedModule(t *testing.T) {
	definition, ok := service.ErosQuickTaskByID(service.ErosQuickTaskPerformanceOverview)
	if !ok {
		t.Fatal("performance task missing")
	}
	partial := []string{domain.PermBroadcasts, domain.PermEvents, domain.PermPrograms}
	if canUseQuickTask(partial, definition) {
		t.Fatal("task must not expose survey totals without surveys permission")
	}
	all := append(partial, domain.PermSurveys)
	if !canUseQuickTask(all, definition) {
		t.Fatal("task should be available with every reported module permission")
	}
}

func TestAutomaticErosReasoningNeverChangesModelAndSelectsEffort(t *testing.T) {
	settings := &domain.ErosSettings{CodexModel: "admin-fixed-model", AllowedReasoningEfforts: []string{"low", "medium", "high", "xhigh"}}
	tests := []struct{ message, kind, want string }{
		{"Añade sus celulares a esa lista", "chat", "low"},
		{"Busca los leads de Iquitos", "chat", "medium"},
		{"Compara los resultados y prioriza usando varios criterios", "chat", "high"},
		{"Compara, analiza y explica la tendencia y relación entre los grupos, además cruza varios criterios en varios pasos " + string(make([]byte, 901)), "chat", "xhigh"},
		{"Resumen del ciclo", "quick_task", "low"},
	}
	for _, test := range tests {
		got, reason := automaticErosReasoning(test.message, test.kind, "", settings)
		if got != test.want || reason == "" {
			t.Fatalf("%q: effort=%q reason=%q, want %q", test.message, got, reason, test.want)
		}
		if settings.CodexModel != "admin-fixed-model" {
			t.Fatal("automatic routing changed the administrator model")
		}
	}
}

func TestDurableBridgeTurnProtocol(t *testing.T) {
	requests := make([]string, 0, 3)
	bridge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer bridge-secret" {
			t.Fatalf("unexpected authorization: %q", got)
		}
		requests = append(requests, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/turn/start":
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"success":true,"status":"inProgress","codex_thread_id":"thread-1","codex_turn_id":"turn-1"}`))
		case "/turn/read":
			var locator erosBridgeTurnLocator
			if err := json.NewDecoder(r.Body).Decode(&locator); err != nil {
				t.Fatalf("decode locator: %v", err)
			}
			if locator.CodexThreadID != "thread-1" || locator.CodexTurnID != "turn-1" {
				t.Fatalf("unexpected locator: %#v", locator)
			}
			_, _ = w.Write([]byte(`{"success":true,"status":"completed","response":"ok","codex_thread_id":"thread-1","codex_turn_id":"turn-1"}`))
		case "/turn/interrupt":
			_, _ = w.Write([]byte(`{"success":true,"status":"interrupted","codex_thread_id":"thread-1","codex_turn_id":"turn-1"}`))
		default:
			t.Fatalf("unexpected bridge path: %s", r.URL.Path)
		}
	}))
	defer bridge.Close()

	server := &Server{cfg: &config.Config{ErosCodexBridgeToken: "bridge-secret"}}
	settings := &domain.ErosSettings{BridgeURL: bridge.URL}
	started, err := server.startErosBridgeTurn(t.Context(), settings, erosBridgeChatRequest{
		AccountID: "account-1", UserID: "user-1", ConversationID: "conversation-1", Message: "hello",
	})
	if err != nil {
		t.Fatalf("start turn: %v", err)
	}
	if started.CodexThreadID != "thread-1" || started.CodexTurnID != "turn-1" {
		t.Fatalf("unexpected start response: %#v", started)
	}
	completed, err := server.readErosBridgeTurn(t.Context(), settings, started.CodexThreadID, started.CodexTurnID)
	if err != nil || completed.Response != "ok" {
		t.Fatalf("read turn: response=%#v err=%v", completed, err)
	}
	if err := server.interruptErosBridgeTurn(t.Context(), settings, started.CodexThreadID, started.CodexTurnID); err != nil {
		t.Fatalf("interrupt turn: %v", err)
	}
	want := []string{"/turn/start", "/turn/read", "/turn/interrupt"}
	if len(requests) != len(want) {
		t.Fatalf("unexpected requests: %#v", requests)
	}
	for i := range want {
		if requests[i] != want[i] {
			t.Fatalf("request %d = %q, want %q", i, requests[i], want[i])
		}
	}
}
