package database

import (
	"context"
	"encoding/json"
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

func waitForBlockedLockQuery(ctx context.Context, db *pgxpool.Pool, queryPattern string) error {
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		var blocked bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(
			SELECT 1 FROM pg_stat_activity
			WHERE datname=current_database() AND pid<>pg_backend_pid()
			  AND state='active' AND wait_event_type='Lock' AND query ILIKE $1
		)`, queryPattern).Scan(&blocked); err != nil {
			return err
		}
		if blocked {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return errors.New("timed out waiting for the expected PostgreSQL lock")
}

func assertExpectedLockOrderError(t *testing.T, name string, err error) {
	t.Helper()
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "40P01" {
		t.Fatalf("%s deadlocked: %v", name, err)
	}
	if err == nil {
		t.Fatalf("%s unexpectedly succeeded against a missing fixture resource", name)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		t.Fatalf("%s did not finish after the canonical lock was released: %v", name, err)
	}
}

func TestWorkWhiteboardPurgeAccountActorLockOrder(t *testing.T) {
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
	const databaseName = "clarin_work_whiteboard_purge_lock_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
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

	accountID, actorID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(
		id,name,task_trash_retention_days,whiteboard_trash_retention_days
	) VALUES($1,'Work whiteboard lock order',30,30)`, accountID); err != nil {
		t.Fatalf("insert account: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(
		account_id,plan_code,status,current_period_start,current_period_end
	) VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountID); err != nil {
		t.Fatalf("insert subscription: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(
		id,account_id,username,email,password_hash,display_name
	) VALUES($1,$2,$3,$4,'test','Lock actor')`, actorID, accountID,
		"work-whiteboard-lock-"+actorID.String(), actorID.String()+"@test.invalid"); err != nil {
		t.Fatalf("insert actor: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default)
		VALUES($1,$2,'admin',TRUE)`, actorID, accountID); err != nil {
		t.Fatalf("insert actor membership: %v", err)
	}
	repositories := repository.NewRepositories(db)

	t.Run("Work purge waits for account before actor", func(t *testing.T) {
		caseCtx, caseCancel := context.WithTimeout(ctx, 8*time.Second)
		defer caseCancel()
		accountBlocker, err := db.Begin(caseCtx)
		if err != nil {
			t.Fatal(err)
		}
		if err := accountBlocker.QueryRow(caseCtx,
			`SELECT id FROM accounts WHERE id=$1 FOR UPDATE`, accountID).Scan(new(uuid.UUID)); err != nil {
			_ = accountBlocker.Rollback(caseCtx)
			t.Fatalf("lock account fixture: %v", err)
		}
		purgeResult := make(chan error, 1)
		go func() {
			_, purgeErr := repositories.TaskWork.PurgeList(caseCtx, accountID, actorID,
				uuid.New(), "missing", time.Now().UTC(), true)
			purgeResult <- purgeErr
		}()
		if err := waitForBlockedLockQuery(caseCtx, db,
			"%SELECT id FROM accounts WHERE id=$1 FOR UPDATE%"); err != nil {
			_ = accountBlocker.Rollback(caseCtx)
			t.Fatal(err)
		}

		actorProbe, err := db.Begin(caseCtx)
		if err != nil {
			_ = accountBlocker.Rollback(caseCtx)
			t.Fatal(err)
		}
		var actorLockAvailable bool
		if err := actorProbe.QueryRow(caseCtx,
			`SELECT pg_try_advisory_xact_lock(hashtextextended($1::text,731942))`, actorID).
			Scan(&actorLockAvailable); err != nil {
			_ = actorProbe.Rollback(caseCtx)
			_ = accountBlocker.Rollback(caseCtx)
			t.Fatal(err)
		}
		_ = actorProbe.Rollback(caseCtx)
		if !actorLockAvailable {
			_ = accountBlocker.Rollback(caseCtx)
			t.Fatal("Work purge took the actor lock before the account lock")
		}
		if err := accountBlocker.Rollback(caseCtx); err != nil {
			t.Fatalf("release account fixture: %v", err)
		}
		assertExpectedLockOrderError(t, "Work purge", <-purgeResult)
	})

	scene := json.RawMessage(`{"type":"excalidraw","elements":[],"appState":{},"files":{}}`)
	type accountFirstOperation struct {
		name string
		run  func(context.Context) error
	}
	operations := []accountFirstOperation{
		{
			name: "contextual create versus Work purge",
			run: func(operationCtx context.Context) error {
				_, _, operationErr := repositories.TaskLocationView.Create(operationCtx, repository.TaskLocationViewCreateInput{
					ViewID: uuid.New(), BoardID: uuid.New(), AccountID: accountID, ActorID: actorID,
					ScopeType: domain.TaskAccessTargetList, ScopeID: uuid.New(), Name: "Lock create",
					Scene: scene, SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.5",
					OperationID: uuid.New(), RequestPayloadHash: strings.Repeat("a", 64),
					ResultSceneHash: strings.Repeat("b", 64), SnapshotObjectKey: "lock/create.json",
					SnapshotContentHash: strings.Repeat("c", 64), SnapshotSizeBytes: int64(len(scene)),
				})
				return operationErr
			},
		},
		{
			name: "contextual duplicate versus Work purge",
			run: func(operationCtx context.Context) error {
				_, _, operationErr := repositories.TaskLocationView.Duplicate(operationCtx, repository.TaskLocationViewDuplicateInput{
					ViewID: uuid.New(), BoardID: uuid.New(), SourceViewID: uuid.New(), SourceBoardID: uuid.New(),
					AccountID: accountID, ActorID: actorID, Name: "Lock duplicate", ExpectedVersion: 1,
					Scene: scene, SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.5",
					OperationID: uuid.New(), RequestPayloadHash: strings.Repeat("d", 64),
					ResultSceneHash: strings.Repeat("e", 64), SnapshotObjectKey: "lock/duplicate.json",
					SnapshotContentHash: strings.Repeat("f", 64), SnapshotSizeBytes: int64(len(scene)),
				})
				return operationErr
			},
		},
		{
			name: "whiteboard purge versus Work purge",
			run: func(operationCtx context.Context) error {
				_, operationErr := repositories.Whiteboard.PurgeBoard(operationCtx, accountID, actorID,
					uuid.New(), "missing", time.Now().UTC())
				return operationErr
			},
		},
	}

	for _, operation := range operations {
		operation := operation
		t.Run(operation.name, func(t *testing.T) {
			caseCtx, caseCancel := context.WithTimeout(ctx, 8*time.Second)
			defer caseCancel()
			actorBlocker, err := db.Begin(caseCtx)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := actorBlocker.Exec(caseCtx,
				`SELECT pg_advisory_xact_lock(hashtextextended($1::text,731942))`, actorID); err != nil {
				_ = actorBlocker.Rollback(caseCtx)
				t.Fatalf("lock actor fixture: %v", err)
			}

			operationResult := make(chan error, 1)
			go func() { operationResult <- operation.run(caseCtx) }()
			if err := waitForBlockedLockQuery(caseCtx, db, "%pg_advisory_xact_lock%731942%"); err != nil {
				_ = actorBlocker.Rollback(caseCtx)
				t.Fatal(err)
			}

			purgeResult := make(chan error, 1)
			go func() {
				_, purgeErr := repositories.TaskWork.PurgeList(caseCtx, accountID, actorID,
					uuid.New(), "missing", time.Now().UTC(), true)
				purgeResult <- purgeErr
			}()
			if err := waitForBlockedLockQuery(caseCtx, db,
				"%SELECT id FROM accounts WHERE id=$1 FOR UPDATE%"); err != nil {
				_ = actorBlocker.Rollback(caseCtx)
				t.Fatal(err)
			}

			if err := actorBlocker.Rollback(caseCtx); err != nil {
				t.Fatalf("release actor fixture: %v", err)
			}
			assertExpectedLockOrderError(t, operation.name, <-operationResult)
			assertExpectedLockOrderError(t, operation.name+" Work side", <-purgeResult)
		})
	}
}
