package api

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
)

func leadIntelligenceTestFact() leadIntelligenceFact {
	return leadIntelligenceFact{
		LeadID:        uuid.New(),
		Name:          "Lead válido",
		Phone:         "51999999999",
		CreatedAt:     time.Now().UTC(),
		Status:        domain.LeadStatusOpen,
		IncomingCount: 3,
		OutgoingCount: 2,
		AskedDetails:  true,
		Confirmation:  true,
		Attended:      true,
		Evidence:      "Me interesa el curso y deseo confirmar el horario",
	}
}

func TestAnalyzeLeadIntelligenceHardRules(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*leadIntelligenceFact)
	}{
		{name: "do not contact", mutate: func(f *leadIntelligenceFact) { f.DoNotContact = true }},
		{name: "do not contact tag", mutate: func(f *leadIntelligenceFact) { f.LeadTags = []string{"NO_CONTACTAR"} }},
		{name: "converted", mutate: func(f *leadIntelligenceFact) { f.Converted = true }},
		{name: "minor", mutate: func(f *leadIntelligenceFact) { f.Age = 16 }},
		{name: "invalid contact", mutate: func(f *leadIntelligenceFact) { f.Phone = "" }},
		{name: "internal", mutate: func(f *leadIntelligenceFact) { f.Name = "Test respuesta" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fact := leadIntelligenceTestFact()
			tc.mutate(&fact)
			analyzed := analyzeLeadIntelligenceFact(fact, 0)
			if !analyzed.HardLocked {
				t.Fatal("expected the deterministic hard rule to lock this lead")
			}
			if analyzed.Candidate {
				t.Fatal("hard-locked lead must never be sent to AI")
			}
			if analyzed.Row["nivel_prioridad"] != "E" {
				t.Fatalf("expected priority E, got %v", analyzed.Row["nivel_prioridad"])
			}
		})
	}
}

func TestLeadIntelligenceCandidateSelectionIsRankedAndCapped(t *testing.T) {
	rows := make([]leadIntelligenceAnalyzed, 300)
	for i := range rows {
		rows[i] = leadIntelligenceAnalyzed{Score: i % 101, Candidate: true, Position: i}
	}
	selected := selectLeadIntelligenceCandidates(rows)
	if len(selected) != leadIntelligenceAIMaxCandidates {
		t.Fatalf("expected %d candidates, got %d", leadIntelligenceAIMaxCandidates, len(selected))
	}
	for i := 1; i < len(selected); i++ {
		if rows[selected[i-1]].Score < rows[selected[i]].Score {
			t.Fatal("candidates are not sorted by descending deterministic score")
		}
	}
}

func TestApplyLeadIntelligenceAICannotOverrideHardRule(t *testing.T) {
	fact := leadIntelligenceTestFact()
	fact.DoNotContact = true
	row := analyzeLeadIntelligenceFact(fact, 0)
	rows := []leadIntelligenceAnalyzed{row}
	result, err := parseLeadIntelligenceAIResponse(`{"leads":[{"lead_id":"` + fact.LeadID.String() + `","perfil_principal":"Prioridad máxima","interest_score":5,"priority_adjustment":20,"reason":"Llamar ahora","message_type":"Llamada"}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if processed := applyLeadIntelligenceAI(rows, []int{0}, result); processed != 0 {
		t.Fatalf("expected no AI enrichment for hard-locked lead, got %d", processed)
	}
	if rows[0].Row["nivel_prioridad"] != "E" || rows[0].Row["accion_recomendada"] != "No contactar" {
		t.Fatalf("AI changed hard-rule result: %#v", rows[0].Row)
	}
}

func TestNormalizeLeadIntelligenceRequestDefaultsAndValidation(t *testing.T) {
	params, err := normalizeLeadIntelligenceRequest(leadIntelligenceRequest{ObjectiveName: "  Conócete a Ti Mismo  "})
	if err != nil {
		t.Fatal(err)
	}
	if params.ObjectiveType != "course" || params.Scope != "all" || params.ChatHistory != "all" || params.ReasoningEffort != "high" {
		t.Fatalf("unexpected defaults: %#v", params)
	}
	if !params.IncludeArchivedLost || !params.IncludeConverted {
		t.Fatal("archived, lost and converted leads must be included by default")
	}
	if params.ObjectiveName != "Conócete a Ti Mismo" {
		t.Fatalf("objective was not normalized: %q", params.ObjectiveName)
	}
	_, err = normalizeLeadIntelligenceRequest(leadIntelligenceRequest{ObjectiveName: "Objetivo", ObjectiveType: "unknown"})
	if err == nil {
		t.Fatal("expected invalid objective type to fail")
	}
}

func TestLeadIntelligencePrivacyRedaction(t *testing.T) {
	redacted := redactLeadIntelligenceEvidence("Escribe a persona@example.com o llama al +51 999 888 777")
	if strings.Contains(redacted, "persona@example.com") || strings.Contains(redacted, "999 888 777") {
		t.Fatalf("sensitive evidence was not redacted: %q", redacted)
	}
	if !strings.Contains(redacted, "[email]") || !strings.Contains(redacted, "[número]") {
		t.Fatalf("redaction markers are missing: %q", redacted)
	}
}

func TestValidateLeadIntelligenceAIResultRejectsUnknownAndUnsafeScores(t *testing.T) {
	fact := leadIntelligenceTestFact()
	batch := []leadIntelligenceAnalyzed{analyzeLeadIntelligenceFact(fact, 0)}
	unknown, err := parseLeadIntelligenceAIResponse(`{"leads":[{"lead_id":"` + uuid.NewString() + `","interest_score":4,"priority_adjustment":5}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLeadIntelligenceAIResult(unknown, batch); err == nil {
		t.Fatal("expected an identifier outside the requested batch to be rejected")
	}
	unsafe, err := parseLeadIntelligenceAIResponse(`{"leads":[{"lead_id":"` + fact.LeadID.String() + `","interest_score":9,"priority_adjustment":80}]}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := validateLeadIntelligenceAIResult(unsafe, batch); err == nil {
		t.Fatal("expected out-of-range AI scores to be rejected")
	}
}

func TestRecommendedLeadIntelligenceReasoning(t *testing.T) {
	allowed := []string{"low", "medium", "high", "xhigh"}
	effort, _ := recommendedLeadIntelligenceReasoning(80, 15, leadIntelligenceParameters{}, allowed)
	if effort != "medium" {
		t.Fatalf("expected medium for a small cohort, got %q", effort)
	}
	effort, _ = recommendedLeadIntelligenceReasoning(1200, 180, leadIntelligenceParameters{}, allowed)
	if effort != "high" {
		t.Fatalf("expected high for a large cohort, got %q", effort)
	}
	effort, _ = recommendedLeadIntelligenceReasoning(3000, 250, leadIntelligenceParameters{CampaignContext: strings.Repeat("x", 300)}, allowed)
	if effort != "xhigh" {
		t.Fatalf("expected xhigh for a complex maximum-size cohort, got %q", effort)
	}
}

func TestLeadIntelligenceAvailabilityConnectionStates(t *testing.T) {
	tests := []struct {
		name       string
		connection *erosOpenAIConnection
		available  bool
		code       string
	}{
		{name: "bridge down", connection: nil, code: "bridge_unavailable"},
		{name: "authentication rejected", connection: &erosOpenAIConnection{Error: "codex_auth_revoked", RequiresOpenAIAuth: true}, code: "openai_auth_required"},
		{name: "disconnected", connection: &erosOpenAIConnection{RequiresOpenAIAuth: true}, code: "openai_auth_required"},
		{name: "login pending", connection: &erosOpenAIConnection{RequiresOpenAIAuth: true, Login: erosOpenAILoginState{Status: "pending"}}, code: "openai_auth_required"},
		{name: "healthy", connection: &erosOpenAIConnection{Connected: true}, available: true},
		{name: "connected overrides legacy requires flag", connection: &erosOpenAIConnection{Connected: true, RequiresOpenAIAuth: true}, available: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := leadIntelligenceAvailabilityFromConnection(tc.connection)
			if got.Available != tc.available || got.Code != tc.code {
				t.Fatalf("unexpected availability: %#v", got)
			}
		})
	}
}

func TestLiveLeadIntelligenceDeterministicPhase(t *testing.T) {
	if os.Getenv("CLARIN_LIVE_REPORT_TEST") != "1" {
		t.Skip("set CLARIN_LIVE_REPORT_TEST=1 inside a Clarin runtime to exercise the real account-scoped query")
	}
	accountName := strings.TrimSpace(os.Getenv("CLARIN_LIVE_ACCOUNT_NAME"))
	if accountName == "" {
		t.Fatal("CLARIN_LIVE_ACCOUNT_NAME is required")
	}
	cfg := config.Load()
	pool, err := database.Connect(cfg.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var accountID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT id FROM accounts WHERE lower(name)=lower($1) LIMIT 1`, accountName).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	server := &Server{repos: repository.NewRepositories(pool)}
	started := time.Now()
	facts, err := server.loadLeadIntelligenceFacts(ctx, accountID, leadIntelligenceParameters{ObjectiveType: "course", ObjectiveName: "Prueba de rendimiento", Scope: "all", ChatHistory: "all", IncludeArchivedLost: true, IncludeConverted: true, ReasoningEffort: "high"})
	elapsed := time.Since(started)
	if err != nil {
		t.Fatal(err)
	}
	if len(facts) == 0 {
		t.Fatal("the selected account has no leads")
	}
	var messageCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM messages WHERE account_id=$1`, accountID).Scan(&messageCount); err != nil {
		t.Fatal(err)
	}
	t.Logf("deterministic phase: leads=%d messages=%d elapsed=%s", len(facts), messageCount, elapsed)
	if len(facts) >= 2000 && messageCount >= 150000 && elapsed > 10*time.Second {
		t.Fatalf("deterministic phase exceeded the 10 second target: %s", elapsed)
	}
}
