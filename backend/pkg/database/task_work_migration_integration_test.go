package database

import (
	"context"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
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

	listID, taskID, subtaskID := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,workflow_id,name,color,created_by) VALUES($1,$2,$3,'Lista','#10b981',$4)`, listID, accountA, workflowA, userA); err != nil {
		t.Fatalf("insert list: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,list_id,due_at) VALUES($1,$2,$3,$3,'Legacy','reminder','medium','pending',$4,NOW())`, taskID, accountA, userA, listID); err != nil {
		t.Fatalf("insert task: %v", err)
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
	if err := migrateTaskWork(ctx, db); err != nil {
		t.Fatalf("idempotent migrate: %v", err)
	}
	var promotedParent uuid.UUID
	if err := db.QueryRow(ctx, `SELECT parent_task_id FROM tasks WHERE account_id=$1 AND legacy_subtask_id=$2`, accountA, subtaskID).Scan(&promotedParent); err != nil || promotedParent != taskID {
		t.Fatalf("legacy subtask was not promoted safely: parent=%s err=%v", promotedParent, err)
	}

	_, err = db.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by) VALUES($1,$2,$3,$4)`, accountA, taskID, userB, userA)
	if err == nil {
		t.Fatal("cross-account collaborator insert unexpectedly succeeded")
	}
}
