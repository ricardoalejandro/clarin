package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

func offlineV3FixtureOperation(f offlineV3Fixture) domain.OfflineV3Operation {
	return domain.OfflineV3Operation{ProtocolVersion: 3, GrantID: f.GrantID, UserID: f.UserID, AccountID: f.AccountID, BrowserProfileID: f.BrowserProfileID, OperationID: uuid.New(), Action: domain.OfflineV3ActionTasksCreate, SelectionID: f.SelectionID, ResourceID: uuid.New(), Payload: json.RawMessage(`{"title":"Offline atomic task","description":"Fixture"}`), OccurredAt: time.Now().UTC()}
}

func applyOfflineV3TestOperation(ctx context.Context, pool *pgxpool.Pool, f offlineV3Fixture, op domain.OfflineV3Operation, hash string, commit bool) (domain.OfflineV3OperationResult, error) {
	record, err := f.Repository.AuthRecord(ctx, f.GrantID)
	if err != nil {
		return domain.OfflineV3OperationResult{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return domain.OfflineV3OperationResult{}, err
	}
	defer tx.Rollback(ctx)
	result, err := f.Repository.ApplyTaskOperationTx(ctx, tx, record, op, hash)
	if err == nil && commit {
		err = tx.Commit(ctx)
	}
	return result, err
}

func offlineV3TaskCounts(t *testing.T, pool *pgxpool.Pool, f offlineV3Fixture, taskID uuid.UUID) [4]int {
	t.Helper()
	var counts [4]int
	err := pool.QueryRow(context.Background(), `SELECT
	(SELECT count(*) FROM tasks WHERE account_id=$1 AND id=$2),
	(SELECT count(*) FROM task_activity WHERE account_id=$1 AND task_id=$2),
	(SELECT count(*) FROM offline_v3_receipts WHERE grant_id=$3 AND resource_id=$2),
	(SELECT count(*) FROM offline_v3_event_outbox WHERE grant_id=$3 AND payload->>'task_id'=$2::text)`, f.AccountID, taskID, f.GrantID).Scan(&counts[0], &counts[1], &counts[2], &counts[3])
	if err != nil {
		t.Fatal(err)
	}
	return counts
}

func TestOfflineV3TaskAtomicCreateCompleteAndReplayPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	op := offlineV3FixtureOperation(f)
	hash := stringsOf("a", 64)
	created, err := applyOfflineV3TestOperation(ctx, pool, f, op, hash, true)
	if err != nil || created.Status != "applied" {
		t.Fatalf("create: %+v %v", created, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 1, 1, 1} {
		t.Fatalf("create atomic counts: %v", got)
	}
	replayed, err := applyOfflineV3TestOperation(ctx, pool, f, op, hash, true)
	var createdJSON, replayedJSON any
	createdBytes, _ := json.Marshal(created)
	replayedBytes, _ := json.Marshal(replayed)
	_ = json.Unmarshal(createdBytes, &createdJSON)
	_ = json.Unmarshal(replayedBytes, &replayedJSON)
	if err != nil || !reflect.DeepEqual(createdJSON, replayedJSON) {
		t.Fatalf("replay: %+v %v", replayed, err)
	}
	_, err = applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("b", 64), true)
	if !errors.Is(err, ErrOfflineV3ReceiptReuse) {
		t.Fatalf("different envelope reused receipt: %v", err)
	}
	complete := op
	complete.OperationID = uuid.New()
	complete.Action = domain.OfflineV3ActionTasksComplete
	complete.BaseVersion = created.ServerVersion
	complete.Payload = json.RawMessage(`{}`)
	done, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("c", 64), true)
	if err != nil || done.Status != "applied" || done.ServerVersion <= created.ServerVersion {
		t.Fatalf("complete: %+v %v", done, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 2, 2, 2} {
		t.Fatalf("complete counts: %v", got)
	}
	complete.OperationID = uuid.New()
	noop, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("d", 64), true)
	if err != nil || noop.Status != "noop" {
		t.Fatalf("already done: %+v %v", noop, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 2, 3, 2} {
		t.Fatalf("noop emitted effects: %v", got)
	}
}

func TestOfflineV3TaskDependentCreateCompletePostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	create := offlineV3FixtureOperation(f)
	complete := create
	complete.OperationID = uuid.New()
	complete.Action = domain.OfflineV3ActionTasksComplete
	complete.DependsOnOperationID = &create.OperationID
	complete.Payload = json.RawMessage(`{}`)
	if _, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("b", 64), true); !errors.Is(err, ErrOfflineV3DependencyPending) {
		t.Fatalf("out-of-order dependency: %v", err)
	}
	if got := offlineV3TaskCounts(t, pool, f, create.ResourceID); got != [4]int{} {
		t.Fatalf("pending dependency wrote effects: %v", got)
	}
	created, err := applyOfflineV3TestOperation(ctx, pool, f, create, stringsOf("a", 64), true)
	if err != nil || created.Status != "applied" {
		t.Fatalf("create: %+v %v", created, err)
	}
	var result struct {
		Task OfflineV3TaskValue `json:"task"`
	}
	if json.Unmarshal(created.Result, &result) != nil || !result.Task.CanComplete {
		t.Fatal("canonical create receipt missing effective completion capability")
	}
	done, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("b", 64), true)
	if err != nil || done.Status != "applied" || done.ServerVersion <= created.ServerVersion {
		t.Fatalf("dependent complete: %+v %v", done, err)
	}
	if _, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("b", 64), true); err != nil {
		t.Fatal(err)
	}
	if got := offlineV3TaskCounts(t, pool, f, create.ResourceID); got != [4]int{1, 2, 2, 2} {
		t.Fatalf("dependent/replayed effects: %v", got)
	}
	for _, kind := range []string{"other_resource", "self", "positive_base", "create_dependency", "missing_dependency"} {
		t.Run(kind, func(t *testing.T) {
			op := complete
			op.OperationID = uuid.New()
			switch kind {
			case "other_resource":
				op.ResourceID = uuid.New()
			case "self":
				op.DependsOnOperationID = &op.OperationID
			case "positive_base":
				op.BaseVersion = 1
			case "create_dependency":
				op.Action = domain.OfflineV3ActionTasksCreate
			case "missing_dependency":
				op.DependsOnOperationID = nil
			}
			result, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("c", 64), true)
			if err != nil || result.Status != "rejected" {
				t.Fatalf("invalid dependency accepted: %+v %v", result, err)
			}
		})
	}
	// A real online update between create and its dependent completion remains
	// a version conflict. Dependency is not an unconditional overwrite grant.
	other := offlineV3FixtureOperation(f)
	_, err = applyOfflineV3TestOperation(ctx, pool, f, other, stringsOf("d", 64), true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET title='Server changed',version=version+1 WHERE id=$1 AND account_id=$2`, other.ResourceID, f.AccountID); err != nil {
		t.Fatal(err)
	}
	complete.OperationID = uuid.New()
	complete.ResourceID = other.ResourceID
	complete.DependsOnOperationID = &other.OperationID
	conflicted, err := applyOfflineV3TestOperation(ctx, pool, f, complete, stringsOf("e", 64), true)
	if err != nil || conflicted.Status != "conflict" {
		t.Fatalf("dependency bypassed concurrency: %+v %v", conflicted, err)
	}
}

func TestOfflineV3TaskRollbackAndConcurrentReplayPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	op := offlineV3FixtureOperation(f)
	hash := stringsOf("a", 64)
	rolled, err := applyOfflineV3TestOperation(ctx, pool, f, op, hash, false)
	if err != nil || rolled.Status != "applied" {
		t.Fatalf("before rollback: %+v %v", rolled, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{} {
		t.Fatalf("rollback left effects: %v", got)
	}
	const n = 4
	var wg sync.WaitGroup
	results := make(chan error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result, err := applyOfflineV3TestOperation(ctx, pool, f, op, hash, true)
			if err == nil && result.Status != "applied" {
				err = errors.New("not applied")
			}
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 1, 1, 1} {
		t.Fatalf("concurrent replay duplicated effects: %v", got)
	}
}

func TestOfflineV3TaskScopeRejectionsHaveNoMutationPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	for _, kind := range []string{"account", "user", "browser", "selection", "injected_owner"} {
		t.Run(kind, func(t *testing.T) {
			op := offlineV3FixtureOperation(f)
			switch kind {
			case "account":
				op.AccountID = f.ForeignAccountID
			case "user":
				op.UserID = f.ForeignUserID
			case "browser":
				op.BrowserProfileID = uuid.New()
			case "selection":
				op.SelectionID = uuid.New()
			case "injected_owner":
				op.Payload = json.RawMessage(`{"title":"x","assigned_to":"` + f.ForeignUserID.String() + `"}`)
			}
			result, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("a", 64), true)
			if err == nil && result.Status != "rejected" {
				t.Fatalf("invalid accepted: %+v", result)
			}
			got := offlineV3TaskCounts(t, pool, f, op.ResourceID)
			if got[0] != 0 || got[1] != 0 || got[3] != 0 {
				t.Fatalf("rejection left task effects: %v", got)
			}
		})
	}
}

func TestOfflineV3TaskListEditWithEnvironmentViewAndRootDenyPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	roleID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks'])`, roleID, "offline-acl-"+roleID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_accounts SET role='agent',role_id=$3 WHERE user_id=$1 AND account_id=$2`, f.UserID, f.AccountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_environments SET default_access_level='view' WHERE id=$1 AND account_id=$2`, f.EnvironmentID, f.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by) VALUES($1,$2,$3,'edit',$3)`, f.AccountID, f.ListID, f.UserID); err != nil {
		t.Fatal(err)
	}
	// Fixture-only stand-in for a fresh authenticated reauthorization after the
	// role changed; production must never skip the credential/authority ceremony.
	if _, err := pool.Exec(ctx, `UPDATE offline_v3_grants grant_item SET last_authenticated_credential_epoch=u.offline_credential_epoch,
	last_authenticated_authority_epoch=u.offline_authority_epoch+epoch.authority_epoch
	FROM users u,offline_v3_membership_epochs epoch WHERE grant_item.id=$1 AND u.id=$2 AND epoch.user_id=u.id AND epoch.account_id=$3`, f.GrantID, f.UserID, f.AccountID); err != nil {
		t.Fatal(err)
	}
	op := offlineV3FixtureOperation(f)
	created, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("a", 64), true)
	if err != nil || created.Status != "applied" {
		t.Fatalf("Entorno Ver plus list Editar must create: %+v %v", created, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by) VALUES($1,$2,$3,'view',$3)`, f.AccountID, op.ResourceID, f.UserID); err != nil {
		t.Fatal(err)
	}
	op.OperationID = uuid.New()
	op.Action = domain.OfflineV3ActionTasksComplete
	op.BaseVersion = created.ServerVersion
	op.Payload = json.RawMessage(`{}`)
	rejected, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("b", 64), true)
	if err != nil || rejected.Status != "rejected" {
		t.Fatalf("root Ver must override list Editar: %+v %v", rejected, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 1, 2, 1} {
		t.Fatalf("denied completion changed task: %v", got)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_access_grants SET access_level='edit' WHERE account_id=$1 AND task_id=$2 AND user_id=$3`, f.AccountID, op.ResourceID, f.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_list_access_grants SET access_level='view' WHERE account_id=$1 AND list_id=$2 AND user_id=$3`, f.AccountID, f.ListID, f.UserID); err != nil {
		t.Fatal(err)
	}
	op.OperationID = uuid.New()
	allowed, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("c", 64), true)
	if err != nil || allowed.Status != "applied" {
		t.Fatalf("root Editar with list Ver must complete: %+v %v", allowed, err)
	}
}

func TestOfflineV3TaskConflictPreservesServerAndPersistsReviewPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	op := offlineV3FixtureOperation(f)
	created, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("a", 64), true)
	if err != nil || created.Status != "applied" {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE tasks SET title='Canonical newer title',version=version+1 WHERE id=$1 AND account_id=$2`, op.ResourceID, f.AccountID); err != nil {
		t.Fatal(err)
	}
	op.OperationID = uuid.New()
	op.Action = domain.OfflineV3ActionTasksComplete
	op.BaseVersion = created.ServerVersion
	op.Payload = json.RawMessage(`{}`)
	result, err := applyOfflineV3TestOperation(ctx, pool, f, op, stringsOf("b", 64), true)
	if err != nil || result.Status != "conflict" {
		t.Fatalf("stale write: %+v %v", result, err)
	}
	var conflicts int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM offline_v3_conflicts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`, f.GrantID, f.AccountID, op.OperationID).Scan(&conflicts); err != nil || conflicts != 1 {
		t.Fatalf("conflict absent: %d %v", conflicts, err)
	}
	if got := offlineV3TaskCounts(t, pool, f, op.ResourceID); got != [4]int{1, 1, 2, 1} {
		t.Fatalf("conflict mutated task/effects: %v", got)
	}
}

func TestOfflineV3TaskOutboxCorruptionDoesNotBlockHealthyAccountPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	// Make the exact two rows earliest; never truncate other tests' fixtures.
	corruptID, healthyID := uuid.New(), uuid.New()
	badOperation, goodOperation := uuid.New(), uuid.New()
	healthy := OfflineV3TaskEffect{ID: healthyID, GrantID: f.GrantID, AccountID: f.AccountID, OperationID: goodOperation, TaskID: uuid.New(), ActorID: f.UserID, Action: domain.OfflineV3ActionTasksCreate, TaskVersion: 1}
	raw, _ := json.Marshal(healthy)
	if _, err := pool.Exec(ctx, `INSERT INTO offline_v3_receipts(grant_id,account_id,operation_id,request_hash,action_code,resource_id,status,server_version,result)
	VALUES($1,$2,$3,$5,'tasks.create',$6,'applied',1,'{}'),($1,$2,$4,$5,'tasks.create',$6,'applied',1,'{}')`, f.GrantID, f.AccountID, badOperation, goodOperation, stringsOf("a", 64), healthy.TaskID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO offline_v3_event_outbox(id,grant_id,account_id,operation_id,event_type,payload,next_attempt_at)
	VALUES($1,$2,$3,$4,'task_effect','{}','1970-01-01'),($5,$2,$3,$6,'task_effect',$7::jsonb,'1970-01-02')`, corruptID, f.GrantID, f.AccountID, badOperation, healthyID, goodOperation, raw); err != nil {
		t.Fatal(err)
	}
	effects, err := f.Repository.ClaimTaskEffects(ctx, 2)
	if err != nil || len(effects) != 1 || effects[0].ID != healthyID {
		t.Fatalf("corrupt row blocked healthy effect: %+v %v", effects, err)
	}
	var code string
	var retained bool
	if err := pool.QueryRow(ctx, `SELECT last_error_code,processed_at IS NULL AND next_attempt_at>NOW() FROM offline_v3_event_outbox WHERE id=$1`, corruptID).Scan(&code, &retained); err != nil || code != "task_effect_binding_invalid" || !retained {
		t.Fatalf("corrupt evidence lost: %s %v %v", code, retained, err)
	}
	if err := f.Repository.FinishTaskEffect(ctx, effects[0], true); err != nil {
		t.Fatal(err)
	}
	if err := f.Repository.FinishTaskEffect(ctx, effects[0], false); err != nil {
		t.Fatal(err)
	}
	var done bool
	if err := pool.QueryRow(ctx, `SELECT processed_at IS NOT NULL AND last_error_code IS NULL FROM offline_v3_event_outbox WHERE id=$1`, healthyID).Scan(&done); err != nil || !done {
		t.Fatalf("late retry undid ACK: %v %v", done, err)
	}
}

func TestOfflineV3CanonicalSubtaskInheritsRootGrantNotListPostgres(t *testing.T) {
	pool := offlineV3TestPool(t)
	f := seedOfflineV3Fixture(t, pool)
	ctx := context.Background()
	root := offlineV3FixtureOperation(f)
	result, err := applyOfflineV3TestOperation(ctx, pool, f, root, stringsOf("a", 64), true)
	if err != nil || result.Status != "applied" {
		t.Fatal(err)
	}
	roleID := uuid.New()
	if _, err := pool.Exec(ctx, `INSERT INTO roles(id,name,permissions) VALUES($1,$2,ARRAY['tasks'])`, roleID, "offline-subtask-"+roleID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE user_accounts SET role='agent',role_id=$3 WHERE user_id=$1 AND account_id=$2`, f.UserID, f.AccountID, roleID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE task_environments SET default_access_level='view' WHERE id=$1 AND account_id=$2`, f.EnvironmentID, f.AccountID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by) VALUES($1,$2,$3,'edit',$3)`, f.AccountID, root.ResourceID, f.UserID); err != nil {
		t.Fatal(err)
	}
	tasks := &TaskRepository{db: pool}
	task := &domain.Task{AccountID: f.AccountID, CreatedBy: f.UserID, AssignedTo: f.UserID, Title: "Subtask via root grant", Type: domain.TaskTypeReminder, Status: domain.TaskStatusPending, Priority: domain.TaskPriorityMedium, ListID: &f.ListID, ParentTaskID: &root.ResourceID, StatusID: &f.NotStartedStatusID, ProgressMode: "manual", Placement: "bottom", CollaboratorsSet: true, MutationActor: &f.UserID}
	if err := tasks.Create(ctx, task); err != nil {
		t.Fatalf("root Editar must allow subtask with Entorno/list Ver: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM tasks WHERE id=$1 AND parent_task_id=$2 AND account_id=$3`, task.ID, root.ResourceID, f.AccountID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("canonical subtask absent: %d %v", count, err)
	}
}
