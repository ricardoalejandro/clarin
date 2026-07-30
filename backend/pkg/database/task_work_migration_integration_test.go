package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskWorkMigrationAndAccountIsolation(t *testing.T) {
	if os.Getenv("CLARIN_RUN_TASK_WORK_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_TASK_WORK_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_task_work_migration_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatalf("connect admin database: %v", err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatalf("create disposable database: %v", err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}

	accountA, accountB := uuid.New(), uuid.New()
	userA, userB := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Task A'),($2,'Task B')`, accountA, accountB); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES
		($1,$3,$4,$5,'test'),($2,$6,$7,$8,'test')`, userA, userB, accountA,
		"task-a-"+userA.String(), userA.String()+"@test.invalid", accountB,
		"task-b-"+userB.String(), userB.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,TRUE),($3,$4,TRUE)`, userA, accountA, userB, accountB); err != nil {
		t.Fatalf("insert memberships: %v", err)
	}
	var workflowA uuid.UUID
	var statusCount int
	if err := db.QueryRow(ctx, `SELECT w.id,COUNT(s.id) FROM task_workflows w JOIN task_statuses s ON s.workflow_id=w.id AND s.account_id=w.account_id WHERE w.account_id=$1 AND w.is_default GROUP BY w.id`, accountA).Scan(&workflowA, &statusCount); err != nil {
		t.Fatalf("load account workflow: %v", err)
	}
	if statusCount != 4 {
		t.Fatalf("new account received %d statuses, want 4", statusCount)
	}
	var defaultListA uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND is_default AND archived_at IS NULL`, accountA).Scan(&defaultListA); err != nil {
		t.Fatalf("new account membership did not receive a default task list: %v", err)
	}
	var defaultFolderID *uuid.UUID
	var defaultListOrder int
	var defaultListIcon string
	if err := db.QueryRow(ctx, `SELECT folder_id,sort_order,icon FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, defaultListA).
		Scan(&defaultFolderID, &defaultListOrder, &defaultListIcon); err != nil {
		t.Fatalf("load default list hierarchy identity: %v", err)
	}
	if defaultFolderID != nil || defaultListOrder != 0 || defaultListIcon != "inbox" {
		t.Fatalf("default list was not pinned to root: folder=%v order=%d icon=%q", defaultFolderID, defaultListOrder, defaultListIcon)
	}

	listID, taskID, orderConflictID, subtaskID, unlistedTaskID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,workflow_id,name,color,created_by) VALUES($1,$2,$3,'Lista','#10b981',$4)`, listID, accountA, workflowA, userA); err != nil {
		t.Fatalf("insert list: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,list_id,due_at) VALUES($1,$2,$3,$3,'Legacy','reminder','medium','pending',$4,NOW())`, taskID, accountA, userA, listID); err != nil {
		t.Fatalf("insert task: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,list_id,sort_order,due_at) VALUES($1,$2,$3,$3,'Duplicate order','reminder','medium','pending',$4,0,NOW())`, orderConflictID, accountA, userA, listID); err != nil {
		t.Fatalf("insert duplicate task order: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,due_at) VALUES($1,$2,$3,$3,'Without list','reminder','medium','pending',NOW())`, unlistedTaskID, accountA, userA); err != nil {
		t.Fatalf("insert task without list: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE tasks SET status_id=NULL WHERE id=$1`, taskID); err != nil {
		t.Fatalf("clear migrated status: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subtasks(id,task_id,account_id,title,completed,sort_order) VALUES($1,$2,$3,'Legacy child',FALSE,0)`, subtaskID, taskID, accountA); err != nil {
		t.Fatalf("insert legacy subtask: %v", err)
	}
	if err := migrateTaskWork(ctx, db); err != nil {
		t.Fatalf("compatibility migrate: %v", err)
	}
	var firstOrderA, firstOrderB int
	if err := db.QueryRow(ctx, `SELECT MIN(sort_order),MAX(sort_order) FROM tasks WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL`, accountA, listID).Scan(&firstOrderA, &firstOrderB); err != nil {
		t.Fatalf("load normalized board order: %v", err)
	}
	if firstOrderA <= 0 || firstOrderB <= firstOrderA || firstOrderA%1024 != 0 || firstOrderB%1024 != 0 {
		t.Fatalf("invalid normalized board order: %d,%d", firstOrderA, firstOrderB)
	}
	if err := migrateTaskWork(ctx, db); err != nil {
		t.Fatalf("idempotent migrate: %v", err)
	}
	var retentionDays *int
	if err := db.QueryRow(ctx, `SELECT task_trash_retention_days FROM accounts WHERE id=$1`, accountA).Scan(&retentionDays); err != nil || retentionDays == nil || *retentionDays != 30 {
		t.Fatalf("task trash retention default=%v err=%v, want 30", retentionDays, err)
	}
	if _, err := db.Exec(ctx, `UPDATE accounts SET task_trash_retention_days=6 WHERE id=$1`, accountA); err == nil {
		t.Fatal("task trash retention accepted value below 7")
	}
	if _, err := db.Exec(ctx, `UPDATE accounts SET task_trash_retention_days=NULL WHERE id=$1`, accountA); err != nil {
		t.Fatalf("task trash retention rejected Never: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE accounts SET task_trash_retention_days=30 WHERE id=$1`, accountA); err != nil {
		t.Fatalf("restore task trash retention: %v", err)
	}
	var invalidDefaultWorkflows int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM (
		SELECT workflow.id
		FROM task_workflows workflow
		LEFT JOIN task_statuses status ON status.workflow_id=workflow.id AND status.is_default
		GROUP BY workflow.id
		HAVING COUNT(status.id)<>1 OR BOOL_OR(status.category<>'not_started')
	) invalid`).Scan(&invalidDefaultWorkflows); err != nil || invalidDefaultWorkflows != 0 {
		t.Fatalf("workflow default status invariant failed: invalid=%d err=%v", invalidDefaultWorkflows, err)
	}
	var reminderIndexExists bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_indexes
		WHERE schemaname='public' AND indexname='uq_task_reminders_task_id')`).Scan(&reminderIndexExists); err != nil || !reminderIndexExists {
		t.Fatalf("unique task reminder contract missing: exists=%v err=%v", reminderIndexExists, err)
	}
	var collapsedType string
	if err := db.QueryRow(ctx, `SELECT udt_name FROM information_schema.columns
		WHERE table_schema='public' AND table_name='task_saved_views' AND column_name='collapsed_status_ids'`).Scan(&collapsedType); err != nil || collapsedType != "_text" {
		t.Fatalf("saved-view collapsed statuses type=%q err=%v, want _text", collapsedType, err)
	}
	var secondOrderA, secondOrderB int
	if err := db.QueryRow(ctx, `SELECT MIN(sort_order),MAX(sort_order) FROM tasks WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL`, accountA, listID).Scan(&secondOrderA, &secondOrderB); err != nil || secondOrderA != firstOrderA || secondOrderB != firstOrderB {
		t.Fatalf("idempotent migration changed healthy order: before=%d,%d after=%d,%d err=%v", firstOrderA, firstOrderB, secondOrderA, secondOrderB, err)
	}
	repos := repository.NewRepositories(db)
	firstReminderAt := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
	secondReminderAt := time.Now().UTC().Add(2 * time.Hour).Truncate(time.Microsecond)
	if err := repos.Task.CreateReminder(ctx, &domain.TaskReminder{TaskID: taskID, AccountID: accountA, AssignedTo: userA, ReminderAt: firstReminderAt}); err != nil {
		t.Fatalf("create first canonical reminder: %v", err)
	}
	if err := repos.Task.CreateReminder(ctx, &domain.TaskReminder{TaskID: taskID, AccountID: accountA, AssignedTo: userA, ReminderAt: secondReminderAt}); err != nil {
		t.Fatalf("replace canonical reminder: %v", err)
	}
	var reminderCount int
	var persistedReminderAt time.Time
	if err := db.QueryRow(ctx, `SELECT COUNT(*),MAX(reminder_at) FROM task_reminders WHERE task_id=$1`, taskID).Scan(&reminderCount, &persistedReminderAt); err != nil || reminderCount != 1 || !persistedReminderAt.Equal(secondReminderAt) {
		t.Fatalf("reminder upsert is not idempotent: count=%d at=%s err=%v", reminderCount, persistedReminderAt, err)
	}
	task, err := repos.Task.GetByID(ctx, taskID, accountA)
	if err != nil {
		t.Fatalf("load task for completion transition: %v", err)
	}
	var doneStatusID, activeStatusID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category='done' ORDER BY sort_order LIMIT 1`, accountA, workflowA).Scan(&doneStatusID); err != nil {
		t.Fatalf("load done status: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND category='active' ORDER BY sort_order LIMIT 1`, accountA, workflowA).Scan(&activeStatusID); err != nil {
		t.Fatalf("load active status: %v", err)
	}
	completedAt := time.Now().UTC().Truncate(time.Microsecond)
	task.StatusID, task.Status, task.Progress = &doneStatusID, domain.TaskStatusCompleted, 100
	task.CompletedAt, task.CompletedBy = &completedAt, &userA
	if err := repos.Task.Update(ctx, task); err != nil {
		t.Fatalf("persist active to done transition: %v", err)
	}
	var persistedCompletedAt *time.Time
	var persistedCompletedBy *uuid.UUID
	var persistedProgress int
	if err := db.QueryRow(ctx, `SELECT completed_at,completed_by,progress FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&persistedCompletedAt, &persistedCompletedBy, &persistedProgress); err != nil || persistedCompletedAt == nil || persistedCompletedBy == nil || *persistedCompletedBy != userA || persistedProgress != 100 {
		t.Fatalf("done transition was not persisted: at=%v by=%v progress=%d err=%v", persistedCompletedAt, persistedCompletedBy, persistedProgress, err)
	}
	doneTask, err := repos.Task.GetByID(ctx, taskID, accountA)
	if err != nil {
		t.Fatalf("reload done task for progress invariant: %v", err)
	}
	doneTask.Progress = 25
	if err := repos.Task.Update(ctx, doneTask); err != nil {
		t.Fatalf("enforce done progress invariant: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT progress FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&persistedProgress); err != nil || persistedProgress != 100 {
		t.Fatalf("done task accepted partial progress: progress=%d err=%v", persistedProgress, err)
	}
	task, err = repos.Task.GetByID(ctx, taskID, accountA)
	if err != nil {
		t.Fatalf("reload completed task: %v", err)
	}
	task.StatusID, task.Status, task.Progress = &activeStatusID, domain.TaskStatusPending, 0
	task.CompletedAt, task.CompletedBy = nil, nil
	if err := repos.Task.Update(ctx, task); err != nil {
		t.Fatalf("persist done to active transition: %v", err)
	}
	var clearedAt *time.Time
	var clearedBy *uuid.UUID
	if err := db.QueryRow(ctx, `SELECT completed_at,completed_by FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&clearedAt, &clearedBy); err != nil || clearedAt != nil || clearedBy != nil {
		t.Fatalf("active transition did not clear completion: at=%v by=%v err=%v", clearedAt, clearedBy, err)
	}
	task, err = repos.Task.GetByID(ctx, taskID, accountA)
	if err != nil {
		t.Fatalf("reload active task for list move: %v", err)
	}
	task.ListID = &defaultListA
	if err := repos.Task.Update(ctx, task); err != nil {
		t.Fatalf("move task to another list: %v", err)
	}
	var duplicateOrders int
	if err := db.QueryRow(ctx, `SELECT COUNT(*)-COUNT(DISTINCT sort_order) FROM tasks WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL`, accountA, defaultListA).Scan(&duplicateOrders); err != nil || duplicateOrders != 0 {
		t.Fatalf("list move introduced duplicate order: duplicates=%d err=%v", duplicateOrders, err)
	}
	doneCategory := domain.TaskStatusCategoryDone
	if err := repos.TaskWork.UpdateStatus(ctx, accountA, activeStatusID, nil, nil, &doneCategory, nil); !errors.Is(err, repository.ErrTaskStatusInUse) {
		t.Fatalf("in-use active status changed category: %v", err)
	}
	if err := repos.TaskWork.DeleteStatus(ctx, accountA, activeStatusID, &doneStatusID); !errors.Is(err, repository.ErrTaskStatusInUse) {
		t.Fatalf("cross-category status replacement was accepted: %v", err)
	}
	var defaultStatusID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_statuses WHERE account_id=$1 AND workflow_id=$2 AND is_default`, accountA, workflowA).Scan(&defaultStatusID); err != nil {
		t.Fatalf("load workflow default status: %v", err)
	}
	activeCategory := domain.TaskStatusCategoryActive
	if err := repos.TaskWork.UpdateStatus(ctx, accountA, defaultStatusID, nil, nil, &activeCategory, nil); !errors.Is(err, repository.ErrTaskWorkflowInvalid) {
		t.Fatalf("default status category changed: %v", err)
	}
	if err := repos.TaskWork.DeleteStatus(ctx, accountA, defaultStatusID, nil); !errors.Is(err, repository.ErrTaskWorkflowInvalid) {
		t.Fatalf("default status was deleted: %v", err)
	}

	cycleTaskID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id,due_at)
		VALUES($1,$2,$3,$3,'Cycle D','reminder','medium','pending',$4,$5,NOW())`, cycleTaskID, accountA, userA, activeStatusID, defaultListA); err != nil {
		t.Fatalf("insert dependency cycle task: %v", err)
	}
	for _, dependency := range []*domain.TaskDependency{
		{AccountID: accountA, PredecessorTaskID: orderConflictID, SuccessorTaskID: unlistedTaskID, CreatedBy: &userA},
		{AccountID: accountA, PredecessorTaskID: cycleTaskID, SuccessorTaskID: taskID, CreatedBy: &userA},
	} {
		if err := repos.TaskWork.AddDependency(ctx, dependency); err != nil {
			t.Fatalf("seed dependency graph: %v", err)
		}
	}
	cycleResults := make(chan error, 2)
	go func() {
		cycleResults <- repos.TaskWork.AddDependency(ctx, &domain.TaskDependency{AccountID: accountA, PredecessorTaskID: taskID, SuccessorTaskID: orderConflictID, CreatedBy: &userA})
	}()
	go func() {
		cycleResults <- repos.TaskWork.AddDependency(ctx, &domain.TaskDependency{AccountID: accountA, PredecessorTaskID: unlistedTaskID, SuccessorTaskID: cycleTaskID, CreatedBy: &userA})
	}()
	firstCycleErr, secondCycleErr := <-cycleResults, <-cycleResults
	if (firstCycleErr == nil) == (secondCycleErr == nil) || (!errors.Is(firstCycleErr, repository.ErrTaskDependencyCycle) && !errors.Is(secondCycleErr, repository.ErrTaskDependencyCycle)) {
		t.Fatalf("concurrent graph cycle was not serialized: first=%v second=%v", firstCycleErr, secondCycleErr)
	}
	targetWorkflowID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_workflows(id,account_id,name,created_by) VALUES($1,$2,'Limited workflow',$3)`, targetWorkflowID, accountA, userA); err != nil {
		t.Fatalf("insert target workflow: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_statuses(account_id,workflow_id,name,color,category,sort_order,is_default) VALUES
		($1,$2,'To do','#64748b','not_started',0,TRUE),($1,$2,'Done','#10b981','done',1,FALSE)`, accountA, targetWorkflowID); err != nil {
		t.Fatalf("insert target workflow statuses: %v", err)
	}
	notInherited := false
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, defaultListA, nil, false, nil, false, &targetWorkflowID, &notInherited, nil, nil, nil, nil); !errors.Is(err, repository.ErrTaskStatusMappingInvalid) {
		t.Fatalf("list accepted a workflow without equivalent active status: %v", err)
	}
	folder := &domain.TaskFolder{AccountID: accountA, WorkflowID: &targetWorkflowID, Name: "General contract", CreatedBy: userA}
	if err := repos.TaskWork.CreateFolder(ctx, folder); err != nil {
		t.Fatalf("create folder for default workflow contract: %v", err)
	}
	if err := repos.TaskWork.UpdateFolder(ctx, accountA, folder.ID, nil, nil, nil, nil, nil, true); err != nil {
		t.Fatalf("reset folder to default workflow: %v", err)
	}
	folderIcon := "rocket"
	if err := repos.TaskWork.UpdateFolder(ctx, accountA, folder.ID, nil, nil, nil, &folderIcon, nil, false); err != nil {
		t.Fatalf("update folder icon: %v", err)
	}
	var folderWorkflowID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT workflow_id FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, folder.ID).Scan(&folderWorkflowID); err != nil || folderWorkflowID != workflowA {
		t.Fatalf("folder did not resolve explicit null to default workflow: workflow=%s err=%v", folderWorkflowID, err)
	}
	firstMovableList, secondMovableList := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,workflow_id,workflow_inherited,name,color,sort_order,created_by) VALUES
		($1,$3,$4,FALSE,'Primera movible','#0ea5e9',2048,$5),
		($2,$3,$4,FALSE,'Segunda movible','#8b5cf6',3072,$5)`, firstMovableList, secondMovableList, accountA, workflowA, userA); err != nil {
		t.Fatalf("insert movable task lists: %v", err)
	}
	inherited := true
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, secondMovableList, &folder.ID, true, nil, true, nil, &inherited, nil, nil, nil, nil); err != nil {
		t.Fatalf("append list into folder: %v", err)
	}
	listIcon := "target"
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, firstMovableList, &folder.ID, true, &secondMovableList, true, nil, &inherited, nil, nil, nil, &listIcon); err != nil {
		t.Fatalf("insert list before folder anchor: %v", err)
	}
	var firstFolderID, secondFolderID uuid.UUID
	var firstListOrder, secondListOrder int
	var persistedListIcon string
	if err := db.QueryRow(ctx, `SELECT folder_id,sort_order,icon FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, firstMovableList).Scan(&firstFolderID, &firstListOrder, &persistedListIcon); err != nil {
		t.Fatalf("load first moved list: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT folder_id,sort_order FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, secondMovableList).Scan(&secondFolderID, &secondListOrder); err != nil {
		t.Fatalf("load second moved list: %v", err)
	}
	if firstFolderID != folder.ID || secondFolderID != folder.ID || firstListOrder >= secondListOrder || firstListOrder%1024 != 0 || secondListOrder%1024 != 0 || persistedListIcon != listIcon {
		t.Fatalf("folder list order/identity was not persisted: folders=%s,%s order=%d,%d icon=%q", firstFolderID, secondFolderID, firstListOrder, secondListOrder, persistedListIcon)
	}
	var persistedFolderIcon string
	if err := db.QueryRow(ctx, `SELECT icon FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, folder.ID).Scan(&persistedFolderIcon); err != nil || persistedFolderIcon != folderIcon {
		t.Fatalf("folder icon was not persisted: icon=%q err=%v", persistedFolderIcon, err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_lists SET icon='unsafe-icon' WHERE account_id=$1 AND id=$2`, accountA, firstMovableList); err == nil {
		t.Fatal("task list accepted an icon outside the controlled catalog")
	}
	secondFolder := &domain.TaskFolder{AccountID: accountA, WorkflowID: &workflowA, Name: "Second ordered folder", CreatedBy: userA}
	if err := repos.TaskWork.CreateFolder(ctx, secondFolder); err != nil {
		t.Fatalf("create second ordered folder: %v", err)
	}
	if err := repos.TaskWork.ReorderFolder(ctx, accountA, secondFolder.ID, &folder.ID); err != nil {
		t.Fatalf("reorder folder before anchor: %v", err)
	}
	var firstFolderOrder, orderedSecondFolder int
	if err := db.QueryRow(ctx, `SELECT sort_order FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, folder.ID).Scan(&firstFolderOrder); err != nil {
		t.Fatalf("load first folder order: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT sort_order FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, secondFolder.ID).Scan(&orderedSecondFolder); err != nil {
		t.Fatalf("load second folder order: %v", err)
	}
	if orderedSecondFolder >= firstFolderOrder || orderedSecondFolder%1024 != 0 || firstFolderOrder%1024 != 0 {
		t.Fatalf("folder order was not persisted canonically: second=%d first=%d", orderedSecondFolder, firstFolderOrder)
	}
	if err := repos.TaskWork.ReorderFolder(ctx, accountA, folder.ID, &folder.ID); !errors.Is(err, repository.ErrTaskFolderOrderInvalid) {
		t.Fatalf("folder accepted itself as anchor: %v", err)
	}
	var workflowB uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_workflows WHERE account_id=$1 AND is_default`, accountB).Scan(&workflowB); err != nil {
		t.Fatalf("load second account workflow: %v", err)
	}
	foreignFolder := &domain.TaskFolder{AccountID: accountB, WorkflowID: &workflowB, Name: "Foreign folder", CreatedBy: userB}
	if err := repos.TaskWork.CreateFolder(ctx, foreignFolder); err != nil {
		t.Fatalf("create foreign folder: %v", err)
	}
	if err := repos.TaskWork.ReorderFolder(ctx, accountA, folder.ID, &foreignFolder.ID); !errors.Is(err, repository.ErrTaskFolderOrderInvalid) {
		t.Fatalf("cross-account folder anchor was accepted: %v", err)
	}
	var defaultListB uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND is_default AND archived_at IS NULL`, accountB).Scan(&defaultListB); err != nil {
		t.Fatalf("load other account default list: %v", err)
	}
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, firstMovableList, &folder.ID, true, &defaultListB, true, nil, &inherited, nil, nil, nil, nil); !errors.Is(err, repository.ErrTaskListOrderInvalid) {
		t.Fatalf("cross-account list anchor was accepted: %v", err)
	}
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, defaultListA, &folder.ID, true, nil, true, nil, &inherited, nil, nil, nil, nil); !errors.Is(err, repository.ErrDefaultTaskList) {
		t.Fatalf("default list moved into folder: %v", err)
	}
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, defaultListA, nil, true, &firstMovableList, true, nil, &notInherited, nil, nil, nil, nil); !errors.Is(err, repository.ErrDefaultTaskList) {
		t.Fatalf("default list reordered in root: %v", err)
	}
	limitedFolder := &domain.TaskFolder{AccountID: accountA, WorkflowID: &targetWorkflowID, Name: "Limited folder", CreatedBy: userA}
	if err := repos.TaskWork.CreateFolder(ctx, limitedFolder); err != nil {
		t.Fatalf("create limited folder: %v", err)
	}
	workflowRollbackList, workflowRollbackTask := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,workflow_id,workflow_inherited,name,color,sort_order,created_by) VALUES($1,$2,$3,FALSE,'Rollback workflow','#f97316',4096,$4)`, workflowRollbackList, accountA, workflowA, userA); err != nil {
		t.Fatalf("insert workflow rollback list: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id,sort_order) VALUES($1,$2,$3,$3,'Keep active state','reminder','medium','in_progress',$4,$5,1024)`, workflowRollbackTask, accountA, userA, activeStatusID, workflowRollbackList); err != nil {
		t.Fatalf("insert workflow rollback task: %v", err)
	}
	if err := repos.TaskWork.UpdateListLocation(ctx, accountA, workflowRollbackList, &limitedFolder.ID, true, nil, true, nil, &inherited, nil, nil, nil, nil); !errors.Is(err, repository.ErrTaskStatusMappingInvalid) {
		t.Fatalf("list moved into incompatible workflow: %v", err)
	}
	var rollbackFolderID *uuid.UUID
	var rollbackWorkflowID, rollbackStatusID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT folder_id,workflow_id FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, workflowRollbackList).Scan(&rollbackFolderID, &rollbackWorkflowID); err != nil {
		t.Fatalf("load workflow rollback list: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT status_id FROM tasks WHERE account_id=$1 AND id=$2`, accountA, workflowRollbackTask).Scan(&rollbackStatusID); err != nil {
		t.Fatalf("load workflow rollback task: %v", err)
	}
	if rollbackFolderID != nil || rollbackWorkflowID != workflowA || rollbackStatusID != activeStatusID {
		t.Fatalf("incompatible workflow move was not rolled back: folder=%v workflow=%s status=%s", rollbackFolderID, rollbackWorkflowID, rollbackStatusID)
	}
	if err := repos.Task.DeleteList(ctx, listID, accountA); !errors.Is(err, repository.ErrTaskContainerNotEmpty) {
		t.Fatalf("list with active tasks was archived: %v", err)
	}
	if err := repos.TaskWork.SoftDeleteTask(ctx, accountA, orderConflictID, userA); err != nil {
		t.Fatalf("soft-delete task before archiving list: %v", err)
	}
	if err := repos.Task.DeleteList(ctx, listID, accountA); err != nil {
		t.Fatalf("archive list containing only deleted tasks: %v", err)
	}
	if err := repos.TaskWork.RestoreTask(ctx, accountA, orderConflictID); err != nil {
		t.Fatalf("restore task from archived list into default list: %v", err)
	}
	var restoredListID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountA, orderConflictID).Scan(&restoredListID); err != nil || restoredListID != defaultListA {
		t.Fatalf("restored task remained hidden in archived list: list=%s err=%v", restoredListID, err)
	}
	var promotedChildID, promotedParent uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id,parent_task_id FROM tasks WHERE account_id=$1 AND legacy_subtask_id=$2`, accountA, subtaskID).Scan(&promotedChildID, &promotedParent); err != nil || promotedParent != taskID {
		t.Fatalf("legacy subtask was not promoted safely: parent=%s err=%v", promotedParent, err)
	}
	if err := repos.TaskWork.SoftDeleteTask(ctx, accountA, taskID, userA); err != nil {
		t.Fatalf("archive parent and promoted child: %v", err)
	}
	if err := repos.TaskWork.RestoreTask(ctx, accountA, promotedChildID); !errors.Is(err, repository.ErrTaskParentArchived) {
		t.Fatalf("child restored below archived parent: %v", err)
	}
	if err := repos.TaskWork.RestoreTask(ctx, accountA, taskID); err != nil {
		t.Fatalf("restore parent tree: %v", err)
	}
	var backfilledList uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2`, accountA, unlistedTaskID).Scan(&backfilledList); err != nil || backfilledList != defaultListA {
		t.Fatalf("task without list was not moved to default list: list=%s err=%v", backfilledList, err)
	}
	commentID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_comments(id,account_id,task_id,author_id,body) VALUES($1,$2,$3,$4,'Mention test')`, commentID, accountA, taskID, userA); err != nil {
		t.Fatalf("insert task comment: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_comment_mentions(account_id,task_id,comment_id,user_id) VALUES($1,$2,$3,$4)`, accountA, taskID, commentID, userB); err == nil {
		t.Fatal("cross-account task comment mention unexpectedly succeeded")
	}

	_, err = db.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by) VALUES($1,$2,$3,$4)`, accountA, taskID, userB, userA)
	if err == nil {
		t.Fatal("cross-account collaborator insert unexpectedly succeeded")
	}
	if belongs, err := repos.TaskWork.TaskBelongsToAccount(ctx, accountB, taskID); err != nil || belongs {
		t.Fatalf("cross-account task visibility leaked: belongs=%v err=%v", belongs, err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_saved_views(account_id,user_id,name,scope_type,view_mode) VALUES($1,$2,'Mi tablero','all','board')`, accountA, userA); err != nil {
		t.Fatalf("insert private saved view: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_saved_views(account_id,user_id,name,scope_type,view_mode) VALUES($1,$2,'Cross account','all','board')`, accountA, userB); err == nil {
		t.Fatal("cross-account saved view unexpectedly succeeded")
	}
}
