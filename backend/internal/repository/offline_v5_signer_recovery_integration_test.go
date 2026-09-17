package repository

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

func offlineV5IntegrationPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("OFFLINE_V5_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("OFFLINE_V5_TEST_DATABASE_URL required for dedicated synthetic DB")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Path != "/v5_integration" {
		t.Fatal("integration tests require exact disposable database v5_integration")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := database.Migrate(pool); err != nil {
		t.Fatalf("migrate disposable PostgreSQL: %v", err)
	}
	return pool
}

func requireOfflineV5IntegrationPrepare(t *testing.T, label string, result *OfflineV5PrepareResult, err error) *OfflineV5PrepareResult {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if result == nil {
		t.Fatalf("%s: repository returned a nil result without an error", label)
	}
	return result
}

func requireOfflineV5IntegrationSync(t *testing.T, label string, result *OfflineV5SyncResult, err error) *OfflineV5SyncResult {
	t.Helper()
	if err != nil {
		t.Fatalf("%s: %v", label, err)
	}
	if result == nil {
		t.Fatalf("%s: repository returned a nil result without an error", label)
	}
	return result
}

// This reproduces the response-delivery window precisely: the task command and
// receipt commit, RefreshManifest supersedes the client's manifest, and the
// refreshed candidate is discarded as though the detached signer timed out.
// The original request must then recover its receipt and another fresh manifest
// without reaching tasks.UpdateTx or emitting the task effect a second time.
func TestOfflineV5IntegrationSignerTimeoutAfterTaskUpdateRecoversWithoutReplay(t *testing.T) {
	pool := offlineV5IntegrationPool(t)
	ctx := context.Background()
	repository := &OfflineV5Repository{db: pool}
	accountID, userID, superadminID := uuid.New(), uuid.New(), uuid.New()
	profileID, environmentID, workflowID, statusID, listID, taskID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'V5 recovery account')`, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status) VALUES($1,'free','active')`, accountID); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []struct {
		id    uuid.UUID
		super bool
		// The offline target is deliberately a superadmin while the approving
		// superadmin is a different actor. The resulting grant is still limited to
		// this account, Tasks and the selected list.
	}{{userID, true}, {superadminID, true}} {
		if _, err := pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,is_active,is_super_admin)
			VALUES($1,$2,$3,$4,'test-only-hash',TRUE,$5)`, actor.id, accountID, "v5-"+actor.id.String(), actor.id.String()+"@test.invalid", actor.super); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, actor.id, accountID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by)
		VALUES($1,$2,'V5 recovery environment','account','edit',$3)`, environmentID, accountID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by)
		VALUES($1,$2,$3,'V5 recovery workflow',TRUE,$4)`, workflowID, accountID, environmentID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default)
		VALUES($1,$2,$3,'Open','#64748b','not_started',0,TRUE)`, statusID, accountID, workflowID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'V5 recovery list',$5)`, listID, accountID, environmentID, workflowID, userID); err != nil {
		t.Fatal(err)
	}
	if err := (&TaskRepository{db: pool}).Create(ctx, &domain.Task{ID: taskID, AccountID: accountID, CreatedBy: userID,
		AssignedTo: userID, Title: "before signer timeout", Type: domain.TaskTypeReminder, Priority: domain.TaskPriorityMedium,
		Status: domain.TaskStatusPending, StatusID: &statusID, ListID: &listID, ProgressMode: "manual"}); err != nil {
		t.Fatal(err)
	}

	key := json.RawMessage(`{"kty":"EC","crv":"P-256","x":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","y":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","alg":"ES256","use":"sig","kid":"v5-recovery"}`)
	enrollmentChallenge, err := repository.CreateChallenge(ctx, userID, uuid.Nil, "enrollment")
	if err != nil {
		t.Fatal(err)
	}
	requestID, err := repository.RequestEnrollment(ctx, OfflineV4EnrollmentInput{BrowserProfileID: profileID, UserID: userID,
		BrowserName: "Recovery browser", DisplayName: "Recovery profile", SigningJWK: key, KeyThumbprint: profileID.String()},
		enrollmentChallenge.ID, enrollmentChallenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	grants, err := repository.Approve(ctx, requestID, superadminID, []OfflineV5GrantApproval{{AccountID: accountID,
		Modules: []string{domain.OfflineModuleTasks}, MaxResources: 20, QuotaBytes: 32 << 20}})
	if err != nil {
		t.Fatalf("approve v5 grant: %v", err)
	}
	if len(grants) != 1 {
		t.Fatalf("approve v5 grant: count=%d", len(grants))
	}
	grantID := grants[0].GrantID
	keyChallenge, err := repository.CreateChallenge(ctx, userID, grantID, "keys")
	if err != nil {
		t.Fatal(err)
	}
	if err := repository.RegisterKey(ctx, grantID, userID, keyChallenge.ID, keyChallenge.Nonce, key, "grant-"+grantID.String()); err != nil {
		t.Fatal(err)
	}
	if err := repository.ReplaceSelections(ctx, grantID, userID, 1, []domain.OfflineV3Selection{{
		Module: domain.OfflineModuleTasks, ResourceType: "task_list", ResourceID: listID,
	}}); err != nil {
		t.Fatal(err)
	}
	// Preparation challenges are bound to both the authenticated user and the
	// grant. Match handleOfflineV5GrantChallenge instead of issuing a sync-style
	// grant-only challenge, otherwise consumption must correctly fail closed.
	prepareChallenge, err := repository.CreateChallenge(ctx, userID, grantID, "prepare")
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := repository.Prepare(ctx, grantID, userID, true, nil, prepareChallenge.ID, prepareChallenge.Nonce)
	prepared = requireOfflineV5IntegrationPrepare(t, "prepare initial manifest", prepared, err)
	if len(prepared.Manifest.Roots) != 1 {
		t.Fatalf("prepare initial manifest: roots=%d", len(prepared.Manifest.Roots))
	}
	selectionID := prepared.Manifest.Roots[0].SelectionID
	var baseVersion int64
	if err := pool.QueryRow(ctx, `SELECT version FROM tasks WHERE id=$1 AND account_id=$2`, taskID, accountID).Scan(&baseVersion); err != nil {
		t.Fatal(err)
	}
	operation := domain.OfflineV5Operation{ProtocolVersion: domain.OfflineV5ProtocolVersion, BrowserProfileID: profileID,
		GrantID: grantID, UserID: userID, AccountID: accountID, ManifestID: prepared.Manifest.ID,
		ManifestRevision: prepared.Manifest.Revision, SelectionID: selectionID, SelectionRevision: prepared.Record.SelectionRevision,
		CredentialEpoch: prepared.Record.CredentialEpoch, AuthorityEpoch: prepared.Record.AuthorityEpoch,
		OperationID: uuid.New(), Action: domain.OfflineV5ActionTasksUpdate, ResourceID: taskID, BaseVersion: baseVersion,
		Base: json.RawMessage(`{"title":"before signer timeout"}`), Payload: json.RawMessage(`{"title":"after signer timeout"}`), OccurredAt: time.Now().UTC()}
	syncOnce := func(writes bool, preprocess OfflineV5OperationPreprocessor) (*OfflineV5SyncResult, error) {
		challenge, challengeErr := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
		if challengeErr != nil {
			return nil, challengeErr
		}
		return repository.SyncWithPreprocessor(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
			ChallengeID: challenge.ID, Nonce: challenge.Nonce, ManifestID: prepared.Manifest.ID,
			ManifestRevision: prepared.Manifest.Revision, SelectionRevision: prepared.Record.SelectionRevision,
			Operations: []domain.OfflineV5Operation{operation}, WantSnapshots: []uuid.UUID{selectionID}}, prepared.Record, writes, preprocess)
	}

	first, err := syncOnce(true, nil)
	first = requireOfflineV5IntegrationSync(t, "initial task update", first, err)
	if first.RecoveredReceipts || len(first.Receipts) != 1 || first.Receipts[0].Status != "applied" {
		t.Fatalf("initial task update: result=%+v", first)
	}
	preprocessCalls := 0
	currentRetry, err := syncOnce(false, func(context.Context, *OfflineV5AuthRecord, *domain.OfflineV5Operation) error {
		preprocessCalls++
		return errors.New("current-manifest receipt recovery must not preprocess a committed operation")
	})
	currentRetry = requireOfflineV5IntegrationSync(t, "receipt-only retry before manifest refresh", currentRetry, err)
	if !currentRetry.RecoveredReceipts || len(currentRetry.Receipts) != 1 ||
		currentRetry.Receipts[0].OperationID != first.Receipts[0].OperationID || preprocessCalls != 0 {
		t.Fatalf("current-manifest receipt recovery failed: result=%+v preprocess_calls=%d", currentRetry, preprocessCalls)
	}
	failedDeliveryManifest, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	failedDeliveryManifest = requireOfflineV5IntegrationPrepare(t, "prepare response candidate before simulated signer timeout", failedDeliveryManifest, err)
	if failedDeliveryManifest.Manifest.ID == prepared.Manifest.ID {
		t.Fatal("refresh did not supersede the client manifest")
	}
	// The candidate above is intentionally not confirmed/delivered: equivalent
	// to signOfflineV5Manifest returning context.DeadlineExceeded.
	simulatedSigner := func(context.Context) error { return context.DeadlineExceeded }
	if err := simulatedSigner(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("unreachable signer-timeout sentinel")
	}

	preprocessCalls = 0
	retry, err := syncOnce(false, func(context.Context, *OfflineV5AuthRecord, *domain.OfflineV5Operation) error {
		preprocessCalls++
		return errors.New("receipt recovery must not preprocess a committed operation")
	})
	retry = requireOfflineV5IntegrationSync(t, "receipt-only retry after signer timeout", retry, err)
	if preprocessCalls != 0 {
		t.Fatalf("receipt recovery invoked operation preprocessing %d times", preprocessCalls)
	}
	if !retry.RecoveredReceipts || len(retry.Receipts) != 1 || retry.Receipts[0].OperationID != first.Receipts[0].OperationID ||
		retry.Receipts[0].Status != first.Receipts[0].Status || retry.Receipts[0].ServerVersion != first.Receipts[0].ServerVersion ||
		!offlineV5JSONEqual(retry.Receipts[0].Result, first.Receipts[0].Result) {
		t.Fatalf("receipt-only retry after signer timeout: first=%+v retry=%+v", first, retry)
	}
	recoveredManifest, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	recoveredManifest = requireOfflineV5IntegrationPrepare(t, "refresh manifest after receipt recovery", recoveredManifest, err)
	if recoveredManifest.Manifest.ID == failedDeliveryManifest.Manifest.ID || recoveredManifest.Manifest.Revision <= failedDeliveryManifest.Manifest.Revision {
		t.Fatalf("fresh manifest was not recoverable: failed=%+v recovered=%+v",
			failedDeliveryManifest.Manifest.ID, recoveredManifest.Manifest.ID)
	}
	var title string
	var version int64
	var receiptCount, effectCount int
	if err := pool.QueryRow(ctx, `SELECT title,version FROM tasks WHERE id=$1 AND account_id=$2`, taskID, accountID).Scan(&title, &version); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM offline_v5_receipts WHERE grant_id=$1 AND operation_id=$2),
		(SELECT count(*) FROM offline_v4_event_outbox WHERE grant_id=$1 AND operation_id=$2 AND event_type='task_effect')`,
		grantID, operation.OperationID).Scan(&receiptCount, &effectCount); err != nil {
		t.Fatal(err)
	}
	if title != "after signer timeout" || version != first.Receipts[0].ServerVersion || receiptCount != 1 || effectCount != 1 {
		t.Fatalf("retry duplicated or lost canonical effect: title=%q version=%d receipts=%d effects=%d", title, version, receiptCount, effectCount)
	}
	blocked := operation
	blocked.ManifestID, blocked.ManifestRevision = recoveredManifest.Manifest.ID, recoveredManifest.Manifest.Revision
	blocked.SelectionRevision, blocked.CredentialEpoch, blocked.AuthorityEpoch = recoveredManifest.Record.SelectionRevision,
		recoveredManifest.Record.CredentialEpoch, recoveredManifest.Record.AuthorityEpoch
	blocked.OperationID, blocked.BaseVersion = uuid.New(), version
	blocked.DependsOnOperationID = nil
	blocked.Base, blocked.Payload = json.RawMessage(`{"title":"after signer timeout"}`), json.RawMessage(`{"title":"must stay blocked"}`)
	blockedChallenge, err := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
	if err != nil {
		t.Fatal(err)
	}
	_, err = repository.Sync(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
		ChallengeID: blockedChallenge.ID, Nonce: blockedChallenge.Nonce, ManifestID: recoveredManifest.Manifest.ID,
		ManifestRevision: recoveredManifest.Manifest.Revision, SelectionRevision: recoveredManifest.Record.SelectionRevision,
		Operations: []domain.OfflineV5Operation{blocked}, WantSnapshots: []uuid.UUID{selectionID}}, recoveredManifest.Record, false)
	if !errors.Is(err, ErrOfflineV5WritesDisabled) {
		t.Fatalf("normal current-manifest write survived global write shutdown: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT title FROM tasks WHERE id=$1 AND account_id=$2`, taskID, accountID).Scan(&title); err != nil || title != "after signer timeout" {
		t.Fatalf("disabled normal write changed task: title=%q err=%v", title, err)
	}

	// Empty sync is the normal online refresh path. If its response manifest is
	// superseded before a signer timeout, retrying the same signed old manifest
	// must remain possible without inventing a receipt or dispatching a command.
	emptySync := func(preparation *OfflineV5PrepareResult) (*OfflineV5SyncResult, error) {
		challenge, challengeErr := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
		if challengeErr != nil {
			return nil, challengeErr
		}
		return repository.Sync(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
			ChallengeID: challenge.ID, Nonce: challenge.Nonce, ManifestID: preparation.Manifest.ID,
			ManifestRevision: preparation.Manifest.Revision, SelectionRevision: preparation.Record.SelectionRevision,
			Operations: []domain.OfflineV5Operation{}, WantSnapshots: []uuid.UUID{selectionID}}, preparation.Record, false)
	}
	emptyFirst, err := emptySync(recoveredManifest)
	emptyFirst = requireOfflineV5IntegrationSync(t, "initial empty refresh sync", emptyFirst, err)
	if emptyFirst.RecoveredReceipts || len(emptyFirst.Receipts) != 0 {
		t.Fatalf("initial empty refresh sync: result=%+v", emptyFirst)
	}
	emptyFailedDelivery, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	emptyFailedDelivery = requireOfflineV5IntegrationPrepare(t, "prepare empty-sync response before simulated signer timeout", emptyFailedDelivery, err)
	if err := simulatedSigner(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("unreachable signer-timeout sentinel")
	}
	emptyRetry, err := emptySync(recoveredManifest)
	emptyRetry = requireOfflineV5IntegrationSync(t, "empty refresh retry after signer timeout", emptyRetry, err)
	if !emptyRetry.RecoveredReceipts || len(emptyRetry.Receipts) != 0 {
		t.Fatalf("empty refresh retry after signer timeout: result=%+v", emptyRetry)
	}
	emptyRecovered, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	emptyRecovered = requireOfflineV5IntegrationPrepare(t, "refresh manifest after empty-sync recovery", emptyRecovered, err)
	if emptyRecovered.Manifest.Revision <= emptyFailedDelivery.Manifest.Revision {
		t.Fatalf("empty refresh did not recover a deliverable manifest: failed=%d recovered=%d",
			emptyFailedDelivery.Manifest.Revision, emptyRecovered.Manifest.Revision)
	}

	dependencyID := uuid.New()
	pendingOperation := operation
	pendingOperation.ManifestID, pendingOperation.ManifestRevision = emptyRecovered.Manifest.ID, emptyRecovered.Manifest.Revision
	pendingOperation.SelectionRevision, pendingOperation.CredentialEpoch, pendingOperation.AuthorityEpoch = emptyRecovered.Record.SelectionRevision,
		emptyRecovered.Record.CredentialEpoch, emptyRecovered.Record.AuthorityEpoch
	pendingOperation.OperationID, pendingOperation.DependsOnOperationID = uuid.New(), &dependencyID
	pendingOperation.BaseVersion = version
	pendingOperation.Base, pendingOperation.Payload = json.RawMessage(`{"title":"after signer timeout"}`), json.RawMessage(`{"title":"must wait for dependency"}`)
	syncPreparedOperation := func(preparation *OfflineV5PrepareResult, candidate domain.OfflineV5Operation, writes bool) (*OfflineV5SyncResult, error) {
		challenge, challengeErr := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
		if challengeErr != nil {
			return nil, challengeErr
		}
		return repository.Sync(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
			ChallengeID: challenge.ID, Nonce: challenge.Nonce, ManifestID: preparation.Manifest.ID,
			ManifestRevision: preparation.Manifest.Revision, SelectionRevision: preparation.Record.SelectionRevision,
			Operations: []domain.OfflineV5Operation{candidate}, WantSnapshots: []uuid.UUID{selectionID}}, preparation.Record, writes)
	}
	pendingFirst, err := syncPreparedOperation(emptyRecovered, pendingOperation, true)
	pendingFirst = requireOfflineV5IntegrationSync(t, "journal dependency-pending operation", pendingFirst, err)
	if len(pendingFirst.Receipts) != 1 || pendingFirst.Receipts[0].Status != "pending" ||
		pendingFirst.Receipts[0].ErrorCode != "operation_dependency_pending" {
		t.Fatalf("dependency-pending result was not journaled: result=%+v", pendingFirst)
	}
	pendingFailedDelivery, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	pendingFailedDelivery = requireOfflineV5IntegrationPrepare(t, "prepare pending response before simulated signer timeout", pendingFailedDelivery, err)
	if err := simulatedSigner(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("unreachable signer-timeout sentinel")
	}
	pendingRetry, err := syncPreparedOperation(emptyRecovered, pendingOperation, false)
	pendingRetry = requireOfflineV5IntegrationSync(t, "recover pending receipt with writes disabled", pendingRetry, err)
	if !pendingRetry.RecoveredReceipts || len(pendingRetry.Receipts) != 1 ||
		pendingRetry.Receipts[0].Status != "pending" || pendingRetry.Receipts[0].ErrorCode != "operation_dependency_pending" {
		t.Fatalf("pending receipt was not recoverable with writes disabled: result=%+v", pendingRetry)
	}
	pendingRecoveredManifest, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	pendingRecoveredManifest = requireOfflineV5IntegrationPrepare(t, "refresh manifest after pending recovery", pendingRecoveredManifest, err)
	if pendingRecoveredManifest.Manifest.Revision <= pendingFailedDelivery.Manifest.Revision {
		t.Fatal("pending delivery did not recover a newer manifest")
	}
	reboundPending := pendingOperation
	reboundPending.ManifestID, reboundPending.ManifestRevision = pendingRecoveredManifest.Manifest.ID, pendingRecoveredManifest.Manifest.Revision
	reboundPending.SelectionRevision, reboundPending.CredentialEpoch, reboundPending.AuthorityEpoch = pendingRecoveredManifest.Record.SelectionRevision,
		pendingRecoveredManifest.Record.CredentialEpoch, pendingRecoveredManifest.Record.AuthorityEpoch
	pendingAgain, err := syncPreparedOperation(pendingRecoveredManifest, reboundPending, true)
	pendingAgain = requireOfflineV5IntegrationSync(t, "rebind authenticated pending intent", pendingAgain, err)
	if len(pendingAgain.Receipts) != 1 || pendingAgain.Receipts[0].Status != "pending" {
		t.Fatalf("authenticated pending intent could not rebind: result=%+v", pendingAgain)
	}
	var pendingReceiptCount, pendingEffectCount int
	var pendingManifestID uuid.UUID
	if err := pool.QueryRow(ctx, `SELECT count(*),COALESCE(max(manifest_id::text),'00000000-0000-0000-0000-000000000000')::uuid
		FROM offline_v5_receipts WHERE grant_id=$1 AND operation_id=$2`, grantID, pendingOperation.OperationID).
		Scan(&pendingReceiptCount, &pendingManifestID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM offline_v4_event_outbox
		WHERE grant_id=$1 AND operation_id=$2`, grantID, pendingOperation.OperationID).Scan(&pendingEffectCount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT title,version FROM tasks WHERE id=$1 AND account_id=$2`, taskID, accountID).Scan(&title, &version); err != nil {
		t.Fatal(err)
	}
	if pendingReceiptCount != 1 || pendingEffectCount != 0 || pendingManifestID != pendingRecoveredManifest.Manifest.ID ||
		title != "after signer timeout" || version != first.Receipts[0].ServerVersion {
		t.Fatalf("pending recovery dispatched or duplicated: receipts=%d effects=%d manifest=%s title=%q version=%d",
			pendingReceiptCount, pendingEffectCount, pendingManifestID, title, version)
	}

	// Interleave the other side of the race: a newer tab satisfies the
	// dependency and advances the same pending intent to terminal while the tab
	// that recovered the older delivery still holds a pending response.
	commentID := uuid.New()
	dependencyOperation := reboundPending
	dependencyOperation.OperationID, dependencyOperation.DependsOnOperationID = dependencyID, nil
	dependencyOperation.Action, dependencyOperation.ResourceID, dependencyOperation.BaseVersion = domain.OfflineV5ActionTasksComment, commentID, 0
	dependencyOperation.Base = nil
	dependencyOperation.Payload = json.RawMessage(`{"task_id":"` + taskID.String() + `","body":"unblock pending recovery"}`)
	terminalChallenge, err := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
	if err != nil {
		t.Fatal(err)
	}
	terminalBatch, err := repository.Sync(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
		ChallengeID: terminalChallenge.ID, Nonce: terminalChallenge.Nonce, ManifestID: pendingRecoveredManifest.Manifest.ID,
		ManifestRevision: pendingRecoveredManifest.Manifest.Revision, SelectionRevision: pendingRecoveredManifest.Record.SelectionRevision,
		Operations: []domain.OfflineV5Operation{dependencyOperation, reboundPending}, WantSnapshots: []uuid.UUID{selectionID}},
		pendingRecoveredManifest.Record, true)
	terminalBatch = requireOfflineV5IntegrationSync(t, "advance pending intent after dependency", terminalBatch, err)
	if len(terminalBatch.Receipts) != 2 || terminalBatch.Receipts[0].Status != "applied" || terminalBatch.Receipts[1].Status != "applied" {
		t.Fatalf("newer rebind did not advance pending intent: result=%+v", terminalBatch)
	}
	terminalVersion := terminalBatch.Receipts[1].ServerVersion
	lateManifest, err := repository.RefreshManifest(ctx, grantID, userID, true, nil)
	lateManifest = requireOfflineV5IntegrationPrepare(t, "refresh manifest before late terminal recovery", lateManifest, err)
	lateRebound := reboundPending
	lateRebound.ManifestID, lateRebound.ManifestRevision = lateManifest.Manifest.ID, lateManifest.Manifest.Revision
	lateRebound.SelectionRevision, lateRebound.CredentialEpoch, lateRebound.AuthorityEpoch = lateManifest.Record.SelectionRevision,
		lateManifest.Record.CredentialEpoch, lateManifest.Record.AuthorityEpoch
	lateResult, err := syncPreparedOperation(lateManifest, lateRebound, true)
	lateResult = requireOfflineV5IntegrationSync(t, "recover newer terminal receipt from older pending response", lateResult, err)
	if len(lateResult.Receipts) != 1 || lateResult.Receipts[0].Status != "applied" ||
		lateResult.Receipts[0].ServerVersion != terminalVersion {
		t.Fatalf("older pending response could not recover newer terminal receipt: result=%+v", lateResult)
	}
	if err := pool.QueryRow(ctx, `SELECT title,version FROM tasks WHERE id=$1 AND account_id=$2`, taskID, accountID).Scan(&title, &version); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM offline_v5_receipts WHERE grant_id=$1 AND operation_id=$2),
		(SELECT count(*) FROM offline_v4_event_outbox WHERE grant_id=$1 AND operation_id=$2 AND event_type='task_effect')`,
		grantID, pendingOperation.OperationID).Scan(&pendingReceiptCount, &pendingEffectCount); err != nil {
		t.Fatal(err)
	}
	if title != "must wait for dependency" || version != terminalVersion || pendingReceiptCount != 1 || pendingEffectCount != 1 {
		t.Fatalf("late terminal recovery replayed mutation: title=%q version=%d receipts=%d effects=%d",
			title, version, pendingReceiptCount, pendingEffectCount)
	}

	if _, err := pool.Exec(ctx, `UPDATE offline_v4_grants SET state='revoked',updated_at=NOW() WHERE id=$1`, grantID); err != nil {
		t.Fatal(err)
	}
	revokedChallenge, err := repository.CreateChallenge(ctx, uuid.Nil, grantID, "sync")
	if err != nil {
		t.Fatal(err)
	}
	preprocessCalls = 0
	_, err = repository.SyncWithPreprocessor(ctx, OfflineV5SyncInput{GrantID: grantID, BrowserProfileID: profileID,
		ChallengeID: revokedChallenge.ID, Nonce: revokedChallenge.Nonce, ManifestID: lateManifest.Manifest.ID,
		ManifestRevision: lateManifest.Manifest.Revision, SelectionRevision: lateManifest.Record.SelectionRevision,
		Operations: []domain.OfflineV5Operation{lateRebound}, WantSnapshots: []uuid.UUID{selectionID}}, lateManifest.Record, true,
		func(context.Context, *OfflineV5AuthRecord, *domain.OfflineV5Operation) error {
			preprocessCalls++
			return nil
		})
	if err == nil {
		t.Fatal("revoked grant reached sync")
	}
	if preprocessCalls != 0 {
		t.Fatalf("revoked grant invoked operation preprocessing %d times", preprocessCalls)
	}
}
