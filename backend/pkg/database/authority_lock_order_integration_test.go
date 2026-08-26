package database

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func waitForMembershipKeyShare(ctx context.Context, db *pgxpool.Pool, accountID, userID uuid.UUID) error {
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		tx, err := db.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='30ms'`); err != nil {
			_ = tx.Rollback(ctx)
			return err
		}
		var membershipID uuid.UUID
		err = tx.QueryRow(ctx, `SELECT id FROM user_accounts
			WHERE account_id=$1 AND user_id=$2 FOR UPDATE`, accountID, userID).Scan(&membershipID)
		_ = tx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "55P03" {
			return nil
		}
		if err != nil {
			return err
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("mutation did not lock membership before its resource")
}

func waitForBlockedMembershipRemoval(ctx context.Context, db *pgxpool.Pool) error {
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		err := db.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND pid<>pg_backend_pid()
			  AND wait_event_type='Lock'
			  AND ((query ILIKE '%SELECT id FROM user_accounts%' AND query ILIKE '%FOR UPDATE%')
				OR query ILIKE '%pg_advisory_xact_lock%')
		)`).Scan(&blocked)
		if err != nil {
			return err
		}
		if blocked {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("membership removal did not block behind the canonical authority/membership lock")
}

func assertNoDeadlock(t *testing.T, name string, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "40P01" {
		t.Fatalf("%s deadlocked: %v", name, err)
	}
	if err != nil {
		t.Fatalf("%s failed: %v", name, err)
	}
}

func TestAuthorityMutationsUseMembershipBeforeResourceLocks(t *testing.T) {
	if os.Getenv("CLARIN_RUN_AUTHORITY_LOCK_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_AUTHORITY_LOCK_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("parse DATABASE_URL: %v", err)
	}
	const databaseName = "clarin_authority_lock_order_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
	actorID, taskRecipientID, boardRecipientID, libraryActorID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	participantRecipientID, moveRecipientID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Lock A'),($2,'Lock B')`, accountA, accountB); err != nil {
		t.Fatalf("insert accounts: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year'),
			($2,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountA, accountB); err != nil {
		t.Fatalf("insert subscriptions: %v", err)
	}
	userIDs := []uuid.UUID{actorID, taskRecipientID, boardRecipientID, libraryActorID, participantRecipientID, moveRecipientID}
	for index, userID := range userIDs {
		primaryAccountID := accountB
		if userID == actorID {
			primaryAccountID = accountA
		}
		username := "lock-user-" + userID.String()
		if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name)
			VALUES($1,$2,$3,$4,'test',$5)`, userID, primaryAccountID, username,
			userID.String()+"@test.invalid", "Lock user "+string(rune('A'+index))); err != nil {
			t.Fatalf("insert user %d: %v", index, err)
		}
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES
		($1,$7,'admin',TRUE),
		($2,$7,'agent',FALSE),($2,$8,'agent',TRUE),
		($3,$7,'agent',FALSE),($3,$8,'agent',TRUE),
		($4,$7,'admin',FALSE),($4,$8,'agent',TRUE),
		($5,$7,'agent',FALSE),($5,$8,'agent',TRUE),
		($6,$7,'agent',FALSE),($6,$8,'agent',TRUE)`,
		actorID, taskRecipientID, boardRecipientID, libraryActorID, participantRecipientID, moveRecipientID, accountA, accountB); err != nil {
		t.Fatalf("insert memberships: %v", err)
	}
	repositories := repository.NewRepositories(db)

	var listID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_lists
		WHERE account_id=$1 AND is_default AND archived_at IS NULL AND deleted_at IS NULL
		ORDER BY id LIMIT 1`, accountA).Scan(&listID); err != nil {
		t.Fatalf("load default Work list: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_list_access_grants(
		account_id,list_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'view',FALSE,$4)`, accountA, listID, taskRecipientID, actorID); err != nil {
		t.Fatalf("seed Work grant: %v", err)
	}
	taskBlocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := taskBlocker.QueryRow(ctx, `SELECT id FROM task_lists WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, listID).Scan(new(uuid.UUID)); err != nil {
		_ = taskBlocker.Rollback(ctx)
		t.Fatalf("lock Work list fixture: %v", err)
	}
	taskReplaceResult := make(chan error, 1)
	go func() {
		_, _, _, replaceErr := repositories.TaskWork.ReplaceAccessGrants(ctx, accountA, actorID,
			domain.TaskAccessTargetList, listID, nil,
			[]repository.TaskAccessGrantInput{{UserID: taskRecipientID, AccessLevel: domain.TaskAccessView}},
			1, uuid.New())
		taskReplaceResult <- replaceErr
	}()
	if err := waitForMembershipKeyShare(ctx, db, accountA, taskRecipientID); err != nil {
		_ = taskBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	taskRemoveResult := make(chan error, 1)
	go func() {
		_, removeErr := repositories.UserAccount.RemoveWithActorAndNormalize(ctx, taskRecipientID, accountA, actorID)
		taskRemoveResult <- removeErr
	}()
	if err := waitForBlockedMembershipRemoval(ctx, db); err != nil {
		_ = taskBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	if err := taskBlocker.Rollback(ctx); err != nil {
		t.Fatalf("release Work list fixture: %v", err)
	}
	assertNoDeadlock(t, "Task ACL replacement", <-taskReplaceResult)
	assertNoDeadlock(t, "Task membership removal", <-taskRemoveResult)
	var taskMemberships, taskGrants int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2),
		(SELECT COUNT(*) FROM task_list_access_grants WHERE account_id=$1 AND list_id=$3 AND user_id=$2)`,
		accountA, taskRecipientID, listID).Scan(&taskMemberships, &taskGrants); err != nil {
		t.Fatalf("read Work race result: %v", err)
	}
	if taskMemberships != 0 || taskGrants != 0 {
		t.Fatalf("Work race did not end canonically: memberships=%d grants=%d", taskMemberships, taskGrants)
	}

	boardID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,name,scene_json,scene_schema_version,editor_version,access_mode,created_by,updated_by
	) VALUES($1,$2,'Lock board','{"type":"excalidraw","elements":[],"appState":{},"files":{}}'::jsonb,
		'excalidraw','test','private',$3,$3)`, boardID, accountA, actorID); err != nil {
		t.Fatalf("insert board: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_grants(
		account_id,board_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'manage',TRUE,$3),($1,$2,$4,'view',FALSE,$3)`,
		accountA, boardID, actorID, boardRecipientID); err != nil {
		t.Fatalf("seed board grants: %v", err)
	}
	boardBlocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := boardBlocker.QueryRow(ctx, `SELECT id FROM whiteboards WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, boardID).Scan(new(uuid.UUID)); err != nil {
		_ = boardBlocker.Rollback(ctx)
		t.Fatalf("lock board fixture: %v", err)
	}
	boardReplaceResult := make(chan error, 1)
	go func() {
		_, replaceErr := repositories.Whiteboard.ReplaceBoardAccess(ctx, accountA, actorID, boardID,
			domain.WhiteboardAccessPrivate,
			[]repository.WhiteboardGrantInput{{UserID: boardRecipientID, AccessLevel: domain.WhiteboardAccessView}},
			1, uuid.New())
		boardReplaceResult <- replaceErr
	}()
	if err := waitForMembershipKeyShare(ctx, db, accountA, boardRecipientID); err != nil {
		_ = boardBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	boardRemoveResult := make(chan error, 1)
	go func() {
		_, removeErr := repositories.UserAccount.RemoveWithActorAndNormalize(ctx, boardRecipientID, accountA, actorID)
		boardRemoveResult <- removeErr
	}()
	if err := waitForBlockedMembershipRemoval(ctx, db); err != nil {
		_ = boardBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	if err := boardBlocker.Rollback(ctx); err != nil {
		t.Fatalf("release board fixture: %v", err)
	}
	assertNoDeadlock(t, "board ACL replacement", <-boardReplaceResult)
	assertNoDeadlock(t, "board membership removal", <-boardRemoveResult)
	var boardMemberships, boardGrants int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2),
		(SELECT COUNT(*) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$3 AND user_id=$2)`,
		accountA, boardRecipientID, boardID).Scan(&boardMemberships, &boardGrants); err != nil {
		t.Fatalf("read board ACL race result: %v", err)
	}
	if boardMemberships != 0 || boardGrants != 0 {
		t.Fatalf("board ACL race did not end canonically: memberships=%d grants=%d", boardMemberships, boardGrants)
	}

	var libraryID uuid.UUID
	if err := db.QueryRow(ctx, `INSERT INTO whiteboard_libraries(
		account_id,name,library_json,visibility,created_by,updated_by
	) VALUES($1,$2,'{"libraryItems":[]}'::jsonb,'private',$3,$3) RETURNING id`,
		accountA, "Lock library "+libraryActorID.String(), libraryActorID).Scan(&libraryID); err != nil {
		t.Fatalf("insert private library: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_grants(
		account_id,board_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'view',FALSE,$4)`, accountA, boardID, libraryActorID, actorID); err != nil {
		t.Fatalf("seed library actor board grant: %v", err)
	}
	libraryBlocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := libraryBlocker.QueryRow(ctx, `SELECT id FROM whiteboards WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, boardID).Scan(new(uuid.UUID)); err != nil {
		_ = libraryBlocker.Rollback(ctx)
		t.Fatalf("lock library board fixture: %v", err)
	}
	libraryStartResult := make(chan error, 1)
	go func() {
		_, startErr := repositories.Whiteboard.StartWhiteboardLibraryImport(ctx, accountA, libraryActorID,
			boardID, libraryID, repository.WhiteboardLibraryImportStartInput{
				TokenHash: strings.Repeat("a", 64), ExpiresAt: time.Now().UTC().Add(15 * time.Minute),
			})
		libraryStartResult <- startErr
	}()
	if err := waitForMembershipKeyShare(ctx, db, accountA, libraryActorID); err != nil {
		_ = libraryBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	libraryRemoveResult := make(chan error, 1)
	go func() {
		_, removeErr := repositories.UserAccount.RemoveWithActorAndNormalize(ctx, libraryActorID, accountA, actorID)
		libraryRemoveResult <- removeErr
	}()
	if err := waitForBlockedMembershipRemoval(ctx, db); err != nil {
		_ = libraryBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	if err := libraryBlocker.Rollback(ctx); err != nil {
		t.Fatalf("release library board fixture: %v", err)
	}
	assertNoDeadlock(t, "library import start", <-libraryStartResult)
	assertNoDeadlock(t, "library actor membership removal", <-libraryRemoveResult)
	var libraryMemberships, libraryGrants, importSessions int
	var libraryCreator *uuid.UUID
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2),
		(SELECT COUNT(*) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$3 AND user_id=$2),
		(SELECT COUNT(*) FROM whiteboard_library_import_sessions WHERE account_id=$1 AND actor_id=$2),
		(SELECT created_by FROM whiteboard_libraries WHERE account_id=$1 AND id=$4)`,
		accountA, libraryActorID, boardID, libraryID).Scan(
		&libraryMemberships, &libraryGrants, &importSessions, &libraryCreator); err != nil {
		t.Fatalf("read library race result: %v", err)
	}
	if libraryMemberships != 0 || libraryGrants != 0 || importSessions != 0 || libraryCreator != nil {
		t.Fatalf("library race did not end canonically: memberships=%d grants=%d imports=%d creator=%v",
			libraryMemberships, libraryGrants, importSessions, libraryCreator)
	}

	var sourceEnvironmentID, sourceStatusID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT list_item.environment_id,status_item.id
		FROM task_lists list_item
		JOIN task_statuses status_item ON status_item.account_id=list_item.account_id
			AND status_item.workflow_id=list_item.workflow_id AND status_item.is_default
		WHERE list_item.account_id=$1 AND list_item.id=$2`, accountA, listID).
		Scan(&sourceEnvironmentID, &sourceStatusID); err != nil {
		t.Fatalf("load source Work status: %v", err)
	}

	participantTaskID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(
		id,account_id,created_by,assigned_to,title,due_at,status,status_id,list_id,access_mode,version,sort_order
	) VALUES($1,$2,$3,$3,'Participant lock',NOW()+INTERVAL '1 day','pending',$4,$5,'private',1,1024)`,
		participantTaskID, accountA, actorID, sourceStatusID, listID); err != nil {
		t.Fatalf("insert participant task: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_access_grants(
		account_id,task_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'view',FALSE,$4)`, accountA, participantTaskID, participantRecipientID, actorID); err != nil {
		t.Fatalf("seed participant task grant: %v", err)
	}
	participantBlocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := participantBlocker.QueryRow(ctx, `SELECT id FROM tasks
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, participantTaskID).Scan(new(uuid.UUID)); err != nil {
		_ = participantBlocker.Rollback(ctx)
		t.Fatalf("lock participant task fixture: %v", err)
	}
	participantMutationResult := make(chan error, 1)
	go func() {
		operationID := uuid.New()
		_, mutationErr := repositories.TaskWork.SetCollaborators(ctx, accountA, participantTaskID, actorID,
			[]uuid.UUID{participantRecipientID}, 1, true, &operationID)
		participantMutationResult <- mutationErr
	}()
	if err := waitForMembershipKeyShare(ctx, db, accountA, participantRecipientID); err != nil {
		_ = participantBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	participantRemoveResult := make(chan error, 1)
	go func() {
		_, removeErr := repositories.UserAccount.RemoveWithActorAndNormalize(ctx, participantRecipientID, accountA, actorID)
		participantRemoveResult <- removeErr
	}()
	if err := waitForBlockedMembershipRemoval(ctx, db); err != nil {
		_ = participantBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	if err := participantBlocker.Rollback(ctx); err != nil {
		t.Fatalf("release participant task fixture: %v", err)
	}
	assertNoDeadlock(t, "participant grant confirmation", <-participantMutationResult)
	assertNoDeadlock(t, "participant membership removal", <-participantRemoveResult)
	var participantMemberships, participantGrants, participantRows int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2),
		(SELECT COUNT(*) FROM task_access_grants WHERE account_id=$1 AND task_id=$3 AND user_id=$2),
		(SELECT COUNT(*) FROM task_collaborators WHERE account_id=$1 AND task_id=$3 AND user_id=$2)`,
		accountA, participantRecipientID, participantTaskID).Scan(
		&participantMemberships, &participantGrants, &participantRows); err != nil {
		t.Fatalf("read participant race result: %v", err)
	}
	if participantMemberships != 0 || participantGrants != 0 || participantRows != 0 {
		t.Fatalf("participant race did not end canonically: memberships=%d grants=%d collaborators=%d",
			participantMemberships, participantGrants, participantRows)
	}

	destinationEnvironment := &domain.TaskEnvironment{
		AccountID:   accountA,
		Name:        "Lock destination " + moveRecipientID.String(),
		Description: "Disposable lock-order fixture",
		Color:       "#6366F1",
		Icon:        "layers",
	}
	if err := repositories.TaskWork.CreateEnvironment(ctx, destinationEnvironment, actorID, nil); err != nil {
		t.Fatalf("create destination environment: %v", err)
	}
	var destinationListID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM task_lists
		WHERE account_id=$1 AND environment_id=$2 AND is_default
			AND archived_at IS NULL AND deleted_at IS NULL`, accountA, destinationEnvironment.ID).
		Scan(&destinationListID); err != nil {
		t.Fatalf("load destination Work list: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_environment_grants(
		account_id,environment_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'view',FALSE,$4)`, accountA, destinationEnvironment.ID, moveRecipientID, actorID); err != nil {
		t.Fatalf("seed destination environment grant: %v", err)
	}
	moveTaskID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO tasks(
		id,account_id,created_by,assigned_to,title,due_at,status,status_id,list_id,access_mode,version,sort_order
	) VALUES($1,$2,$3,$3,'Environment move lock',NOW()+INTERVAL '1 day','pending',$4,$5,'private',1,2048)`,
		moveTaskID, accountA, actorID, sourceStatusID, listID); err != nil {
		t.Fatalf("insert move task: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_collaborators(account_id,task_id,user_id,created_by)
		VALUES($1,$2,$3,$4)`, accountA, moveTaskID, moveRecipientID, actorID); err != nil {
		t.Fatalf("seed move collaborator: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_access_grants(
		account_id,task_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'view',FALSE,$4)`, accountA, moveTaskID, moveRecipientID, actorID); err != nil {
		t.Fatalf("seed move task grant: %v", err)
	}
	moveBlocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := moveBlocker.QueryRow(ctx, `SELECT id FROM tasks
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, moveTaskID).Scan(new(uuid.UUID)); err != nil {
		_ = moveBlocker.Rollback(ctx)
		t.Fatalf("lock move task fixture: %v", err)
	}
	moveMutationResult := make(chan error, 1)
	go func() {
		_, _, moveErr := repositories.TaskWork.MoveTaskToEnvironment(ctx, accountA, actorID, moveTaskID,
			destinationListID, 1, true, uuid.New())
		moveMutationResult <- moveErr
	}()
	if err := waitForMembershipKeyShare(ctx, db, accountA, moveRecipientID); err != nil {
		_ = moveBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	moveRemoveResult := make(chan error, 1)
	go func() {
		_, removeErr := repositories.UserAccount.RemoveWithActorAndNormalize(ctx, moveRecipientID, accountA, actorID)
		moveRemoveResult <- removeErr
	}()
	if err := waitForBlockedMembershipRemoval(ctx, db); err != nil {
		_ = moveBlocker.Rollback(ctx)
		t.Fatal(err)
	}
	if err := moveBlocker.Rollback(ctx); err != nil {
		t.Fatalf("release move task fixture: %v", err)
	}
	assertNoDeadlock(t, "cross-environment participant grants", <-moveMutationResult)
	assertNoDeadlock(t, "move participant membership removal", <-moveRemoveResult)
	var moveMemberships, moveGrants, moveCollaborators int
	var canonicalListID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=$2),
		(SELECT COUNT(*) FROM task_access_grants WHERE account_id=$1 AND task_id=$3 AND user_id=$2),
		(SELECT COUNT(*) FROM task_collaborators WHERE account_id=$1 AND task_id=$3 AND user_id=$2),
		(SELECT list_id FROM tasks WHERE account_id=$1 AND id=$3)`, accountA, moveRecipientID, moveTaskID).
		Scan(&moveMemberships, &moveGrants, &moveCollaborators, &canonicalListID); err != nil {
		t.Fatalf("read move race result: %v", err)
	}
	if moveMemberships != 0 || moveGrants != 0 || moveCollaborators != 0 || canonicalListID != destinationListID {
		t.Fatalf("move race did not end canonically: memberships=%d grants=%d collaborators=%d list=%s want=%s",
			moveMemberships, moveGrants, moveCollaborators, canonicalListID, destinationListID)
	}
	if sourceEnvironmentID == destinationEnvironment.ID {
		t.Fatal("move fixture did not create a distinct destination environment")
	}
}
