package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestLeadPolicyCancelsHistoricalReportJobsWithoutDeletingHistory(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	other := integrityProgram(t, pool)
	ctx := context.Background()
	accounts := &AccountRepository{db: pool}
	// The report API and worker are retired. Synthetic historical rows retain
	// coverage of the existing account-policy cancellation and retention rules.
	queued, running, completed, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	for _, row := range []struct {
		id, account, user uuid.UUID
		status            string
	}{
		{queued, f.account, f.user, "queued"},
		{running, f.account, f.user, "running"},
		{completed, f.account, f.user, "completed"},
		{foreign, other.account, other.user, "running"},
	} {
		integrityExec(t, pool, `INSERT INTO lead_intelligence_report_runs(id,account_id,user_id,idempotency_key,status,summary) VALUES($1,$2,$3,$4,$5,'{"preserved":true}'::jsonb)`, row.id, row.account, row.user, uuid.New(), row.status)
		integrityExec(t, pool, `INSERT INTO lead_intelligence_report_items(run_id,account_id,lead_id,position,row_data) VALUES($1,$2,$3,0,'{"preserved":true}'::jsonb)`, row.id, row.account, uuid.New())
	}
	if _, err := accounts.UpdateLeadPolicy(ctx, f.account, f.user, 1, false, true); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct {
		id     uuid.UUID
		status string
	}{
		{queued, "cancelled"},
		{running, "cancelled"},
		{completed, "completed"},
		{foreign, "running"},
	} {
		var status, preserved string
		var items int
		if err := pool.QueryRow(ctx, `SELECT status,summary->>'preserved',(SELECT COUNT(*) FROM lead_intelligence_report_items WHERE run_id=r.id AND account_id=r.account_id) FROM lead_intelligence_report_runs r WHERE id=$1`, row.id).Scan(&status, &preserved, &items); err != nil {
			t.Fatal(err)
		}
		if status != row.status || preserved != "true" || items != 1 {
			t.Fatalf("historical report changed: status=%s preserved=%s items=%d", status, preserved, items)
		}
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
