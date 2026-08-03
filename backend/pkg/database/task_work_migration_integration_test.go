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
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent second migrate: %v", err)
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
	viewerA := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash)
		VALUES($1,$2,$3,$4,'test')`, viewerA, accountA, "task-viewer-"+viewerA.String(), viewerA.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert same-account task viewer: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,FALSE)`, viewerA, accountA); err != nil {
		t.Fatalf("insert same-account viewer membership: %v", err)
	}
	legacyViewerA := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash)
		VALUES($1,$2,$3,$4,'test')`, legacyViewerA, accountA, "task-legacy-viewer-"+legacyViewerA.String(), legacyViewerA.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert legacy viewer: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,FALSE)`, legacyViewerA, accountA); err != nil {
		t.Fatalf("insert legacy viewer membership: %v", err)
	}
	var workflowA, environmentA uuid.UUID
	var statusCount int
	if err := db.QueryRow(ctx, `SELECT w.id,w.environment_id,COUNT(s.id) FROM task_workflows w
		JOIN task_environments environment ON environment.account_id=w.account_id AND environment.id=w.environment_id
		JOIN task_statuses s ON s.workflow_id=w.id AND s.account_id=w.account_id
		WHERE w.account_id=$1 AND w.is_default AND environment.is_default GROUP BY w.id,w.environment_id`, accountA).
		Scan(&workflowA, &environmentA, &statusCount); err != nil {
		t.Fatalf("load account workflow: %v", err)
	}
	if statusCount != 4 {
		t.Fatalf("new account received %d statuses, want 4", statusCount)
	}
	var defaultListA uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND environment_id=$2 AND is_default AND archived_at IS NULL`, accountA, environmentA).Scan(&defaultListA); err != nil {
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
	workRepo := repository.NewRepositories(db).TaskWork
	privateEnvironment := &domain.TaskEnvironment{
		AccountID: accountA, Name: "Privado", Description: "Límite de colaboración", Color: "#4338CA", Icon: "lock",
	}
	createOperationID := uuid.New()
	if err := workRepo.CreateEnvironment(ctx, privateEnvironment, userA, &createOperationID); err != nil {
		t.Fatalf("create private environment: %v", err)
	}
	if privateEnvironment.Visibility != "restricted" || privateEnvironment.DefaultAccessLevel != domain.TaskAccessNone {
		t.Fatalf("new environment was not forced private: %#v", privateEnvironment)
	}
	privateEnvironment.Name = "PRIVADO"
	if err := workRepo.UpdateEnvironment(ctx, accountA, userA, privateEnvironment, nil, nil); err != nil {
		t.Fatalf("case-only environment rename hit a PostgreSQL parameter error: %v", err)
	}
	privateEnvironment.Version++
	creatorAccess, err := workRepo.ResolveEnvironmentAccess(ctx, accountA, userA, privateEnvironment.ID)
	if err != nil || creatorAccess.Level != domain.TaskAccessFull || !creatorAccess.CanManageAccess {
		t.Fatalf("environment creator is not explicit manager: access=%#v err=%v", creatorAccess, err)
	}
	viewerAccess, err := workRepo.ResolveEnvironmentAccess(ctx, accountA, viewerA, privateEnvironment.ID)
	if err != nil || viewerAccess.Level != domain.TaskAccessNone || viewerAccess.CanView {
		t.Fatalf("private environment leaked to account member: access=%#v err=%v", viewerAccess, err)
	}
	if _, err := workRepo.RequireEnvironmentAccess(ctx, accountA, viewerA, privateEnvironment.ID, domain.TaskAccessView); !errors.Is(err, repository.ErrTaskWorkNotFound) {
		t.Fatalf("hidden environment returned error=%v, want not found", err)
	}
	grants, _, accessRevision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetEnvironment,
		privateEnvironment.ID, nil, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
			{UserID: viewerA, AccessLevel: domain.TaskAccessView},
		}, 1, uuid.New())
	if err != nil || len(grants) != 2 || accessRevision != 2 {
		t.Fatalf("share private environment: grants=%#v revision=%d err=%v", grants, accessRevision, err)
	}
	viewerAccess, err = workRepo.RequireEnvironmentAccess(ctx, accountA, viewerA, privateEnvironment.ID, domain.TaskAccessView)
	if err != nil || viewerAccess.Level != domain.TaskAccessView || viewerAccess.CanEdit {
		t.Fatalf("explicit view grant was not honored: access=%#v err=%v", viewerAccess, err)
	}
	var privateListID, privateStatusID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_item.id,status.id FROM task_lists list_item
		JOIN task_statuses status ON status.account_id=list_item.account_id AND status.workflow_id=list_item.workflow_id AND status.is_default
		WHERE list_item.account_id=$1 AND list_item.environment_id=$2 AND list_item.is_default`, accountA, privateEnvironment.ID).
		Scan(&privateListID, &privateStatusID); err != nil {
		t.Fatalf("load private environment defaults: %v", err)
	}
	privateFolder := &domain.TaskFolder{AccountID: accountA, EnvironmentID: privateEnvironment.ID, CreatedBy: userA, Name: "Carpeta privada", Color: "#4338CA", Icon: "folder"}
	if err := workRepo.CreateFolder(ctx, privateFolder); err != nil {
		t.Fatalf("create ACL folder: %v", err)
	}
	privateList := &domain.TaskList{AccountID: accountA, EnvironmentID: privateEnvironment.ID, FolderID: &privateFolder.ID, CreatedBy: userA, Name: "Lista compartida", Color: "#4338CA", Icon: "list", WorkflowInherited: true}
	if err := repository.NewRepositories(db).Task.CreateList(ctx, privateList); err != nil {
		t.Fatalf("create ACL list: %v", err)
	}
	privateModeForContainer := "private"
	if _, mode, revision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetFolder, privateFolder.ID,
		&privateModeForContainer, []repository.TaskAccessGrantInput{{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true}}, 1, uuid.New()); err != nil || mode != "private" || revision != 2 {
		t.Fatalf("set folder private: mode=%s revision=%d err=%v", mode, revision, err)
	}
	if _, _, revision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetList, privateList.ID,
		nil, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
			{UserID: viewerA, AccessLevel: domain.TaskAccessComment},
		}, 1, uuid.New()); err != nil || revision != 2 {
		t.Fatalf("share list over hidden folder: revision=%d err=%v", revision, err)
	}
	listAccess, _, err := workRepo.ResolveContainerAccess(ctx, accountA, viewerA, privateList.ID, domain.TaskAccessTargetList)
	if err != nil || listAccess.Level != domain.TaskAccessComment {
		t.Fatalf("specific list grant did not override hidden folder: access=%#v err=%v", listAccess, err)
	}
	if _, _, _, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetList, privateList.ID,
		nil, []repository.TaskAccessGrantInput{{UserID: userB, AccessLevel: domain.TaskAccessView}}, 2, uuid.New()); !errors.Is(err, repository.ErrTaskAccessInvalid) {
		t.Fatalf("cross-account list share was not rejected: %v", err)
	}
	if _, _, _, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetList, privateList.ID,
		nil, []repository.TaskAccessGrantInput{{UserID: legacyViewerA, AccessLevel: domain.TaskAccessView}}, 2, uuid.New()); !errors.Is(err, repository.ErrTaskAccessInvalid) {
		t.Fatalf("new list share without Entorno visibility was not rejected: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$4)`, accountA, privateList.ID, legacyViewerA, userA); err != nil {
		t.Fatalf("insert historical inactive list grant: %v", err)
	}
	if _, _, revision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetList, privateList.ID,
		nil, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
			{UserID: viewerA, AccessLevel: domain.TaskAccessComment},
			{UserID: legacyViewerA, AccessLevel: domain.TaskAccessView},
		}, 2, uuid.New()); err != nil || revision != 3 {
		t.Fatalf("historical inactive grant could not be preserved: revision=%d err=%v", revision, err)
	}
	legacyAccess, _, err := workRepo.ResolveContainerAccess(ctx, accountA, legacyViewerA, privateList.ID, domain.TaskAccessTargetList)
	if err != nil || legacyAccess.CanView || legacyAccess.InheritedFrom != "environment_required" {
		t.Fatalf("historical grant bypassed the Entorno boundary: access=%#v err=%v", legacyAccess, err)
	}
	sharedResources, _, err := workRepo.ListDirectSharedResources(ctx, accountA, viewerA, privateEnvironment.ID, 50, nil)
	if err != nil || len(sharedResources) != 1 || sharedResources[0].Type != domain.TaskAccessTargetList || sharedResources[0].ID != privateList.ID {
		t.Fatalf("direct shared hub did not expose only the list root: resources=%#v err=%v", sharedResources, err)
	}
	privateTaskID, privateChildID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id)
		VALUES($1,$2,$3,$3,'Privada','reminder','medium','pending',$4,$5)`, privateTaskID, accountA, userA, privateStatusID, privateListID); err != nil {
		t.Fatalf("insert private task: %v", err)
	}
	privateMode := "private"
	taskGrants, returnedMode, taskAccessRevision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA,
		domain.TaskAccessTargetTask, privateTaskID, &privateMode, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
			{UserID: viewerA, AccessLevel: domain.TaskAccessComment},
		}, 1, uuid.New())
	if err != nil || len(taskGrants) != 2 || returnedMode != "private" || taskAccessRevision != 2 {
		t.Fatalf("set private task ACL: grants=%#v mode=%s revision=%d err=%v", taskGrants, returnedMode, taskAccessRevision, err)
	}
	if _, err := workRepo.RequireTaskAccess(ctx, accountA, viewerA, privateTaskID, domain.TaskAccessComment); err != nil {
		t.Fatalf("comment grant was not honored: %v", err)
	}
	if _, err := workRepo.RequireTaskAccess(ctx, accountA, viewerA, privateTaskID, domain.TaskAccessEdit); !errors.Is(err, repository.ErrTaskAccessDenied) {
		t.Fatalf("comment grant incorrectly allowed edit: %v", err)
	}
	if _, _, currentRevision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetTask,
		privateTaskID, &privateMode, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
			{UserID: viewerA, AccessLevel: domain.TaskAccessEdit},
		}, 2, uuid.New()); err != nil || currentRevision != 3 {
		t.Fatalf("elevate task participant to edit: revision=%d err=%v", currentRevision, err)
	}
	privateTask, err := repository.NewRepositories(db).Task.GetByID(ctx, privateTaskID, accountA)
	if err != nil {
		t.Fatalf("load directly shared task for edit: %v", err)
	}
	privateTask.Title = "Privada editada por grant directo"
	privateTask.MutationActor = &viewerA
	if err := repository.NewRepositories(db).Task.Update(ctx, privateTask); err != nil {
		t.Fatalf("direct edit grant could not update private task: %v", err)
	}
	if _, _, currentRevision, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetTask,
		privateTaskID, &privateMode, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull, CanManageAccess: true},
		}, 2, uuid.New()); !errors.Is(err, repository.ErrTaskAccessRevisionConflict) || currentRevision != 3 {
		t.Fatalf("stale task ACL write: revision=%d err=%v", currentRevision, err)
	}
	if _, _, _, err := workRepo.ReplaceAccessGrants(ctx, accountA, userA, domain.TaskAccessTargetTask,
		privateTaskID, &privateMode, []repository.TaskAccessGrantInput{
			{UserID: userA, AccessLevel: domain.TaskAccessFull},
			{UserID: viewerA, AccessLevel: domain.TaskAccessEdit},
		}, 3, uuid.New()); !errors.Is(err, repository.ErrTaskLastAccessManager) {
		t.Fatalf("private task accepted ACL without explicit manager: %v", err)
	}
	var unchangedEnvironmentRevision int64
	if err := db.QueryRow(ctx, `SELECT access_revision FROM task_environments WHERE account_id=$1 AND id=$2`, accountA, privateEnvironment.ID).
		Scan(&unchangedEnvironmentRevision); err != nil || unchangedEnvironmentRevision != 2 {
		t.Fatalf("task ACL changed environment revision: revision=%d err=%v", unchangedEnvironmentRevision, err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id,parent_task_id)
		VALUES($1,$2,$3,$3,'Hija privada','reminder','medium','pending',$4,$5,$6)`, privateChildID, accountA, userA, privateStatusID, privateListID, privateTaskID); err != nil {
		t.Fatalf("insert private child task: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$3)`, accountA, privateChildID, viewerA); err == nil {
		t.Fatal("database accepted a direct ACL grant on a child task")
	}

	listID, taskID, orderConflictID, subtaskID, unlistedTaskID := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,name,color,created_by)
		VALUES($1,$2,$3,$4,'Lista','#10b981',$5)`, listID, accountA, environmentA, workflowA, userA); err != nil {
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
	if err := migrateTaskEnvironments(ctx, db); err != nil {
		t.Fatalf("idempotent environment migrate: %v", err)
	}
	if err := migrateTaskEnvironments(ctx, db); err != nil {
		t.Fatalf("second idempotent environment migrate: %v", err)
	}
	var persistedVisibility, persistedDefaultAccess string
	var persistedRevision int64
	if err := db.QueryRow(ctx, `SELECT visibility,default_access_level,access_revision FROM task_environments
		WHERE account_id=$1 AND id=$2`, accountA, privateEnvironment.ID).
		Scan(&persistedVisibility, &persistedDefaultAccess, &persistedRevision); err != nil {
		t.Fatalf("load private environment after migration rerun: %v", err)
	}
	if persistedVisibility != "restricted" || persistedDefaultAccess != domain.TaskAccessNone || persistedRevision != 2 {
		t.Fatalf("migration rerun changed private policy: visibility=%s default=%s revision=%d", persistedVisibility, persistedDefaultAccess, persistedRevision)
	}
	var persistedTaskMode string
	var persistedTaskRevision int64
	if err := db.QueryRow(ctx, `SELECT access_mode,access_revision FROM tasks WHERE account_id=$1 AND id=$2`, accountA, privateTaskID).
		Scan(&persistedTaskMode, &persistedTaskRevision); err != nil || persistedTaskMode != "private" || persistedTaskRevision != 3 {
		t.Fatalf("migration rerun changed task ACL: mode=%s revision=%d err=%v", persistedTaskMode, persistedTaskRevision, err)
	}
	var retentionDays *int
	if err := db.QueryRow(ctx, `SELECT task_trash_retention_days FROM accounts WHERE id=$1`, accountA).Scan(&retentionDays); err != nil || retentionDays == nil || *retentionDays != 30 {
		t.Fatalf("task trash retention default=%v err=%v, want 30", retentionDays, err)
	}

	// Removing an account membership audits both grant classes before the FK
	// cascade, bumps their ACL revisions, and is idempotent on a retry.
	departingUserID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash)
		VALUES($1,$2,$3,$4,'test')`, departingUserID, accountA, "task-departing-"+departingUserID.String(), departingUserID.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert departing task member: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,is_default) VALUES($1,$2,FALSE)`, departingUserID, accountA); err != nil {
		t.Fatalf("insert departing membership: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$4)`, accountA, environmentA, departingUserID, userA); err != nil {
		t.Fatalf("insert departing environment grant: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_access_grants(account_id,task_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$4)`, accountA, taskID, departingUserID, userA); err != nil {
		t.Fatalf("insert departing task grant: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$4)`, accountA, privateFolder.ID, departingUserID, userA); err != nil {
		t.Fatalf("insert departing folder grant: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'view',$4)`, accountA, privateList.ID, departingUserID, userA); err != nil {
		t.Fatalf("insert departing list grant: %v", err)
	}
	var environmentRevisionBefore, taskRevisionBefore int64
	if err := db.QueryRow(ctx, `SELECT access_revision FROM task_environments WHERE account_id=$1 AND id=$2`, accountA, environmentA).Scan(&environmentRevisionBefore); err != nil {
		t.Fatalf("load environment revision before membership removal: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT access_revision FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&taskRevisionBefore); err != nil {
		t.Fatalf("load task revision before membership removal: %v", err)
	}
	repositories := repository.NewRepositories(db)
	if err := repositories.UserAccount.RemoveWithActor(ctx, departingUserID, accountA, userA); err != nil {
		t.Fatalf("remove membership with ACL audit: %v", err)
	}
	if err := repositories.UserAccount.RemoveWithActor(ctx, departingUserID, accountA, userA); err != nil {
		t.Fatalf("retry membership removal was not idempotent: %v", err)
	}
	var auditCount, remainingGrantCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_access_audit
		WHERE account_id=$1 AND actor_id=$2 AND action='membership_grant_removed'
		  AND target_id IN ($3,$4,$5,$6)`, accountA, userA, environmentA, taskID, privateFolder.ID, privateList.ID).Scan(&auditCount); err != nil {
		t.Fatalf("load membership ACL audit: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM task_environment_grants WHERE account_id=$1 AND user_id=$2)+
		(SELECT COUNT(*) FROM task_folder_access_grants WHERE account_id=$1 AND user_id=$2)+
		(SELECT COUNT(*) FROM task_list_access_grants WHERE account_id=$1 AND user_id=$2)+
		(SELECT COUNT(*) FROM task_access_grants WHERE account_id=$1 AND user_id=$2)`, accountA, departingUserID).Scan(&remainingGrantCount); err != nil {
		t.Fatalf("load remaining membership grants: %v", err)
	}
	var environmentRevisionAfter, taskRevisionAfter int64
	if err := db.QueryRow(ctx, `SELECT access_revision FROM task_environments WHERE account_id=$1 AND id=$2`, accountA, environmentA).Scan(&environmentRevisionAfter); err != nil {
		t.Fatalf("load environment revision after membership removal: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT access_revision FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&taskRevisionAfter); err != nil {
		t.Fatalf("load task revision after membership removal: %v", err)
	}
	if auditCount != 4 || remainingGrantCount != 0 || environmentRevisionAfter != environmentRevisionBefore+1 || taskRevisionAfter != taskRevisionBefore+1 {
		t.Fatalf("membership ACL cleanup audit=%d grants=%d env_revision=%d→%d task_revision=%d→%d",
			auditCount, remainingGrantCount, environmentRevisionBefore, environmentRevisionAfter, taskRevisionBefore, taskRevisionAfter)
	}

	// Exercise the real PostgreSQL parameter inference used by anchored comment
	// resolution. This specifically guards the UUID-in-CASE regression that Go
	// compilation and mocked repositories cannot detect.
	assetID, attachmentID, rootCommentID, replyCommentID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,filename)
		VALUES($1,$2,$3,$4,'proof.pdf')`, assetID, accountA, "proof-"+assetID.String(), accountA.String()+"/proof.pdf"); err != nil {
		t.Fatalf("insert attachment media asset: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by)
		VALUES($1,$2,$3,$4,$5)`, attachmentID, accountA, taskID, assetID, userA); err != nil {
		t.Fatalf("insert task attachment: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_attachment_comments(id,account_id,task_id,attachment_id,author_id,body,anchor)
		VALUES($1,$2,$3,$4,$5,'Raíz','{"kind":"pdf","page":1}'),
		($6,$2,$3,$4,$5,'Respuesta','{"kind":"pdf","page":1}')`, rootCommentID, accountA, taskID, attachmentID, userA, replyCommentID); err != nil {
		t.Fatalf("insert attachment comments: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_attachment_comments SET parent_id=$1 WHERE id=$2`, rootCommentID, replyCommentID); err != nil {
		t.Fatalf("link attachment reply: %v", err)
	}
	taskWork := repository.NewRepositories(db).TaskWork
	download, err := taskWork.ResolveAttachmentDownload(ctx, accountA, taskID, attachmentID, false)
	if err != nil || download == nil || download.ObjectKey != accountA.String()+"/proof.pdf" {
		t.Fatalf("resolve account-scoped task attachment: download=%#v err=%v", download, err)
	}
	if _, err := taskWork.ResolveAttachmentDownload(ctx, accountB, taskID, attachmentID, false); !errors.Is(err, repository.ErrTaskWorkNotFound) {
		t.Fatalf("cross-account attachment download error=%v, want not found", err)
	}
	if _, err := taskWork.ResolveAttachmentDownload(ctx, accountA, orderConflictID, attachmentID, false); !errors.Is(err, repository.ErrTaskWorkNotFound) {
		t.Fatalf("wrong-task attachment download error=%v, want not found", err)
	}
	if _, err := taskWork.RequireTaskAccess(ctx, accountA, userA, taskID, domain.TaskAccessView); err != nil {
		t.Fatalf("authorized viewer could not resolve task attachment: %v", err)
	}
	attachments, err := taskWork.ListAttachments(ctx, accountA, taskID)
	if err != nil || len(attachments) != 1 || attachments[0].URL != "/api/tasks/"+taskID.String()+"/attachments/"+attachmentID.String()+"/download" {
		t.Fatalf("attachment DTO did not use its protected task URL: attachments=%#v err=%v", attachments, err)
	}

	// A Comment-level upload is a private, expiring draft. It is absent from
	// task files, cannot be claimed by another member/account, and becomes a
	// durable comment attachment only in the comment transaction.
	draftAssetID, draftAttachmentID := uuid.New(), uuid.New()
	draftObjectKey := accountA.String() + "/_private/tasks/attachments/comment-draft.pdf"
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,status)
		VALUES($1,$2,$3,$4,'comment-draft.pdf','active')`, draftAssetID, accountA, "comment-draft-"+draftAssetID.String(), draftObjectKey); err != nil {
		t.Fatalf("insert comment draft media: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at)
		VALUES($1,$2,$3,$4,$5,'comment_draft',$5,NOW()+INTERVAL '1 hour')`, draftAttachmentID, accountA, taskID, draftAssetID, userA); err != nil {
		t.Fatalf("insert comment draft: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,available_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')`, accountA, draftAssetID, draftObjectKey); err != nil {
		t.Fatalf("schedule comment draft cleanup: %v", err)
	}
	attachments, err = taskWork.ListAttachments(ctx, accountA, taskID)
	if err != nil || len(attachments) != 1 {
		t.Fatalf("comment draft leaked into task attachments: attachments=%#v err=%v", attachments, err)
	}
	commentWithDraft := &domain.TaskComment{AccountID: accountA, TaskID: taskID, AuthorID: userA, Body: "Comentario con evidencia"}
	if err := taskWork.CreateComment(ctx, commentWithDraft, nil, []uuid.UUID{draftAttachmentID}); err != nil {
		t.Fatalf("publish own comment draft: %v", err)
	}
	var promotedScope string
	var promotedOwner *uuid.UUID
	var promotedExpiry *time.Time
	var relationCount, cleanupCount int
	if err := db.QueryRow(ctx, `SELECT attachment_scope,draft_owner_id,draft_expires_at FROM task_attachments
		WHERE account_id=$1 AND task_id=$2 AND id=$3`, accountA, taskID, draftAttachmentID).
		Scan(&promotedScope, &promotedOwner, &promotedExpiry); err != nil {
		t.Fatalf("load promoted comment attachment: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_comment_attachments
		WHERE account_id=$1 AND task_id=$2 AND comment_id=$3 AND attachment_id=$4`, accountA, taskID, commentWithDraft.ID, draftAttachmentID).Scan(&relationCount); err != nil {
		t.Fatalf("load promoted comment relation: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountA, draftAssetID).Scan(&cleanupCount); err != nil {
		t.Fatalf("load promoted comment cleanup: %v", err)
	}
	if promotedScope != "comment" || promotedOwner != nil || promotedExpiry != nil || relationCount != 1 || cleanupCount != 0 {
		t.Fatalf("draft promotion scope=%s owner=%v expiry=%v relation=%d cleanup=%d", promotedScope, promotedOwner, promotedExpiry, relationCount, cleanupCount)
	}

	foreignDraftAssetID, foreignDraftAttachmentID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,status)
		VALUES($1,$2,$3,$4,'foreign-draft.pdf','active')`, foreignDraftAssetID, accountA, "foreign-comment-draft-"+foreignDraftAssetID.String(), accountA.String()+"/_private/tasks/attachments/foreign-draft.pdf"); err != nil {
		t.Fatalf("insert foreign comment draft media: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at)
		VALUES($1,$2,$3,$4,$5,'comment_draft',$5,NOW()+INTERVAL '1 hour')`, foreignDraftAttachmentID, accountA, taskID, foreignDraftAssetID, userA); err != nil {
		t.Fatalf("insert foreign-owned comment draft: %v", err)
	}
	foreignComment := &domain.TaskComment{AccountID: accountA, TaskID: taskID, AuthorID: viewerA, Body: "No puede reclamar"}
	if err := taskWork.CreateComment(ctx, foreignComment, nil, []uuid.UUID{foreignDraftAttachmentID}); !errors.Is(err, repository.ErrTaskWorkNotFound) {
		t.Fatalf("another user claimed comment draft: %v", err)
	}
	crossAccountComment := &domain.TaskComment{AccountID: accountB, TaskID: taskID, AuthorID: userB, Body: "Cruce"}
	if err := taskWork.CreateComment(ctx, crossAccountComment, nil, []uuid.UUID{foreignDraftAttachmentID}); err == nil {
		t.Fatal("cross-account comment draft was accepted")
	}

	// The media asset is account-deduplicated, but private drafts are owned
	// independently. Identical bytes uploaded concurrently by two commenters
	// on the same task must not block either comment or transfer ownership.
	viewerDraftAttachmentID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at)
		VALUES($1,$2,$3,$4,$5,'comment_draft',$5,NOW()+INTERVAL '2 hours')`, viewerDraftAttachmentID, accountA, taskID, foreignDraftAssetID, viewerA); err != nil {
		t.Fatalf("insert same-asset draft for second owner: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,available_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')`, accountA, foreignDraftAssetID, accountA.String()+"/_private/tasks/attachments/foreign-draft.pdf"); err != nil {
		t.Fatalf("schedule shared draft cleanup: %v", err)
	}
	viewerSharedComment := &domain.TaskComment{AccountID: accountA, TaskID: taskID, AuthorID: viewerA, Body: "Mismos bytes, borrador propio"}
	if err := taskWork.CreateComment(ctx, viewerSharedComment, nil, []uuid.UUID{viewerDraftAttachmentID}); err != nil {
		t.Fatalf("publish second owner's same-asset draft: %v", err)
	}
	var sharedCleanupCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountA, foreignDraftAssetID).Scan(&sharedCleanupCount); err != nil || sharedCleanupCount != 1 {
		t.Fatalf("other owner's pending draft lost cleanup: count=%d err=%v", sharedCleanupCount, err)
	}
	ownerSharedComment := &domain.TaskComment{AccountID: accountA, TaskID: taskID, AuthorID: userA, Body: "Publica su propio borrador"}
	if err := taskWork.CreateComment(ctx, ownerSharedComment, nil, []uuid.UUID{foreignDraftAttachmentID}); err != nil {
		t.Fatalf("publish first owner's same-asset draft: %v", err)
	}
	var sharedAttachmentCount, sharedRelationCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_attachments
		WHERE account_id=$1 AND task_id=$2 AND media_asset_id=$3 AND attachment_scope='comment'`, accountA, taskID, foreignDraftAssetID).Scan(&sharedAttachmentCount); err != nil {
		t.Fatalf("count shared comment attachments: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_comment_attachments
		WHERE account_id=$1 AND task_id=$2 AND attachment_id=ANY($3::uuid[])`, accountA, taskID, []uuid.UUID{foreignDraftAttachmentID, viewerDraftAttachmentID}).Scan(&sharedRelationCount); err != nil {
		t.Fatalf("count shared comment relations: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountA, foreignDraftAssetID).Scan(&sharedCleanupCount); err != nil {
		t.Fatalf("load shared draft cleanup after promotion: %v", err)
	}
	if sharedAttachmentCount != 2 || sharedRelationCount != 2 || sharedCleanupCount != 0 {
		t.Fatalf("same-asset owner isolation attachments=%d relations=%d cleanup=%d", sharedAttachmentCount, sharedRelationCount, sharedCleanupCount)
	}

	expiredAssetID, expiredAttachmentID := uuid.New(), uuid.New()
	expiredObjectKey := accountA.String() + "/_private/tasks/attachments/expired-draft.pdf"
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,status)
		VALUES($1,$2,$3,$4,'expired-draft.pdf','active')`, expiredAssetID, accountA, "expired-comment-draft-"+expiredAssetID.String(), expiredObjectKey); err != nil {
		t.Fatalf("insert expired comment draft media: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at)
		VALUES($1,$2,$3,$4,$5,'comment_draft',$5,NOW()-INTERVAL '1 minute')`, expiredAttachmentID, accountA, taskID, expiredAssetID, userA); err != nil {
		t.Fatalf("insert expired comment draft: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,available_at)
		VALUES($1,$2,$3,NOW()-INTERVAL '1 minute')`, accountA, expiredAssetID, expiredObjectKey); err != nil {
		t.Fatalf("schedule expired comment draft cleanup: %v", err)
	}
	futureAttachmentID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at)
		VALUES($1,$2,$3,$4,$5,'comment_draft',$5,NOW()+INTERVAL '1 hour')`, futureAttachmentID, accountA, orderConflictID, expiredAssetID, userA); err != nil {
		t.Fatalf("insert future draft sharing expired media: %v", err)
	}
	gcJob, err := taskWork.ClaimTaskMediaGCJob(ctx)
	if err != nil || gcJob.MediaAssetID != expiredAssetID {
		t.Fatalf("claim expired comment draft cleanup: job=%#v err=%v", gcJob, err)
	}
	prepared, err := taskWork.PrepareTaskMediaGCDeletion(ctx, gcJob)
	if err != nil || prepared {
		t.Fatalf("shared media ignored its future draft: prepared=%v err=%v", prepared, err)
	}
	var expiredDraftCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_attachments WHERE account_id=$1 AND id=$2`, accountA, expiredAttachmentID).Scan(&expiredDraftCount); err != nil || expiredDraftCount != 0 {
		t.Fatalf("expired comment draft retained: count=%d err=%v", expiredDraftCount, err)
	}
	var futureDraftCount, rescheduledJobCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_attachments WHERE account_id=$1 AND id=$2 AND draft_expires_at>NOW()`, accountA, futureAttachmentID).Scan(&futureDraftCount); err != nil {
		t.Fatalf("load future shared draft: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_media_gc_jobs
		WHERE account_id=$1 AND media_asset_id=$2 AND status='pending' AND claim_token IS NULL AND available_at>NOW()`, accountA, expiredAssetID).Scan(&rescheduledJobCount); err != nil {
		t.Fatalf("load rescheduled shared-draft cleanup: %v", err)
	}
	if futureDraftCount != 1 || rescheduledJobCount != 1 {
		t.Fatalf("shared draft cleanup was lost: future=%d rescheduled=%d", futureDraftCount, rescheduledJobCount)
	}
	if _, err := db.Exec(ctx, `UPDATE task_attachments SET draft_expires_at=NOW()-INTERVAL '1 minute'
		WHERE account_id=$1 AND id=$2`, accountA, futureAttachmentID); err != nil {
		t.Fatalf("expire remaining shared draft: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_media_gc_jobs SET available_at=NOW()-INTERVAL '1 minute'
		WHERE account_id=$1 AND media_asset_id=$2`, accountA, expiredAssetID); err != nil {
		t.Fatalf("make shared-draft cleanup due: %v", err)
	}
	gcJob, err = taskWork.ClaimTaskMediaGCJob(ctx)
	if err != nil || gcJob.MediaAssetID != expiredAssetID {
		t.Fatalf("reclaim shared comment draft cleanup: job=%#v err=%v", gcJob, err)
	}
	prepared, err = taskWork.PrepareTaskMediaGCDeletion(ctx, gcJob)
	if err != nil || !prepared {
		t.Fatalf("prepare final shared-draft cleanup: prepared=%v err=%v", prepared, err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM task_attachments WHERE account_id=$1 AND id=$2`, accountA, futureAttachmentID).Scan(&futureDraftCount); err != nil || futureDraftCount != 0 {
		t.Fatalf("final shared comment draft retained: count=%d err=%v", futureDraftCount, err)
	}
	// A content-hash reservation may reuse this media row after Prepare has
	// committed but before the old worker reports physical deletion. The stale
	// completion must fail closed against the replaced key and claim.
	reusedObjectKey := accountA.String() + "/_private/tasks/attachments/reused-after-gc.pdf"
	if _, err := db.Exec(ctx, `UPDATE media_assets SET object_key=$3,status='task_upload_pending',deleted_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountA, expiredAssetID, reusedObjectKey); err != nil {
		t.Fatalf("simulate media hash reuse after GC prepare: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_media_gc_jobs SET object_key=$3,status='pending',claim_token=NULL,
		available_at=NOW()+INTERVAL '1 hour',updated_at=NOW() WHERE id=$1 AND account_id=$2`, gcJob.ID, accountA, reusedObjectKey); err != nil {
		t.Fatalf("replace GC job for reused media: %v", err)
	}
	if err := taskWork.CompleteTaskMediaGCJob(ctx, gcJob, true); err != nil {
		t.Fatalf("complete stale GC claim: %v", err)
	}
	var reusedAssetKey, reusedAssetStatus, reusedJobKey, reusedJobStatus string
	var reusedJobClaim *uuid.UUID
	if err := db.QueryRow(ctx, `SELECT object_key,status FROM media_assets WHERE account_id=$1 AND id=$2`, accountA, expiredAssetID).
		Scan(&reusedAssetKey, &reusedAssetStatus); err != nil {
		t.Fatalf("load reused media after stale completion: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT object_key,status,claim_token FROM task_media_gc_jobs WHERE id=$1 AND account_id=$2`, gcJob.ID, accountA).
		Scan(&reusedJobKey, &reusedJobStatus, &reusedJobClaim); err != nil {
		t.Fatalf("load replacement GC job after stale completion: %v", err)
	}
	if reusedAssetKey != reusedObjectKey || reusedAssetStatus != "task_upload_pending" ||
		reusedJobKey != reusedObjectKey || reusedJobStatus != "pending" || reusedJobClaim != nil {
		t.Fatalf("stale GC completion mutated reused reservation: asset=(%q,%q) job=(%q,%q,%v)",
			reusedAssetKey, reusedAssetStatus, reusedJobKey, reusedJobStatus, reusedJobClaim)
	}
	if err := taskWork.SetAttachmentCommentResolved(ctx, accountA, taskID, attachmentID, rootCommentID, userA, true, 1, uuid.New()); err != nil {
		t.Fatalf("resolve anchored comment with UUID actor: %v", err)
	}
	if err := taskWork.SetAttachmentCommentResolved(ctx, accountA, taskID, attachmentID, rootCommentID, userA, false, 2, uuid.New()); err != nil {
		t.Fatalf("reopen anchored comment: %v", err)
	}
	if err := taskWork.SetAttachmentCommentResolved(ctx, accountA, taskID, attachmentID, replyCommentID, userA, true, 1, uuid.New()); !errors.Is(err, repository.ErrTaskAttachmentCommentRootRequired) {
		t.Fatalf("reply resolution error=%v, want root-required", err)
	}
	if err := taskWork.UpdateAttachmentComment(ctx, accountA, taskID, attachmentID, rootCommentID, userA, false, "Raíz editada", nil, 3, uuid.New()); err != nil {
		t.Fatalf("edit anchored root: %v", err)
	}
	if err := taskWork.DeleteAttachmentComment(ctx, accountA, taskID, attachmentID, rootCommentID, userA, false, 4, uuid.New()); err != nil {
		t.Fatalf("soft-delete anchored root with replies: %v", err)
	}
	comments, err := taskWork.ListAttachmentComments(ctx, accountA, taskID, attachmentID)
	if err != nil {
		t.Fatalf("list anchored comments after root deletion: %v", err)
	}
	var deletedRoot *domain.TaskAttachmentComment
	for _, comment := range comments {
		if comment.ID == rootCommentID {
			deletedRoot = comment
			break
		}
	}
	if len(comments) != 2 || deletedRoot == nil || !deletedRoot.Deleted || deletedRoot.Body != "" || deletedRoot.EditedAt == nil {
		t.Fatalf("deleted root was not returned as a safe tombstone: %#v", comments)
	}
	if err := taskWork.DeleteAttachmentComment(ctx, accountA, taskID, attachmentID, replyCommentID, userA, false, 1, uuid.New()); err != nil {
		t.Fatalf("delete reply retained under tombstone: %v", err)
	}
	comments, err = taskWork.ListAttachmentComments(ctx, accountA, taskID, attachmentID)
	if err != nil || len(comments) != 0 {
		t.Fatalf("root tombstone remained after its final reply disappeared: comments=%#v err=%v", comments, err)
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

	// Concurrent cross-environment moves serialize on the destination list and
	// allocate distinct durable root positions. A failed stale move rolls back
	// without changing either the new position or the child hierarchy.
	var moveVersionA, moveVersionB int64
	if err := db.QueryRow(ctx, `SELECT version FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&moveVersionA); err != nil {
		t.Fatalf("load first move version: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT version FROM tasks WHERE account_id=$1 AND id=$2`, accountA, orderConflictID).Scan(&moveVersionB); err != nil {
		t.Fatalf("load second move version: %v", err)
	}
	secondMoveChildID := uuid.New()
	const secondMoveChildOrder = 31337
	if _, err := db.Exec(ctx, `INSERT INTO tasks(id,account_id,created_by,assigned_to,title,type,priority,status,status_id,list_id,parent_task_id,sort_order)
		VALUES($1,$2,$3,$3,'Second move child','reminder','medium','pending',$4,$5,$6,$7)`,
		secondMoveChildID, accountA, userA, activeStatusID, defaultListA, taskID, secondMoveChildOrder); err != nil {
		t.Fatalf("insert second child before environment move: %v", err)
	}
	moveChildOrders := make(map[uuid.UUID]int)
	moveChildRows, err := db.Query(ctx, `SELECT id,sort_order FROM tasks
		WHERE account_id=$1 AND parent_task_id=$2 AND deleted_at IS NULL ORDER BY id`, accountA, taskID)
	if err != nil {
		t.Fatalf("load children before environment move: %v", err)
	}
	for moveChildRows.Next() {
		var childID uuid.UUID
		var childOrder int
		if err := moveChildRows.Scan(&childID, &childOrder); err != nil {
			moveChildRows.Close()
			t.Fatalf("scan child before environment move: %v", err)
		}
		moveChildOrders[childID] = childOrder
	}
	if err := moveChildRows.Err(); err != nil {
		moveChildRows.Close()
		t.Fatalf("iterate children before environment move: %v", err)
	}
	moveChildRows.Close()
	if len(moveChildOrders) < 2 || moveChildOrders[secondMoveChildID] != secondMoveChildOrder {
		t.Fatalf("environment move fixture must contain two exact child positions: %#v", moveChildOrders)
	}
	var privateMaxOrder int
	if err := db.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0) FROM tasks
		WHERE account_id=$1 AND list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL`, accountA, privateListID).Scan(&privateMaxOrder); err != nil {
		t.Fatalf("load private destination order: %v", err)
	}
	moveResults := make(chan error, 2)
	go func() {
		_, _, moveErr := repos.TaskWork.MoveTaskToEnvironment(ctx, accountA, userA, taskID, privateListID, moveVersionA, true, uuid.New())
		moveResults <- moveErr
	}()
	go func() {
		_, _, moveErr := repos.TaskWork.MoveTaskToEnvironment(ctx, accountA, userA, orderConflictID, privateListID, moveVersionB, true, uuid.New())
		moveResults <- moveErr
	}()
	firstMoveErr, secondMoveErr := <-moveResults, <-moveResults
	if firstMoveErr != nil || secondMoveErr != nil {
		t.Fatalf("concurrent environment moves failed: first=%v second=%v", firstMoveErr, secondMoveErr)
	}
	var movedOrderA, movedOrderB int
	var movedListA, movedListB uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_id,sort_order FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&movedListA, &movedOrderA); err != nil {
		t.Fatalf("load first moved root: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT list_id,sort_order FROM tasks WHERE account_id=$1 AND id=$2`, accountA, orderConflictID).Scan(&movedListB, &movedOrderB); err != nil {
		t.Fatalf("load second moved root: %v", err)
	}
	expectedMoveOrders := map[int]bool{privateMaxOrder + 1024: true, privateMaxOrder + 2048: true}
	if movedListA != privateListID || movedListB != privateListID || movedOrderA == movedOrderB ||
		!expectedMoveOrders[movedOrderA] || !expectedMoveOrders[movedOrderB] {
		t.Fatalf("environment move order/list mismatch roots=(%s,%d),(%s,%d)", movedListA, movedOrderA, movedListB, movedOrderB)
	}
	for childID, expectedOrder := range moveChildOrders {
		var movedChildList uuid.UUID
		var movedChildOrder int
		if err := db.QueryRow(ctx, `SELECT list_id,sort_order FROM tasks WHERE account_id=$1 AND id=$2`, accountA, childID).
			Scan(&movedChildList, &movedChildOrder); err != nil {
			t.Fatalf("load moved child %s: %v", childID, err)
		}
		if movedChildList != privateListID || movedChildOrder != expectedOrder {
			t.Fatalf("environment move changed child %s order/list: list=%s order=%d→%d", childID, movedChildList, expectedOrder, movedChildOrder)
		}
	}
	if _, _, staleMoveErr := repos.TaskWork.MoveTaskToEnvironment(ctx, accountA, userA, taskID, defaultListA, moveVersionA, true, uuid.New()); !errors.Is(staleMoveErr, repository.ErrTaskVersionConflict) {
		t.Fatalf("stale environment move did not conflict: %v", staleMoveErr)
	}
	var listAfterRollback uuid.UUID
	var orderAfterRollback int
	if err := db.QueryRow(ctx, `SELECT list_id,sort_order FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&listAfterRollback, &orderAfterRollback); err != nil || listAfterRollback != privateListID || orderAfterRollback != movedOrderA {
		t.Fatalf("stale move changed committed destination: list=%s order=%d err=%v", listAfterRollback, orderAfterRollback, err)
	}
	if err := db.QueryRow(ctx, `SELECT version FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&moveVersionA); err != nil {
		t.Fatalf("reload first return version: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT version FROM tasks WHERE account_id=$1 AND id=$2`, accountA, orderConflictID).Scan(&moveVersionB); err != nil {
		t.Fatalf("reload second return version: %v", err)
	}
	if _, _, err := repos.TaskWork.MoveTaskToEnvironment(ctx, accountA, userA, taskID, defaultListA, moveVersionA, true, uuid.New()); err != nil {
		t.Fatalf("return first task to original environment: %v", err)
	}
	if _, _, err := repos.TaskWork.MoveTaskToEnvironment(ctx, accountA, userA, orderConflictID, listID, moveVersionB, true, uuid.New()); err != nil {
		t.Fatalf("return second task to original environment: %v", err)
	}
	var returnedListA, returnedListB uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2`, accountA, taskID).Scan(&returnedListA); err != nil {
		t.Fatalf("load returned first task: %v", err)
	}
	if err := db.QueryRow(ctx, `SELECT list_id FROM tasks WHERE account_id=$1 AND id=$2`, accountA, orderConflictID).Scan(&returnedListB); err != nil {
		t.Fatalf("load returned second task: %v", err)
	}
	if returnedListA != defaultListA || returnedListB != listID {
		t.Fatalf("return move changed root hierarchy: roots=%s,%s", returnedListA, returnedListB)
	}
	for childID, expectedOrder := range moveChildOrders {
		var returnedChildList uuid.UUID
		var returnedChildOrder int
		if err := db.QueryRow(ctx, `SELECT list_id,sort_order FROM tasks WHERE account_id=$1 AND id=$2`, accountA, childID).
			Scan(&returnedChildList, &returnedChildOrder); err != nil {
			t.Fatalf("load returned child %s: %v", childID, err)
		}
		if returnedChildList != defaultListA || returnedChildOrder != expectedOrder {
			t.Fatalf("return move changed child %s hierarchy: list=%s order=%d→%d", childID, returnedChildList, expectedOrder, returnedChildOrder)
		}
	}

	targetWorkflowID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,created_by)
		VALUES($1,$2,$3,'Limited workflow',$4)`, targetWorkflowID, accountA, environmentA, userA); err != nil {
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
	folder := &domain.TaskFolder{AccountID: accountA, EnvironmentID: environmentA, WorkflowID: &targetWorkflowID, Name: "General contract", CreatedBy: userA}
	if err := repos.TaskWork.CreateFolder(ctx, folder); err != nil {
		t.Fatalf("create folder for default workflow contract: %v", err)
	}
	if err := repos.TaskWork.UpdateFolder(ctx, accountA, folder.ID, nil, nil, nil, nil, true); err != nil {
		t.Fatalf("reset folder to default workflow: %v", err)
	}
	var folderWorkflowID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT workflow_id FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, folder.ID).Scan(&folderWorkflowID); err != nil || folderWorkflowID != workflowA {
		t.Fatalf("folder did not resolve explicit null to default workflow: workflow=%s err=%v", folderWorkflowID, err)
	}
	firstMovableList, secondMovableList := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,workflow_inherited,name,color,sort_order,created_by) VALUES
		($1,$3,$4,$5,FALSE,'Primera movible','#0ea5e9',2048,$6),
		($2,$3,$4,$5,FALSE,'Segunda movible','#8b5cf6',3072,$6)`, firstMovableList, secondMovableList, accountA, environmentA, workflowA, userA); err != nil {
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
	if err := db.QueryRow(ctx, `SELECT icon FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, folder.ID).Scan(&persistedFolderIcon); err != nil || persistedFolderIcon != "folder" {
		t.Fatalf("folder icon was not normalized: icon=%q err=%v", persistedFolderIcon, err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_folders SET icon='rocket' WHERE account_id=$1 AND id=$2`, accountA, folder.ID); err == nil {
		t.Fatal("task folder accepted a mutable icon")
	}
	if _, err := db.Exec(ctx, `UPDATE task_lists SET icon='unsafe-icon' WHERE account_id=$1 AND id=$2`, accountA, firstMovableList); err == nil {
		t.Fatal("task list accepted an icon outside the controlled catalog")
	}
	secondFolder := &domain.TaskFolder{AccountID: accountA, EnvironmentID: environmentA, WorkflowID: &workflowA, Name: "Second ordered folder", CreatedBy: userA}
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
	var workflowB, environmentB uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id,environment_id FROM task_workflows WHERE account_id=$1 AND is_default`, accountB).Scan(&workflowB, &environmentB); err != nil {
		t.Fatalf("load second account workflow: %v", err)
	}
	foreignFolder := &domain.TaskFolder{AccountID: accountB, EnvironmentID: environmentB, WorkflowID: &workflowB, Name: "Foreign folder", CreatedBy: userB}
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
	limitedFolder := &domain.TaskFolder{AccountID: accountA, EnvironmentID: environmentA, WorkflowID: &targetWorkflowID, Name: "Limited folder", CreatedBy: userA}
	if err := repos.TaskWork.CreateFolder(ctx, limitedFolder); err != nil {
		t.Fatalf("create limited folder: %v", err)
	}
	workflowRollbackList, workflowRollbackTask := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,workflow_id,workflow_inherited,name,color,sort_order,created_by)
		VALUES($1,$2,$3,$4,FALSE,'Rollback workflow','#f97316',4096,$5)`, workflowRollbackList, accountA, environmentA, workflowA, userA); err != nil {
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
	if err := repos.TaskWork.RestoreTask(ctx, accountA, userA, orderConflictID); err != nil {
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
	if err := repos.TaskWork.RestoreTask(ctx, accountA, userA, promotedChildID); !errors.Is(err, repository.ErrTaskParentArchived) {
		t.Fatalf("child restored below archived parent: %v", err)
	}
	if err := repos.TaskWork.RestoreTask(ctx, accountA, userA, taskID); err != nil {
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
