package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestLeadReportsRejectDisabledAndStalePublication(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	ctx := context.Background()
	accounts := &AccountRepository{db: pool}
	reports := &LeadIntelligenceReportRepository{db: pool}
	run, _, err := reports.CreateRun(ctx, &domain.LeadIntelligenceReportRun{AccountID: f.account, UserID: f.user, IdempotencyKey: uuid.New()})
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, pool, `UPDATE lead_intelligence_report_runs SET status='running' WHERE id=$1`, run.ID)
	old := WithLeadPolicyVersion(ctx, 1)
	if err := reports.ReplaceItems(old, run, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := accounts.UpdateLeadPolicy(ctx, f.account, f.user, 1, false, true); err != nil {
		t.Fatal(err)
	}
	if err := reports.ReplaceItems(old, run, nil); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("disabled rows: %v", err)
	}
	if err := reports.Complete(old, run.ID, nil, nil, false); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("disabled completion: %v", err)
	}
	if _, _, err := reports.CreateRun(ctx, &domain.LeadIntelligenceReportRun{AccountID: f.account, UserID: f.user}); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("disabled queue: %v", err)
	}
	if _, err := accounts.UpdateLeadPolicy(ctx, f.account, f.user, 2, true, true); err != nil {
		t.Fatal(err)
	}
	if err := reports.Complete(old, run.ID, nil, nil, false); !errors.Is(err, ErrLeadPolicyConflict) {
		t.Fatalf("stale completion: %v", err)
	}
	if err := reports.ReplaceItems(WithLeadPolicyVersion(ctx, 3), run, nil); !errors.Is(err, ErrLeadPolicyConflict) {
		t.Fatalf("cancelled run revived: %v", err)
	}
	saved, err := reports.GetRun(ctx, f.account, f.user, run.ID)
	if err != nil || saved.Status != "cancelled" {
		t.Fatalf("cancelled history: %+v %v", saved, err)
	}
}

func TestErosLeadPublicationGuardPreservesGenericChat(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	ctx := context.Background()
	conversation := uuid.New()
	integrityExec(t, pool, `INSERT INTO eros_conversations(id,account_id,user_id,title) VALUES($1,$2,$3,'Synthetic policy conversation')`, conversation, f.account, f.user)
	runs := &ErosRunRepository{db: pool}
	run, _, err := runs.CreateWithUserMessage(ctx, &domain.ErosRun{AccountID: f.account, UserID: f.user, ConversationID: conversation, Kind: "chat", Permissions: []string{}, IdempotencyKey: uuid.New().String()}, "Synthetic request")
	if err != nil {
		t.Fatal(err)
	}
	integrityExec(t, pool, `UPDATE eros_runs SET status='running' WHERE id=$1`, run.ID)
	accounts := &AccountRepository{db: pool}
	if _, err = accounts.UpdateLeadPolicy(ctx, f.account, f.user, 1, false, true); err != nil {
		t.Fatal(err)
	}
	if _, err = runs.Complete(WithLeadPolicyVersion(ctx, 1), run, "Commercial result", "test", "none", 0, nil, nil, nil, nil); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("lead publish allowed: %v", err)
	}
	sets := &ErosResultSetRepository{db: pool}
	if _, err = sets.Save(ctx, &domain.ErosResultSet{AccountID: f.account, UserID: f.user, RunID: run.ID, EntityType: "lead", SourceTool: "search_leads", Fields: []string{}}); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("lead memory saved: %v", err)
	}
	if _, err = runs.Complete(ctx, run, "Independent response", "test", "none", 0, nil, nil, nil, nil); err != nil {
		t.Fatalf("generic Eros blocked: %v", err)
	}
}
