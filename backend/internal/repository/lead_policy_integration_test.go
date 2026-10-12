package repository

import (
	"context"
	"errors"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

var leadPolicyMigrationOnce sync.Once
var leadPolicyMigrationErr error

func leadPolicyTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("LEAD_POLICY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("LEAD_POLICY_TEST_DATABASE_URL requires disposable clarin_policy_tests database")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/clarin_policy_tests" {
		t.Fatal("lead policy tests require exact disposable database clarin_policy_tests")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal("invalid disposable database configuration")
	}
	t.Cleanup(pool.Close)
	leadPolicyMigrationOnce.Do(func() { leadPolicyMigrationErr = database.Migrate(pool) })
	if leadPolicyMigrationErr != nil {
		t.Fatalf("startup migration: %v", leadPolicyMigrationErr)
	}
	var automationSchemaReady bool
	if err = pool.QueryRow(context.Background(), `SELECT to_regclass('automations') IS NOT NULL AND to_regclass('automation_executions') IS NOT NULL AND to_regclass('automation_execution_logs') IS NOT NULL`).Scan(&automationSchemaReady); err != nil || !automationSchemaReady {
		t.Fatalf("Migrate without SeedAdmin must include automation runtime schema: %v", err)
	}
	return pool
}

func leadPolicyFixture(t *testing.T, pool *pgxpool.Pool) (uuid.UUID, uuid.UUID) {
	t.Helper()
	account, contact := uuid.New(), uuid.New()
	integrityExec(t, pool, `INSERT INTO accounts(id,name) VALUES($1,'Synthetic lead policy account')`, account)
	integrityExec(t, pool, `INSERT INTO contacts(id,account_id,jid,name) VALUES($1,$2,$3,'Synthetic contact')`, contact, account, contact.String()+"@test.invalid")
	t.Cleanup(func() { integrityExec(t, pool, `DELETE FROM accounts WHERE id=$1`, account) })
	return account, contact
}

func TestLeadPolicyIntegrationCompatibilityIsolationAndNewActivity(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	accounts := &AccountRepository{db: pool}
	leads := &LeadRepository{db: pool}
	account, contact := leadPolicyFixture(t, pool)
	other, otherContact := leadPolicyFixture(t, pool)
	actor := uuid.New()
	p, err := accounts.GetLeadPolicy(ctx, account)
	if err != nil || !p.AutomationEnabled() || p.Version != 1 || p.AutomationEnabledSince != nil {
		t.Fatalf("defaults: %+v %v", p, err)
	}
	p, err = accounts.UpdateLeadPolicy(ctx, account, actor, 1, true, false)
	if err != nil || p.Version != 2 {
		t.Fatalf("pause automation: %v", err)
	}
	if _, err = leads.EnsureAutomaticLead(ctx, &domain.Lead{AccountID: account, ContactID: &contact}, p.Version, time.Now()); !errors.Is(err, ErrLeadAutomationDisabled) {
		t.Fatalf("automatic creation while paused: %v", err)
	}
	manual := &domain.Lead{AccountID: account, ContactID: &contact}
	if err = leads.Create(ctx, manual); err != nil {
		t.Fatalf("manual creation should remain available: %v", err)
	}
	if count, archiveErr := leads.ArchiveActiveForAccount(ctx, account, []uuid.UUID{manual.ID}, true, "Synthetic reason"); archiveErr != nil || count != 1 {
		t.Fatalf("archive count: %d %v", count, archiveErr)
	}
	if count, archiveErr := leads.ArchiveActiveForAccount(ctx, other, []uuid.UUID{manual.ID}, false, ""); archiveErr != nil || count != 0 {
		t.Fatalf("cross-account archive count: %d %v", count, archiveErr)
	}
	if _, err = leads.EnsureAutomaticLead(ctx, &domain.Lead{AccountID: other, ContactID: &otherContact}, 1, time.Now()); err != nil {
		t.Fatalf("other account affected: %v", err)
	}
	beforeResume := time.Now().Add(-time.Second)
	p, err = accounts.UpdateLeadPolicy(ctx, account, actor, 2, true, true)
	if err != nil || p.AutomationEnabledSince == nil || p.Version != 3 {
		t.Fatalf("resume boundary: %+v %v", p, err)
	}
	if _, err = leads.EnsureAutomaticLead(ctx, &domain.Lead{AccountID: account, ContactID: &contact}, 2, time.Now()); !errors.Is(err, ErrLeadPolicyConflict) {
		t.Fatalf("old epoch accepted: %v", err)
	}
	oldActivity := WithLeadAutomationPolicy(ctx, 2, beforeResume)
	if _, err = accounts.CaptureLeadAutomationContext(oldActivity, account, time.Now()); !errors.Is(err, ErrLeadPolicyConflict) {
		t.Fatalf("queued trigger relabelled as new after reenable: %v", err)
	}
	if _, err = leads.EnsureAutomaticLead(ctx, &domain.Lead{AccountID: account, ContactID: &contact}, 3, beforeResume); !errors.Is(err, ErrLeadAutomationDisabled) {
		t.Fatalf("old source activity accepted: %v", err)
	}
	fresh := &domain.Lead{AccountID: account, ContactID: &contact}
	created, err := leads.EnsureAutomaticLead(ctx, fresh, 3, time.Now())
	if err != nil || created || fresh.ID != manual.ID {
		t.Fatalf("existing historical opportunity duplicated: %v %v", created, err)
	}
	if _, err = leads.EnsureAutomaticLead(ctx, &domain.Lead{AccountID: account, ContactID: &otherContact}, 3, time.Now()); err == nil {
		t.Fatal("cross-account contact accepted")
	}
	p, err = accounts.UpdateLeadPolicy(ctx, account, actor, 3, false, true)
	if err != nil || p.LeadsEnabled {
		t.Fatalf("module pause: %v", err)
	}
	if err = leads.Create(ctx, &domain.Lead{AccountID: account, ContactID: &contact}); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("manual creation bypassed module: %v", err)
	}
	if _, err = leads.ArchiveActiveForAccount(ctx, account, []uuid.UUID{manual.ID}, false, ""); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("archive bypassed confirmed policy: %v", err)
	}
	var count int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM leads WHERE account_id=$1`, account, &count)
	if count != 1 {
		t.Fatalf("historical Leads changed: %d", count)
	}
	if _, err = accounts.UpdateLeadPolicy(ctx, account, actor, 3, true, true); !errors.Is(err, ErrLeadPolicyConflict) {
		t.Fatalf("stale admin update accepted: %v", err)
	}
	same, err := accounts.UpdateLeadPolicy(ctx, account, actor, 4, false, true)
	if err != nil || same.Version != 4 {
		t.Fatalf("no-op advanced epoch: %v", err)
	}
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM account_lead_policy_audit WHERE account_id=$1`, account, &count)
	if count != 3 {
		t.Fatalf("audit expected 3 changes, got %d", count)
	}
}

func integrityScanCount(t *testing.T, pool *pgxpool.Pool, query string, id uuid.UUID, count *int) {
	t.Helper()
	if err := pool.QueryRow(context.Background(), query, id).Scan(count); err != nil {
		t.Fatal(err)
	}
}

func TestLeadPolicyIntegrationConcurrentAutomaticCreation(t *testing.T) {
	pool := leadPolicyTestPool(t)
	account, contact := leadPolicyFixture(t, pool)
	repo := &LeadRepository{db: pool}
	start := make(chan struct{})
	results := make(chan error, 12)
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := repo.EnsureAutomaticLead(context.Background(), &domain.Lead{AccountID: account, ContactID: &contact}, 1, time.Now())
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent ensure: %v", err)
		}
	}
	var count int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM leads WHERE account_id=$1`, account, &count)
	if count != 1 {
		t.Fatalf("two devices duplicated opportunity: %d", count)
	}
}

func TestLeadPolicyIntegrationToggleWaitsForLocalMutation(t *testing.T) {
	pool := leadPolicyTestPool(t)
	account, contact := leadPolicyFixture(t, pool)
	repo := &AccountRepository{db: pool}
	ctx := context.Background()
	leased, release, err := repo.AcquireLeadMutation(ctx, account)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	done := make(chan error, 1)
	go func() { _, err := repo.UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); done <- err }()
	select {
	case err := <-done:
		t.Fatalf("toggle crossed unfinished mutation: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	// The borrowed lease allows nested repository work even with a writer queued.
	writeCtx, cancel := context.WithTimeout(leased, 3*time.Second)
	defer cancel()
	if err = (&LeadRepository{db: pool}).Create(writeCtx, &domain.Lead{AccountID: account, ContactID: &contact}); err != nil {
		t.Fatalf("nested mutation deadlocked: %v", err)
	}
	release()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("toggle did not finish after mutation")
	}
	if err = (&LeadRepository{db: pool}).Create(ctx, &domain.Lead{AccountID: account, ContactID: &contact}); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("post-confirmation write escaped: %v", err)
	}
}

func TestLeadPolicyIntegrationCancelledWorkCannotResumeAndPurgePauses(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	account, contact := leadPolicyFixture(t, pool)
	accounts := &AccountRepository{db: pool}
	leads := &LeadRepository{db: pool}
	auto := &AutomationRepository{db: pool}
	lead := &domain.Lead{AccountID: account, ContactID: &contact}
	if err := leads.Create(ctx, lead); err != nil {
		t.Fatal(err)
	}
	graph := domain.AutomationGraph{Nodes: []domain.AutomationNode{{ID: "wait", Type: "delay", Data: map[string]interface{}{"nodeType": domain.AutoNodeDelay}}}}
	workflow := &domain.Automation{AccountID: account, Name: "Synthetic commercial delay", TriggerType: domain.AutoTriggerLeadCreated, Config: graph, IsActive: true}
	if err := auto.Create(ctx, workflow); err != nil {
		t.Fatal(err)
	}
	execution := &domain.AutomationExecution{AutomationID: workflow.ID, AccountID: account, LeadID: &lead.ID, Status: domain.AutoExecPaused, ConfigSnapshot: &graph, ContextData: map[string]interface{}{"leads_policy_version": int64(1)}}
	if err := auto.CreateExecution(WithLeadAutomationPolicy(ctx, 1, time.Now()), execution); err != nil {
		t.Fatal(err)
	}
	integrityExec(t, pool, `UPDATE leads SET deleted_at=NOW()-INTERVAL '90 days' WHERE id=$1`, lead.ID)
	if _, err := accounts.UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); err != nil {
		t.Fatal(err)
	}
	execution.Status = domain.AutoExecPending
	if err := auto.UpdateExecution(ctx, execution); !errors.Is(err, ErrLeadAutomationDisabled) {
		t.Fatalf("stale scheduler revived cancelled work: %v", err)
	}
	stored, err := auto.GetExecutionByID(ctx, execution.ID)
	if err != nil || stored.Status != domain.AutoExecFailed || stored.ErrorMessage != "lead_policy_paused" {
		t.Fatalf("cancelled history: %+v %v", stored, err)
	}
	if _, err = leads.PurgeExpired(ctx, 30*24*time.Hour); err != nil {
		t.Fatal(err)
	}
	var count int
	integrityScanCount(t, pool, `SELECT COUNT(*) FROM leads WHERE account_id=$1`, account, &count)
	if count != 1 {
		t.Fatal("disabled module history was purged")
	}
	// Canonical Contact identity remains editable while the commercial module is off.
	if err = (&TagRepository{db: pool}).AddContactTagByName(ctx, account, contact, "Synthetic identity tag"); err != nil {
		t.Fatalf("Contact operation blocked: %v", err)
	}
}

func TestLeadPolicyIntegrationContactIdentityCleanupIsIdempotentWhileDisabled(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	account, contact := leadPolicyFixture(t, pool)
	lead := &domain.Lead{AccountID: account, ContactID: &contact}
	if err := (&LeadRepository{db: pool}).Create(ctx, lead); err != nil {
		t.Fatal(err)
	}
	if _, err := (&AccountRepository{db: pool}).UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); err != nil {
		t.Fatal(err)
	}
	staleTime := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	integrityExec(t, pool, `UPDATE leads SET name='Legacy snapshot',updated_at=$2 WHERE id=$1`, lead.ID, staleTime)
	repo := &ContactRepository{db: pool}
	canonical := &domain.Contact{ID: contact, AccountID: account}
	if err := repo.SyncToLead(ctx, canonical); err != nil {
		t.Fatal(err)
	}
	var name *string
	var first time.Time
	if err := pool.QueryRow(ctx, `SELECT name,updated_at FROM leads WHERE id=$1`, lead.ID).Scan(&name, &first); err != nil || name != nil || !first.After(staleTime) {
		t.Fatalf("legacy cleanup failed: %v", err)
	}
	if err := repo.SyncToLead(ctx, canonical); err != nil {
		t.Fatal(err)
	}
	var second time.Time
	if err := pool.QueryRow(ctx, `SELECT updated_at FROM leads WHERE id=$1`, lead.ID).Scan(&second); err != nil {
		t.Fatal(err)
	}
	if !first.Equal(second) {
		t.Fatal("unchanged Contact identity wrote commercial updated_at")
	}
}

func TestLeadPolicyIntegrationCommercialConfigurationGatePreservesNeutralAutomation(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	account, _ := leadPolicyFixture(t, pool)
	repo := &AutomationRepository{db: pool}
	commercial := &domain.Automation{AccountID: account, Name: "Synthetic commercial", TriggerType: domain.AutoTriggerLeadCreated, Config: domain.AutomationGraph{}}
	if err := repo.Create(ctx, commercial); err != nil {
		t.Fatal(err)
	}
	if _, err := (&AccountRepository{db: pool}).UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); err != nil {
		t.Fatal(err)
	}
	if err := repo.SetActive(ctx, commercial.ID, account, true); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("commercial configuration bypass: %v", err)
	}
	if err := repo.Delete(ctx, commercial.ID, account); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("commercial deletion bypass: %v", err)
	}
	commercial.Name = "Blocked edit"
	if err := repo.Update(ctx, commercial); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("commercial edit bypass: %v", err)
	}
	neutral := &domain.Automation{AccountID: account, Name: "Synthetic neutral", TriggerType: domain.AutoTriggerManual, Config: domain.AutomationGraph{Nodes: []domain.AutomationNode{{ID: "delay", Data: map[string]interface{}{"nodeType": domain.AutoNodeDelay, "label": "condition"}}}}}
	if err := repo.Create(ctx, neutral); err != nil {
		t.Fatalf("neutral creation blocked: %v", err)
	}
	if err := repo.SetActive(ctx, neutral.ID, account, true); err != nil {
		t.Fatalf("neutral activation blocked: %v", err)
	}
	neutral.Config.Nodes = append(neutral.Config.Nodes, domain.AutomationNode{ID: "commercial", Data: map[string]interface{}{"nodeType": domain.AutoNodeAssignTag}})
	if err := repo.Update(ctx, neutral); !errors.Is(err, ErrLeadsDisabled) {
		t.Fatalf("neutral to commercial conversion bypassed: %v", err)
	}
	if err := repo.Delete(ctx, neutral.ID, account); err != nil {
		t.Fatalf("neutral deletion blocked: %v", err)
	}
}

func TestLeadPolicyIntegrationRuntimeMigrationPreservesAutomationHistory(t *testing.T) {
	pool := leadPolicyTestPool(t)
	ctx := context.Background()
	account, contact := leadPolicyFixture(t, pool)
	lead := &domain.Lead{AccountID: account, ContactID: &contact}
	if err := (&LeadRepository{db: pool}).Create(ctx, lead); err != nil {
		t.Fatal(err)
	}
	workflowID, executionID, logID := uuid.New(), uuid.New(), uuid.New()
	historicalTime := time.Date(2020, 2, 3, 4, 5, 6, 0, time.UTC)
	integrityExec(t, pool, `INSERT INTO automations
		(id,account_id,name,description,trigger_type,trigger_config,config,is_active,execution_count,last_triggered_at,created_at,updated_at)
		VALUES($1,$2,'Synthetic historical automation','Preserve historical configuration','lead_created',
		'{"origin":"synthetic","nested":{"enabled":true}}',
		'{"nodes":[{"id":"historical-delay","type":"delay","data":{"nodeType":"delay","delay":15}}],"edges":[]}',
		FALSE,7,$3,$3,$3)`, workflowID, account, historicalTime)
	integrityExec(t, pool, `INSERT INTO automation_executions
		(id,automation_id,account_id,lead_id,status,current_node_id,next_node_id,resume_at,config_snapshot,context_data,error_message,started_at,completed_at,created_at)
		VALUES($1,$2,$3,$4,'completed','historical-delay','',NULL,
		'{"nodes":[{"id":"historical-delay","data":{"nodeType":"delay"}}],"edges":[]}',
		'{"origin":"synthetic","values":[1,"historia",true],"leads_policy_version":1}','',$5,$5,$5)`,
		executionID, workflowID, account, lead.ID, historicalTime)
	integrityExec(t, pool, `INSERT INTO automation_execution_logs
		(id,execution_id,node_id,node_type,status,duration_ms,error,created_at)
		VALUES($1,$2,'historical-delay','delay','completed',125,'',$3)`, logID, executionID, historicalTime)
	readHistory := func() [3]string {
		t.Helper()
		var snapshot [3]string
		if err := pool.QueryRow(ctx, `SELECT to_jsonb(a)::text,to_jsonb(e)::text,to_jsonb(l)::text
			FROM automations a JOIN automation_executions e ON e.automation_id=a.id
			JOIN automation_execution_logs l ON l.execution_id=e.id
			WHERE a.id=$1 AND a.account_id=$2 AND e.id=$3 AND e.account_id=$2 AND l.id=$4`,
			workflowID, account, executionID, logID).Scan(&snapshot[0], &snapshot[1], &snapshot[2]); err != nil {
			t.Fatalf("read preserved automation history: %v", err)
		}
		return snapshot
	}
	before := readHistory()
	for pass := 1; pass <= 2; pass++ {
		if err := database.Migrate(pool); err != nil {
			t.Fatalf("repeat startup migration %d: %v", pass, err)
		}
		if after := readHistory(); after != before {
			t.Fatalf("startup migration %d changed automation history, IDs, status or payload", pass)
		}
		var indexes int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM pg_indexes WHERE schemaname=current_schema() AND (tablename,indexname) IN (
			('automations','idx_automations_account'),('automations','idx_automations_trigger'),
			('automation_executions','idx_auto_exec_paused'),('automation_executions','idx_auto_exec_dedup'),
			('automation_executions','idx_auto_exec_account'),('automation_execution_logs','idx_auto_exec_logs'))`).Scan(&indexes); err != nil || indexes != 6 {
			t.Fatalf("startup migration %d must preserve all six runtime indexes: count=%d err=%v", pass, indexes, err)
		}
	}

	// A nil Go graph slice persists as nodes:null. Such neutral work must not
	// make the account's commercial-policy cancellation query fail.
	repo := &AutomationRepository{db: pool}
	neutral := &domain.Automation{AccountID: account, Name: "Synthetic null-node automation", TriggerType: domain.AutoTriggerManual, Config: domain.AutomationGraph{}}
	if err := repo.Create(ctx, neutral); err != nil {
		t.Fatal(err)
	}
	pending := &domain.AutomationExecution{AutomationID: neutral.ID, AccountID: account, Status: domain.AutoExecPending, ConfigSnapshot: &neutral.Config, ContextData: map[string]interface{}{"origin": "synthetic"}}
	if err := repo.CreateExecution(ctx, pending); err != nil {
		t.Fatal(err)
	}
	var nodesAreNull bool
	if err := pool.QueryRow(ctx, `SELECT config_snapshot->'nodes'='null'::jsonb FROM automation_executions WHERE id=$1 AND account_id=$2`, pending.ID, account).Scan(&nodesAreNull); err != nil || !nodesAreNull {
		t.Fatalf("fixture must exercise nodes:null: %v", err)
	}
	if _, err := (&AccountRepository{db: pool}).UpdateLeadPolicy(ctx, account, uuid.New(), 1, false, true); err != nil {
		t.Fatalf("nodes:null must not prevent disabling Leads: %v", err)
	}
	stored, err := repo.GetExecutionByID(ctx, pending.ID)
	if err != nil || stored.Status != domain.AutoExecPending {
		t.Fatalf("neutral pending work changed when disabling Leads: %+v %v", stored, err)
	}
	if after := readHistory(); after != before {
		t.Fatal("disabling Leads changed completed automation history")
	}
}
