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
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskTrashAndArchiveActorAccessIsolation(t *testing.T) {
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
	const databaseName = "clarin_task_trash_access_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
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
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(cleanupCtx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatalf("connect disposable database: %v", err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate disposable database: %v", err)
	}

	accountA, accountB := uuid.New(), uuid.New()
	actorA, actorB, adminA := uuid.New(), uuid.New(), uuid.New()
	roleID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name,task_trash_retention_days,whiteboard_trash_retention_days)
		VALUES($1,'Trash ACL A',30,30),($2,'Trash ACL B',30,30)`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year'),
			($2,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO roles(id,name,permissions)
		VALUES($1,$2,ARRAY['tasks','whiteboards']::text[])`, roleID, "Trash ACL "+roleID.String()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash)
		VALUES($1,$2,$3,$4,'test'),($5,$6,$7,$8,'test'),($9,$2,$10,$11,'test')`,
		actorA, accountA, "trash-a-"+actorA.String(), actorA.String()+"@test.invalid",
		actorB, accountB, "trash-b-"+actorB.String(), actorB.String()+"@test.invalid",
		adminA, "trash-admin-"+adminA.String(), adminA.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,role_id,is_default)
		VALUES($1,$2,'agent',$3,TRUE),($4,$5,'agent',$3,TRUE),($6,$2,'admin',NULL,FALSE)`,
		actorA, accountA, roleID, actorB, accountB, adminA); err != nil {
		t.Fatal(err)
	}

	hiddenEnvironment, directEnvironment, folderEnvironment, deletedEnvironment := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	foreignEnvironment := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_environments(
		id,account_id,name,visibility,default_access_level,created_by,deleted_at
	) VALUES
		($1,$2,'Denied environment','account','full',$3,NOW()-INTERVAL '60 days'),
		($4,$2,'Direct list environment','account','view',$3,NULL),
		($5,$2,'Folder count environment','account','full',$3,NULL),
		($6,$2,'Deleted environment','account','full',$3,NOW()-INTERVAL '60 days'),
		($7,$8,'Foreign environment','account','full',$9,NOW()-INTERVAL '60 days')`,
		hiddenEnvironment, accountA, actorA, directEnvironment, folderEnvironment, deletedEnvironment,
		foreignEnvironment, accountB, actorB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_environment_grants(account_id,environment_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'none',$3)`, accountA, hiddenEnvironment, actorA); err != nil {
		t.Fatal(err)
	}

	workflowHidden, workflowDirect, workflowFolder, workflowDeleted, workflowForeign := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by)
		VALUES($1,$2,$3,'Hidden workflow',TRUE,$4),
			($5,$2,$6,'Direct workflow',TRUE,$4),
			($7,$2,$8,'Folder workflow',TRUE,$4),
			($9,$2,$10,'Deleted workflow',TRUE,$4),
			($11,$12,$13,'Foreign workflow',TRUE,$14)`,
		workflowHidden, accountA, hiddenEnvironment, actorA,
		workflowDirect, directEnvironment,
		workflowFolder, folderEnvironment,
		workflowDeleted, deletedEnvironment,
		workflowForeign, accountB, foreignEnvironment, actorB); err != nil {
		t.Fatal(err)
	}
	statusHidden, statusDirect, statusFolder, statusDeleted, statusForeign := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_statuses(id,account_id,workflow_id,name,category,is_default)
		VALUES($1,$2,$3,'Hidden done','done',TRUE),
			($4,$2,$5,'Direct done','done',TRUE),
			($6,$2,$7,'Folder done','done',TRUE),
			($8,$2,$9,'Deleted done','done',TRUE),
			($10,$11,$12,'Foreign done','done',TRUE)`,
		statusHidden, accountA, workflowHidden,
		statusDirect, workflowDirect,
		statusFolder, workflowFolder,
		statusDeleted, workflowDeleted,
		statusForeign, accountB, workflowForeign); err != nil {
		t.Fatal(err)
	}

	hiddenTrashParent, hiddenArchiveParent, trashFolder := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_folders(
		id,account_id,environment_id,workflow_id,name,created_by,deleted_at
	) VALUES
		($1,$2,$3,$4,'Secret trash parent',$5,NOW()-INTERVAL '60 days'),
		($6,$2,$3,$4,'Secret archive parent',$5,NULL),
		($7,$2,$8,$9,'Visible trash folder',$5,NOW()-INTERVAL '60 days')`,
		hiddenTrashParent, accountA, directEnvironment, workflowDirect, actorA,
		hiddenArchiveParent, trashFolder, folderEnvironment, workflowFolder); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by)
		VALUES($1,$2,$4,'none',$4),($1,$3,$4,'none',$4)`, accountA, hiddenTrashParent, hiddenArchiveParent, actorA); err != nil {
		t.Fatal(err)
	}
	raceFolder := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'Lifecycle race folder',$5)`, raceFolder, accountA, folderEnvironment, workflowFolder, adminA); err != nil {
		t.Fatal(err)
	}

	directTrashList, directArchiveList := uuid.New(), uuid.New()
	folderVisibleList, folderDeniedList := uuid.New(), uuid.New()
	deletedVisibleList, deletedDeniedList := uuid.New(), uuid.New()
	foreignList := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(
		id,account_id,environment_id,folder_id,workflow_id,name,created_by,archived_at,deleted_at,deleted_with_folder,deleted_with_environment
	) VALUES
		($1,$2,$3,$4,$5,'Direct trash list',$6,NULL,NOW()-INTERVAL '60 days',FALSE,FALSE),
		($7,$2,$3,$8,$5,'Direct archive list',$6,NOW()-INTERVAL '60 days',NULL,FALSE,FALSE),
		($9,$2,$10,$11,$12,'Visible child',$6,NULL,NOW()-INTERVAL '60 days',TRUE,FALSE),
		($13,$2,$10,$11,$12,'Denied child',$6,NULL,NOW()-INTERVAL '60 days',TRUE,FALSE),
		($14,$2,$15,NULL,$16,'Visible deleted child',$6,NULL,NOW()-INTERVAL '60 days',FALSE,TRUE),
		($17,$2,$15,NULL,$16,'Denied deleted child',$6,NULL,NOW()-INTERVAL '60 days',FALSE,TRUE),
		($18,$19,$20,NULL,$21,'Foreign deleted child',$22,NULL,NOW()-INTERVAL '60 days',FALSE,TRUE)`,
		directTrashList, accountA, directEnvironment, hiddenTrashParent, workflowDirect, actorA,
		directArchiveList, hiddenArchiveParent,
		folderVisibleList, folderEnvironment, trashFolder, workflowFolder,
		folderDeniedList,
		deletedVisibleList, deletedEnvironment, workflowDeleted,
		deletedDeniedList,
		foreignList, accountB, foreignEnvironment, workflowForeign, actorB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_list_access_grants(account_id,list_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'full',$3),($1,$4,$3,'full',$3),
			($1,$5,$3,'none',$3),($1,$6,$3,'none',$3)`,
		accountA, directTrashList, actorA, directArchiveList, folderDeniedList, deletedDeniedList); err != nil {
		t.Fatal(err)
	}
	raceList := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,folder_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,$5,'Lifecycle race list',$6)`, raceList, accountA, folderEnvironment, raceFolder, workflowFolder, adminA); err != nil {
		t.Fatal(err)
	}

	taskDirect, taskFolderVisible, taskFolderDenied := uuid.New(), uuid.New(), uuid.New()
	taskDeletedVisible, taskDeletedDenied := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(
		id,account_id,created_by,assigned_to,title,status,status_id,list_id,deleted_at
	) VALUES
		($1,$2,$3,$3,'Direct trash task','completed',$4,$5,NOW()-INTERVAL '60 days'),
		($6,$2,$3,$3,'Visible folder task','completed',$7,$8,NOW()-INTERVAL '60 days'),
		($9,$2,$3,$3,'Denied folder task','completed',$7,$10,NOW()-INTERVAL '60 days'),
		($11,$2,$3,$3,'Visible environment task','completed',$12,$13,NOW()-INTERVAL '60 days'),
		($14,$2,$3,$3,'Denied environment task','completed',$12,$15,NOW()-INTERVAL '60 days')`,
		taskDirect, accountA, actorA, statusDirect, directTrashList,
		taskFolderVisible, statusFolder, folderVisibleList,
		taskFolderDenied, folderDeniedList,
		taskDeletedVisible, statusDeleted, deletedVisibleList,
		taskDeletedDenied, deletedDeniedList); err != nil {
		t.Fatal(err)
	}

	boardFolder, boardFolderVisible, boardFolderDenied := uuid.New(), uuid.New(), uuid.New()
	boardDirect, boardDeletedVisible, boardDeletedDenied := uuid.New(), uuid.New(), uuid.New()
	boards := []uuid.UUID{boardFolder, boardFolderVisible, boardFolderDenied, boardDirect, boardDeletedVisible, boardDeletedDenied}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,created_by,updated_by)
		VALUES($1,$7,'Folder board',$8,$8),($2,$7,'Visible folder board',$8,$8),
			($3,$7,'Denied folder board',$8,$8),($4,$7,'Direct board',$8,$8),
			($5,$7,'Visible deleted board',$8,$8),($6,$7,'Denied deleted board',$8,$8)`,
		boards[0], boards[1], boards[2], boards[3], boards[4], boards[5], accountA, actorA); err != nil {
		t.Fatal(err)
	}
	viewFolder, viewFolderVisible, viewFolderDenied := uuid.New(), uuid.New(), uuid.New()
	viewDirect, viewDeletedVisible, viewDeletedDenied := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(
		id,account_id,environment_id,folder_id,list_id,view_type,sort_order,created_by
	) VALUES
		($1,$7,$8,$9,NULL,'whiteboard',1024,$10),
		($2,$7,$8,NULL,$11,'whiteboard',1024,$10),
		($3,$7,$8,NULL,$12,'whiteboard',1024,$10),
		($4,$7,$13,NULL,$14,'whiteboard',1024,$10),
		($5,$7,$15,NULL,$16,'whiteboard',1024,$10),
		($6,$7,$15,NULL,$17,'whiteboard',1024,$10)`,
		viewFolder, viewFolderVisible, viewFolderDenied, viewDirect, viewDeletedVisible, viewDeletedDenied,
		accountA, folderEnvironment, trashFolder, actorA, folderVisibleList, folderDeniedList,
		directEnvironment, directTrashList, deletedEnvironment, deletedVisibleList, deletedDeniedList); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$8),($1,$3,$9),($1,$4,$10),($1,$5,$11),($1,$6,$12),($1,$7,$13)`,
		accountA, viewFolder, viewFolderVisible, viewFolderDenied, viewDirect, viewDeletedVisible, viewDeletedDenied,
		boardFolder, boardFolderVisible, boardFolderDenied, boardDirect, boardDeletedVisible, boardDeletedDenied); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE task_location_views SET deleted_at=NOW()-INTERVAL '5 days'
		WHERE account_id=$1 AND id=ANY($2::uuid[])`,
		accountA, []uuid.UUID{viewDirect, viewFolderDenied, viewDeletedDenied}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboards SET archived_at=NOW()-INTERVAL '5 days'
		WHERE account_id=$1 AND id=ANY($2::uuid[])`,
		accountA, []uuid.UUID{boardDirect, boardFolderDenied, boardDeletedDenied}); err != nil {
		t.Fatal(err)
	}

	repo := repository.NewRepositories(db).TaskWork
	now := time.Now().UTC()
	directItems, err := repo.ListTrashContainers(ctx, accountA, actorA, directEnvironment, now, true)
	if err != nil {
		t.Fatalf("list direct Trash: %v", err)
	}
	if len(directItems) != 1 || directItems[0].ID != directTrashList || directItems[0].Type != "list" {
		t.Fatalf("direct list under hidden parent was not the only visible Trash item: %#v", directItems)
	}
	if directItems[0].OriginalFolderID != nil || directItems[0].OriginalFolderName != "" {
		t.Fatalf("hidden parent leaked through Trash breadcrumb: %#v", directItems[0])
	}
	if !directItems[0].RestoreBlocked || directItems[0].TaskCount != 1 || directItems[0].WhiteboardCount != 1 {
		t.Fatalf("redaction changed operational state or authorized counts: %#v", directItems[0])
	}
	if directItems[0].CanPurge || directItems[0].NextEligibleAt == nil || !directItems[0].NextEligibleAt.After(now) {
		t.Fatalf("visible explicit whiteboard deletion did not extend Trash retention: %#v", directItems[0])
	}
	directItemsWithoutWhiteboards, err := repo.ListTrashContainers(ctx, accountA, actorA, directEnvironment, now, false)
	if err != nil {
		t.Fatalf("list direct Trash with whiteboard module hidden: %v", err)
	}
	if len(directItemsWithoutWhiteboards) != 1 || directItemsWithoutWhiteboards[0].WhiteboardCount != 0 ||
		!directItemsWithoutWhiteboards[0].CanPurge || directItemsWithoutWhiteboards[0].NextEligibleAt == nil ||
		directItemsWithoutWhiteboards[0].NextEligibleAt.After(now) {
		t.Fatalf("hidden whiteboard metadata changed Work retention: %#v", directItemsWithoutWhiteboards)
	}

	folderItems, err := repo.ListTrashContainers(ctx, accountA, actorA, folderEnvironment, now, true)
	if err != nil {
		t.Fatalf("list folder Trash: %v", err)
	}
	if len(folderItems) != 1 || folderItems[0].ID != trashFolder || folderItems[0].Type != "folder" {
		t.Fatalf("visible Folder Trash item mismatch: %#v", folderItems)
	}
	if folderItems[0].ListCount != 1 || folderItems[0].TaskCount != 1 || folderItems[0].WhiteboardCount != 2 {
		t.Fatalf("Folder counts leaked denied List descendants: %#v", folderItems[0])
	}
	if !folderItems[0].CanPurge || folderItems[0].NextEligibleAt == nil || folderItems[0].NextEligibleAt.After(now) {
		t.Fatalf("denied child whiteboard leaked through Folder retention metadata: %#v", folderItems[0])
	}
	if _, err := repo.RestoreFolder(ctx, accountA, actorA, trashFolder); !errors.Is(err, repository.ErrTaskWorkNotFound) {
		t.Fatalf("Folder restore bypassed a denied child List: %v", err)
	}
	var folderStillDeleted bool
	if err := db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM task_folders WHERE account_id=$1 AND id=$2`, accountA, trashFolder).Scan(&folderStillDeleted); err != nil {
		t.Fatal(err)
	}
	if !folderStillDeleted {
		t.Fatal("failed recursive Folder authorization did not roll back")
	}

	environments, err := repo.ListTrashEnvironments(ctx, accountA, actorA, now, true)
	if err != nil {
		t.Fatalf("list environment Trash: %v", err)
	}
	if len(environments) != 1 || environments[0].ID != deletedEnvironment {
		t.Fatalf("environment deny was not honored: %#v", environments)
	}
	if environments[0].ListCount != 1 || environments[0].TaskCount != 1 || environments[0].WhiteboardCount != 1 {
		t.Fatalf("Entorno counts leaked denied descendants: %#v", environments[0])
	}
	if !environments[0].CanPurge || environments[0].NextEligibleAt == nil || environments[0].NextEligibleAt.After(now) {
		t.Fatalf("denied child whiteboard leaked through Entorno retention metadata: %#v", environments[0])
	}

	foreignActorItems, err := repo.ListTrashContainers(ctx, accountA, actorB, directEnvironment, now, true)
	if err != nil || len(foreignActorItems) != 0 {
		t.Fatalf("cross-account actor read account A Trash: items=%#v err=%v", foreignActorItems, err)
	}
	foreignActorEnvironments, err := repo.ListTrashEnvironments(ctx, accountB, actorA, now, true)
	if err != nil || len(foreignActorEnvironments) != 0 {
		t.Fatalf("cross-account actor read account B Trash: items=%#v err=%v", foreignActorEnvironments, err)
	}
	accountBEnvironments, err := repo.ListTrashEnvironments(ctx, accountB, actorB, now, true)
	if err != nil || len(accountBEnvironments) != 1 || accountBEnvironments[0].ID != foreignEnvironment {
		t.Fatalf("account B fixture was not independently visible: items=%#v err=%v", accountBEnvironments, err)
	}

	archiveFolders, archiveRoots, err := repo.ListArchiveHierarchyForActor(ctx, accountA, actorA, directEnvironment, true)
	if err != nil {
		t.Fatalf("list direct Archive: %v", err)
	}
	if len(archiveFolders) != 0 || len(archiveRoots) != 1 || archiveRoots[0].ID != directArchiveList || archiveRoots[0].FolderID != nil {
		t.Fatalf("historical List leaked hidden Folder ID: folders=%#v roots=%#v", archiveFolders, archiveRoots)
	}
	if folders, roots, err := repo.ListArchiveHierarchyForActor(ctx, accountA, actorB, directEnvironment, true); !errors.Is(err, repository.ErrTaskWorkNotFound) || len(folders) != 0 || len(roots) != 0 {
		t.Fatalf("cross-account actor read Archive: folders=%#v roots=%#v err=%v", folders, roots, err)
	}

	// Reproduce the ancestor-ACL race deterministically. A different account
	// admin has written the Folder deny and owns the common account authority
	// barrier, while ArchiveList has already locked the child List and performed
	// its preflight. Once the deny commits, ArchiveList must re-resolve after the
	// barrier and roll back without changing archived_at.
	aclTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer aclTx.Rollback(ctx)
	if _, err := aclTx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731942))`, adminA); err != nil {
		t.Fatal(err)
	}
	if _, err := aclTx.Exec(ctx, `SELECT id FROM user_accounts
		WHERE account_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR KEY SHARE`,
		accountA, []uuid.UUID{actorA, adminA}); err != nil {
		t.Fatal(err)
	}
	if _, err := aclTx.Exec(ctx, `SELECT id FROM task_folders WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, raceFolder); err != nil {
		t.Fatal(err)
	}
	if _, err := aclTx.Exec(ctx, `INSERT INTO task_folder_access_grants(account_id,folder_id,user_id,access_level,created_by)
		VALUES($1,$2,$3,'none',$4)`, accountA, raceFolder, actorA, adminA); err != nil {
		t.Fatal(err)
	}
	if _, err := aclTx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,731943))`, accountA); err != nil {
		t.Fatal(err)
	}

	archiveResult := make(chan error, 1)
	go func() {
		_, archiveErr := repo.ArchiveList(context.Background(), accountA, actorA, raceList)
		archiveResult <- archiveErr
	}()
	deadline := time.Now().Add(4 * time.Second)
	blocked := false
	for time.Now().Before(deadline) {
		if err := db.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND pid<>pg_backend_pid()
			  AND wait_event_type='Lock' AND query ILIKE '%731943%'
		)`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("ArchiveList did not block on the final account authority barrier")
	}
	if err := aclTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case archiveErr := <-archiveResult:
		if !errors.Is(archiveErr, repository.ErrTaskWorkNotFound) {
			t.Fatalf("ancestor deny lost race with ArchiveList: %v", archiveErr)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("ArchiveList did not finish after ACL commit")
	}
	var archived bool
	if err := db.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, raceList).Scan(&archived); err != nil {
		t.Fatal(err)
	}
	if archived {
		t.Fatal("denied ArchiveList changed lifecycle state despite final ACL revalidation")
	}
	if _, err := repo.TrashEnvironment(ctx, accountA, actorA, folderEnvironment, "Folder count environment", 1); !errors.Is(err, repository.ErrTaskAccessDenied) {
		t.Fatalf("Entorno lifecycle bypassed a denied descendant Folder/List: %v", err)
	}
	var environmentStillActive bool
	if err := db.QueryRow(ctx, `SELECT deleted_at IS NULL FROM task_environments WHERE account_id=$1 AND id=$2`, accountA, folderEnvironment).Scan(&environmentStillActive); err != nil {
		t.Fatal(err)
	}
	if !environmentStillActive {
		t.Fatal("failed recursive Entorno authorization did not roll back")
	}
}
