package repository

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/database"
)

var taskIntegrityMigration sync.Once
var taskIntegrityMigrationError error

type taskIntegrityFixture struct {
	pool                                                *pgxpool.Pool
	account, actor, environment, list, workflow, status uuid.UUID
}

func newTaskIntegrityFixture(t *testing.T) taskIntegrityFixture {
	t.Helper()
	raw := os.Getenv("TASK_INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TASK_INTEGRITY_TEST_DATABASE_URL requires isolated synthetic QA database")
	}
	config, err := pgxpool.ParseConfig(raw)
	if err != nil {
		t.Fatal("invalid QA database configuration")
	}
	if !strings.Contains(config.ConnConfig.Database, "test") && !strings.Contains(config.ConnConfig.Database, "qa") {
		t.Fatal("refusing non-QA database")
	}
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal("connect QA database")
	}
	t.Cleanup(pool.Close)
	taskIntegrityMigration.Do(func() { taskIntegrityMigrationError = database.Migrate(pool) })
	if taskIntegrityMigrationError != nil {
		t.Fatal(taskIntegrityMigrationError)
	}
	f := taskIntegrityFixture{pool: pool, account: uuid.New(), actor: uuid.New(), environment: uuid.New(), list: uuid.New(), workflow: uuid.New(), status: uuid.New()}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Task integrity synthetic')`, f.account)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active) VALUES($1,$2,$3,$4,'synthetic-hash','QA Actor','agent',TRUE)`, f.actor, f.account, f.actor.String(), f.actor.String()+"@test.invalid")
	exec(`INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, f.actor, f.account)
	exec(`INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by) VALUES($1,$2,'QA Work','account','edit',$3)`, f.environment, f.account, f.actor)
	exec(`INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by) VALUES($1,$2,$3,'QA Flow',TRUE,$4)`, f.workflow, f.account, f.environment, f.actor)
	exec(`INSERT INTO task_statuses(id,account_id,workflow_id,name,color,category,sort_order,is_default) VALUES($1,$2,$3,'Open','#64748B','not_started',0,TRUE)`, f.status, f.account, f.workflow)
	exec(`INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,created_by) VALUES($1,$2,$3,$4,'QA List',$5)`, f.list, f.account, f.environment, f.workflow, f.actor)
	return f
}

func (f taskIntegrityFixture) task(title string) *domain.Task {
	return &domain.Task{AccountID: f.account, CreatedBy: f.actor, AssignedTo: f.actor, Title: title, Type: domain.TaskTypeReminder, Priority: domain.TaskPriorityMedium, Status: domain.TaskStatusPending, ListID: &f.list, StatusID: &f.status, MutationActor: &f.actor, ProgressMode: "manual"}
}

func TestTaskIntegrityOnlineCreateConcurrentReplayAndPayloadConflict(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo := &TaskRepository{db: f.pool}
	ctx := context.Background()
	operation := uuid.New()
	results := make(chan *domain.Task, 8)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			task := f.task("Once")
			task.MutationOperationID = &operation
			task.CreatePayloadHash = "same-payload"
			err := repo.Create(ctx, task)
			errs <- err
			results <- task
		}()
	}
	wg.Wait()
	close(errs)
	close(results)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id uuid.UUID
	replays := 0
	for task := range results {
		if id == uuid.Nil {
			id = task.ID
		}
		if id != task.ID {
			t.Fatal("duplicate task after retry")
		}
		if task.CreateReplayed {
			replays++
		}
	}
	if replays != 7 {
		t.Fatalf("replays=%d", replays)
	}
	var tasks, activity, receipts int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks WHERE account_id=$1),(SELECT COUNT(*) FROM task_activity WHERE account_id=$1),(SELECT COUNT(*) FROM task_create_receipts WHERE account_id=$1)`, f.account).Scan(&tasks, &activity, &receipts); err != nil {
		t.Fatal(err)
	}
	if tasks != 1 || activity != 1 || receipts != 1 {
		t.Fatalf("tasks/activity/receipts=%d/%d/%d", tasks, activity, receipts)
	}
	changed := f.task("Changed")
	changed.MutationOperationID = &operation
	changed.CreatePayloadHash = "other-payload"
	if err := repo.Create(ctx, changed); !errors.Is(err, ErrTaskOperationPayloadConflict) {
		t.Fatalf("conflict=%v", err)
	}
	// Same operation in another account is independent, never a foreign replay.
	other := newTaskIntegrityFixture(t)
	foreign := other.task("Other account")
	foreign.MutationOperationID = &operation
	foreign.CreatePayloadHash = "same-payload"
	if err := repo.Create(ctx, foreign); err != nil {
		t.Fatal(err)
	}
	if foreign.ID == id || foreign.CreateReplayed {
		t.Fatal("cross-account replay")
	}
}

func TestTaskIntegrityCreateReceiptRollbackActorScopeAndDeletedReplay(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo, ctx := &TaskRepository{db: f.pool}, context.Background()
	operation := uuid.New()
	invalid := f.task("Retry rejected request")
	invalid.MutationOperationID = &operation
	invalid.CreatePayloadHash = "same"
	badStatus := uuid.New()
	invalid.StatusID = &badStatus
	if err := repo.Create(ctx, invalid); err == nil {
		t.Fatal("invalid status accepted")
	}
	var receipts int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_create_receipts WHERE account_id=$1`, f.account).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatalf("failed transaction consumed operation: %d %v", receipts, err)
	}
	valid := f.task("Retry rejected request")
	valid.MutationOperationID = &operation
	valid.CreatePayloadHash = "same"
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	minutes := 15
	valid.DueAt = &start
	valid.ReminderMinutes = &minutes
	if err := repo.Create(ctx, valid); err != nil {
		t.Fatal(err)
	}
	var reminders int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE task_id=$1`, valid.ID).Scan(&reminders); err != nil || reminders != 1 {
		t.Fatalf("receipt committed without reminder: %d %v", reminders, err)
	}
	second := f
	second.actor = uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active) VALUES($1,$2,$3,$4,'synthetic-hash','QA Second','agent',TRUE)`, second.actor, f.account, second.actor.String(), second.actor.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'admin',TRUE)`, second.actor, f.account); err != nil {
		t.Fatal(err)
	}
	other := second.task("Other actor")
	other.MutationOperationID = &operation
	other.CreatePayloadHash = "same"
	if err := repo.Create(ctx, other); err != nil {
		t.Fatal(err)
	}
	if other.CreateReplayed || other.ID == valid.ID {
		t.Fatal("receipt not actor-scoped")
	}
	if _, err := f.pool.Exec(ctx, `UPDATE tasks SET deleted_at=NOW() WHERE account_id=$1 AND id=$2`, f.account, valid.ID); err != nil {
		t.Fatal(err)
	}
	retry := f.task("Retry rejected request")
	retry.MutationOperationID = &operation
	retry.CreatePayloadHash = "same"
	if err := repo.Create(ctx, retry); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("deleted result recreated or leaked: %v", err)
	}
	var tasks int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1`, f.account).Scan(&tasks); err != nil || tasks != 2 {
		t.Fatalf("deleted replay recreated: %d %v", tasks, err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM tasks WHERE account_id=$1 AND id=$2`, f.account, valid.ID); err != nil {
		t.Fatal(err)
	}
	if err := repo.Create(ctx, retry); !errors.Is(err, ErrTaskWorkNotFound) {
		t.Fatalf("purged result recreated or exposed: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1`, f.account).Scan(&tasks); err != nil || tasks != 1 {
		t.Fatalf("purged replay recreated: %d %v", tasks, err)
	}
}

func TestTaskIntegrityChildCreateRetryRecordsParentActivityOnce(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo, ctx := &TaskRepository{db: f.pool}, context.Background()
	parent := f.task("Parent")
	if err := repo.Create(ctx, parent); err != nil {
		t.Fatal(err)
	}
	operation := uuid.New()
	var childID uuid.UUID
	for attempt := 0; attempt < 2; attempt++ {
		child := f.task("Child")
		child.ParentTaskID = &parent.ID
		child.CreatePayloadHash = "child:" + parent.ID.String() + ":payload"
		child.MutationOperationID = &operation
		if err := repo.Create(ctx, child); err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			childID = child.ID
		} else if child.ID != childID || !child.CreateReplayed {
			t.Fatal("child retry duplicated")
		}
	}
	var children, parentActivity, childActivity int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM tasks WHERE parent_task_id=$1),(SELECT COUNT(*) FROM task_activity WHERE task_id=$1 AND action='subtask_created'),(SELECT COUNT(*) FROM task_activity WHERE task_id=$2 AND action='created')`, parent.ID, childID).Scan(&children, &parentActivity, &childActivity); err != nil {
		t.Fatal(err)
	}
	if children != 1 || parentActivity != 1 || childActivity != 1 {
		t.Fatalf("child/parent activity/child activity = %d/%d/%d", children, parentActivity, childActivity)
	}
}

func TestTaskIntegrityBulkDatesRollbackAndReminderReschedule(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo := &TaskRepository{db: f.pool}
	work := &TaskWorkRepository{db: f.pool}
	ctx := context.Background()
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	due := start.Add(2 * time.Hour)
	minutes := 30
	tasks := []*domain.Task{f.task("First"), f.task("Second")}
	for _, task := range tasks {
		task.StartAt = &start
		task.DueAt = &due
		legacyEnd := due.Add(time.Hour)
		task.DueEndAt = &legacyEnd
		task.ReminderMinutes = &minutes
		if err := repo.Create(ctx, task); err != nil {
			t.Fatal(err)
		}
		if err := repo.SyncReminder(ctx, task.ID); err != nil {
			t.Fatal(err)
		}
	}
	items := []TaskVersionInput{{ID: tasks[0].ID, Version: 1}, {ID: tasks[1].ID, Version: 1}}
	if _, err := work.BulkUpdateTasks(ctx, f.account, TaskBulkUpdateInput{Items: items, Property: "due_at", Value: start.Add(-time.Minute), ActorID: f.actor}); !errors.Is(err, ErrTaskBulkUpdateInvalid) {
		t.Fatalf("reverse date accepted: %v", err)
	}
	var untouched int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND version=1 AND due_at=$2`, f.account, due).Scan(&untouched); err != nil || untouched != 2 {
		t.Fatalf("partial mutation %d: %v", untouched, err)
	}
	next := due.Add(24 * time.Hour)
	if _, err := work.BulkUpdateTasks(ctx, f.account, TaskBulkUpdateInput{Items: items, Property: "due_at", Value: next, ActorID: f.actor}); err != nil {
		t.Fatal(err)
	}
	var legacyEnds int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND due_end_at IS NOT NULL`, f.account).Scan(&legacyEnds); err != nil || legacyEnds != 0 {
		t.Fatalf("bulk retained stale legacy date: %d %v", legacyEnds, err)
	}
	var reminders int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE account_id=$1 AND reminder_at=$2 AND NOT delivered`, f.account, next.Add(-30*time.Minute)).Scan(&reminders); err != nil || reminders != 2 {
		t.Fatalf("stale reminders=%d err=%v", reminders, err)
	}
	for i := range items {
		items[i].Version = 2
	}
	newOwner := uuid.New()
	if _, err := f.pool.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name,role,is_active) VALUES($1,$2,$3,$4,'synthetic-hash','QA Owner','agent',TRUE)`, newOwner, f.account, newOwner.String(), newOwner.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES($1,$2,'agent',TRUE)`, newOwner, f.account); err != nil {
		t.Fatal(err)
	}
	if _, err := work.BulkUpdateTasks(ctx, f.account, TaskBulkUpdateInput{Items: items, Property: "assigned_to", Value: newOwner, ActorID: f.actor}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE account_id=$1 AND assigned_to=$2 AND reminder_at=$3`, f.account, newOwner, next.Add(-30*time.Minute)).Scan(&reminders); err != nil || reminders != 2 {
		t.Fatalf("reminder recipient stale: %d %v", reminders, err)
	}
	for i := range items {
		items[i].Version = 3
	}
	if _, err := work.BulkUpdateTasks(ctx, f.account, TaskBulkUpdateInput{Items: items, Property: "due_at", Value: nil, ActorID: f.actor}); err != nil {
		t.Fatal(err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM task_reminders WHERE account_id=$1`, f.account).Scan(&reminders); err != nil || reminders != 0 {
		t.Fatalf("removed date retained reminders=%d %v", reminders, err)
	}
}

func TestTaskIntegritySummaryAndAgendaUseFullFilteredCollection(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo := &TaskRepository{db: f.pool}
	work := &TaskWorkRepository{db: f.pool}
	ctx := context.Background()
	start := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	due := start.Add(time.Hour)
	if _, err := f.pool.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,description,type,priority,status,status_id,list_id,start_at,due_at,notes,recurrence_rule,sort_order) SELECT gen_random_uuid(),$1,$2,$2,'Matches '||n,'','reminder',CASE WHEN n<=51 THEN 'high' ELSE 'low' END,'pending',$3,$4,$5::timestamptz,$6::timestamptz,'','',n*1024 FROM generate_series(1,55) n`, f.account, f.actor, f.status, f.list, start, due); err != nil {
		t.Fatal(err)
	}
	filters := map[string]string{"search": "Matches", "priorities": "high"}
	summary, err := work.Summary(ctx, f.account, f.actor, &f.environment, nil, nil, false, filters)
	if err != nil {
		t.Fatal(err)
	}
	if summary["total"] != float64(51) {
		t.Fatalf("page-limited/incorrect summary: %#v", summary)
	}
	owners := summary["by_owner"].([]any)
	if len(owners) != 1 || owners[0].(map[string]any)["count"] != float64(51) {
		t.Fatal("owner aggregation incorrect")
	}
	page, err := repo.GetAgendaRangeForActor(ctx, f.account, f.actor, start.Add(-time.Hour), due.Add(time.Hour), &f.environment, nil, nil, false, nil, "", 201, filters)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 51 {
		t.Fatalf("agenda filters returned %d", len(page))
	}
	filters["search"] = "Absent"
	page, err = repo.GetAgendaRangeForActor(ctx, f.account, f.actor, start.Add(-time.Hour), due.Add(time.Hour), &f.environment, nil, nil, false, nil, "", 201, filters)
	if err != nil || len(page) != 0 {
		t.Fatalf("search mismatch count=%d err=%v", len(page), err)
	}
	// Every aggregate and agenda query must apply the same actor ACL before
	// grouping/paging, even when the user owns the now-denied task.
	if _, err := f.pool.Exec(ctx, `UPDATE user_accounts SET role='agent' WHERE account_id=$1 AND user_id=$2`, f.account, f.actor); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by) SELECT account_id,id,$2,'none',$2 FROM tasks WHERE account_id=$1 AND priority='high' ORDER BY id LIMIT 1`, f.account, f.actor); err != nil {
		t.Fatal(err)
	}
	filters["search"] = "Matches"
	summary, err = work.Summary(ctx, f.account, f.actor, &f.environment, nil, nil, false, filters)
	if err != nil {
		t.Fatal(err)
	}
	if summary["total"] != float64(50) {
		t.Fatalf("summary leaks revoked row: %v", summary["total"])
	}
	page, err = repo.GetAgendaRangeForActor(ctx, f.account, f.actor, start.Add(-time.Hour), due.Add(time.Hour), &f.environment, nil, nil, false, nil, "", 201, filters)
	if err != nil || len(page) != 50 {
		t.Fatalf("agenda leaks revoked row: %d %v", len(page), err)
	}
}

func TestTaskIntegrityGanttEndResizePropagatesLagAndRemindersAtomically(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo, work, ctx := &TaskRepository{db: f.pool}, &TaskWorkRepository{db: f.pool}, context.Background()
	start := time.Now().UTC().Add(48 * time.Hour).Truncate(time.Second)
	rootDue, childStart, childDue := start.Add(time.Hour), start.Add(2*time.Hour), start.Add(3*time.Hour)
	minutes := 15
	root, child := f.task("Predecessor"), f.task("Successor")
	root.StartAt, root.DueAt, root.ReminderMinutes = &start, &rootDue, &minutes
	child.StartAt, child.DueAt, child.ReminderMinutes = &childStart, &childDue, &minutes
	legacyEnd := childDue.Add(time.Hour)
	root.DueEndAt, child.DueEndAt = &legacyEnd, &legacyEnd
	for _, task := range []*domain.Task{root, child} {
		if err := repo.Create(ctx, task); err != nil {
			t.Fatal(err)
		}
		if err := repo.SyncReminder(ctx, task.ID); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO task_dependencies(id,account_id,predecessor_task_id,successor_task_id,dependency_type,lag_minutes,created_by) VALUES($1,$2,$3,$4,'finish_to_start',30,$5)`, uuid.New(), f.account, root.ID, child.ID, f.actor); err != nil {
		t.Fatal(err)
	}
	newDue := start.Add(4 * time.Hour)
	result, err := work.RescheduleTaskChain(ctx, f.account, TaskGanttRescheduleInput{TaskID: root.ID, Version: 1, StartAt: start, DueAt: newDue, RescheduleDependencies: true, ActorID: f.actor})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 2 {
		t.Fatalf("unchanged-start end resize changed %d tasks", len(result.TaskIDs))
	}
	var legacyEnds int
	if err := f.pool.QueryRow(ctx, `SELECT COUNT(*) FROM tasks WHERE account_id=$1 AND due_end_at IS NOT NULL`, f.account).Scan(&legacyEnds); err != nil || legacyEnds != 0 {
		t.Fatalf("Gantt retained stale legacy date: %d %v", legacyEnds, err)
	}
	var gotStart, gotDue, reminder time.Time
	var version int64
	if err := f.pool.QueryRow(ctx, `SELECT t.start_at,t.due_at,t.version,r.reminder_at FROM tasks t JOIN task_reminders r ON r.task_id=t.id AND r.account_id=t.account_id WHERE t.account_id=$1 AND t.id=$2`, f.account, child.ID).Scan(&gotStart, &gotDue, &version, &reminder); err != nil {
		t.Fatal(err)
	}
	wantStart := newDue.Add(30 * time.Minute)
	wantDue := wantStart.Add(time.Hour)
	if !gotStart.Equal(wantStart) || !gotDue.Equal(wantDue) || !reminder.Equal(wantDue.Add(-15*time.Minute)) || version != 2 {
		t.Fatalf("schedule/reminder mismatch: start=%v due=%v reminder=%v version=%d", gotStart, gotDue, reminder, version)
	}
	// Shortening the predecessor preserves the successor's planned slack and version.
	result, err = work.RescheduleTaskChain(ctx, f.account, TaskGanttRescheduleInput{TaskID: root.ID, Version: 2, StartAt: start, DueAt: rootDue, RescheduleDependencies: true, ActorID: f.actor})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.TaskIDs) != 1 {
		t.Fatal("shortening pulled successor earlier")
	}
	if _, err = work.RescheduleTaskChain(ctx, f.account, TaskGanttRescheduleInput{TaskID: root.ID, Version: 2, StartAt: start, DueAt: newDue.Add(time.Hour), RescheduleDependencies: true, ActorID: f.actor}); !errors.Is(err, ErrTaskVersionConflict) {
		t.Fatalf("stale version accepted: %v", err)
	}
}

func TestTaskIntegrityEventAgendaSentinelTemporalCursorAndCapacity(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo, ctx := &WorkEventRepository{db: f.pool}, context.Background()
	start := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	// Timed events precede a next-day all-day event; sort must not move that
	// all-day event ahead of the earlier dates before taking the page boundary.
	if _, err := f.pool.Exec(ctx, `INSERT INTO work_events(account_id,list_id,organizer_id,created_by,title,start_at,end_at) SELECT $1,$2,$3,$3,'Timed '||n,$4::timestamptz+(n||' milliseconds')::interval,$4::timestamptz+INTERVAL '1 hour' FROM generate_series(1,205) n`, f.account, f.list, f.actor, start); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO work_events(account_id,list_id,organizer_id,created_by,title,is_all_day,start_date,end_date_exclusive) VALUES($1,$2,$3,$3,'Next day',TRUE,'2026-10-13','2026-10-14')`, f.account, f.list, f.actor); err != nil {
		t.Fatal(err)
	}
	from, to := start.Add(-time.Hour), start.Add(48*time.Hour)
	first, err := repo.ListAgenda(ctx, f.account, f.actor, from, to, &f.environment, nil, nil, nil, "", 201)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != 201 {
		t.Fatalf("sentinel lost: %d", len(first))
	}
	if first[0].Event.IsAllDay {
		t.Fatal("future all-day event incorrectly sorts first")
	}
	last, key := workEventAgendaOrder(first[199])
	rest, err := repo.ListAgenda(ctx, f.account, f.actor, from, to, &f.environment, nil, nil, &last, key, 201)
	if err != nil {
		t.Fatal(err)
	}
	if len(rest) != 6 || !rest[len(rest)-1].Event.IsAllDay {
		t.Fatalf("cursor skipped or duplicated items: %d", len(rest))
	}
	seen := map[string]bool{}
	for _, item := range append(first[:200], rest...) {
		_, key := workEventAgendaOrder(item)
		if seen[key] {
			t.Fatal("duplicate page item")
		}
		seen[key] = true
	}
	if len(seen) != 206 {
		t.Fatal("missing page item")
	}
	// Candidate overflow is explicit, rather than returning a plausible partial calendar.
	if _, err := f.pool.Exec(ctx, `INSERT INTO work_events(account_id,list_id,organizer_id,created_by,title,start_at,end_at) SELECT $1,$2,$3,$3,'Capacity '||n,$4::timestamptz,$4::timestamptz+INTERVAL '1 hour' FROM generate_series(1,4800) n`, f.account, f.list, f.actor, start); err != nil {
		t.Fatal(err)
	}
	if _, err = repo.ListAgenda(ctx, f.account, f.actor, from, to, &f.environment, nil, nil, nil, "", 201); !errors.Is(err, ErrWorkEventAgendaCapacity) {
		t.Fatalf("silent truncation: %v", err)
	}
}
