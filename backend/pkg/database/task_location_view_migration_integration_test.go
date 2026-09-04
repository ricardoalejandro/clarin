package database

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskLocationViewMigrationIdempotencyAndForeignKeys(t *testing.T) {
	if os.Getenv("CLARIN_RUN_TASK_LOCATION_VIEW_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_TASK_LOCATION_VIEW_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_task_location_view_migration_test"
	adminURL, testURL := *parsed, *parsed
	adminURL.Path = "/postgres"
	testURL.Path = "/" + databaseName
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
	_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+databaseName); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = admin.Exec(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`, databaseName)
		_, _ = admin.Exec(ctx, `DROP DATABASE IF EXISTS `+databaseName)
	}()
	db, err := pgxpool.New(ctx, testURL.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Migrate(db); err != nil {
		t.Fatalf("initial migrate: %v", err)
	}
	if err := Migrate(db); err != nil {
		t.Fatalf("idempotent second migrate: %v", err)
	}
	var actorNullable, actorDeleteAction string
	if err := db.QueryRow(ctx, `SELECT is_nullable FROM information_schema.columns
		WHERE table_schema='public' AND table_name='task_location_view_operations' AND column_name='actor_id'`).Scan(&actorNullable); err != nil {
		t.Fatal(err)
	}
	if actorNullable != "NO" {
		t.Fatalf("operation actor_id remained nullable: %s", actorNullable)
	}
	if err := db.QueryRow(ctx, `SELECT constraint_item.confdeltype::text
		FROM pg_constraint constraint_item
		WHERE constraint_item.conrelid='task_location_view_operations'::regclass
		  AND constraint_item.conname='task_location_view_operations_actor_account_fk'`).Scan(&actorDeleteAction); err != nil {
		t.Fatal(err)
	}
	if actorDeleteAction != "c" {
		t.Fatalf("operation actor membership FK uses delete action %q, want cascade", actorDeleteAction)
	}

	accountA, accountB := uuid.New(), uuid.New()
	actorA, actorB := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Location A'),($2,'Location B')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO subscriptions(account_id,plan_code,status,current_period_start,current_period_end)
		VALUES($1,'enterprise','active',NOW(),NOW()+INTERVAL '1 year'),
			($2,'enterprise','active',NOW(),NOW()+INTERVAL '1 year')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash) VALUES
		($1,$3,$4,$5,'test'),($2,$6,$7,$8,'test')`, actorA, actorB, accountA,
		"location-a-"+actorA.String(), actorA.String()+"@test.invalid", accountB,
		"location-b-"+actorB.String(), actorB.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES
		($1,$2,'admin',TRUE),($3,$4,'admin',TRUE)`, actorA, accountA, actorB, accountB); err != nil {
		t.Fatal(err)
	}

	environmentA, environmentA2, environmentB := uuid.New(), uuid.New(), uuid.New()
	workflowA, workflowA2, workflowB := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_environments(id,account_id,name,visibility,default_access_level,created_by)
		VALUES($1,$2,'A','account','full',$3),($4,$2,'A2','account','full',$3),($5,$6,'B','account','full',$7)`,
		environmentA, accountA, actorA, environmentA2, environmentB, accountB, actorB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_workflows(id,account_id,environment_id,name,is_default,created_by)
		VALUES($1,$2,$3,'Workflow A',TRUE,$4),($5,$2,$6,'Workflow A2',TRUE,$4),($7,$8,$9,'Workflow B',TRUE,$10)`,
		workflowA, accountA, environmentA, actorA, workflowA2, environmentA2, workflowB, accountB, environmentB, actorB); err != nil {
		t.Fatal(err)
	}
	folderA, folderA2, folderB := uuid.New(), uuid.New(), uuid.New()
	listA, listA2, listB := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_folders(id,account_id,environment_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,'Folder A',$5),($6,$2,$7,$8,'Folder A2',$5),($9,$10,$11,$12,'Folder B',$13)`,
		folderA, accountA, environmentA, workflowA, actorA, folderA2, environmentA2, workflowA2,
		folderB, accountB, environmentB, workflowB, actorB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_lists(id,account_id,environment_id,folder_id,workflow_id,name,created_by)
		VALUES($1,$2,$3,$4,$5,'List A',$6),($7,$2,$8,$9,$10,'List A2',$6),($11,$12,$13,$14,$15,'List B',$16)`,
		listA, accountA, environmentA, folderA, workflowA, actorA,
		listA2, environmentA2, folderA2, workflowA2,
		listB, accountB, environmentB, folderB, workflowB, actorB); err != nil {
		t.Fatal(err)
	}
	boards := []uuid.UUID{uuid.New(), uuid.New(), uuid.New(), uuid.New()}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,created_by,updated_by) VALUES
		($1,$5,'Folder board 1',$6,$6),($2,$5,'Folder board 2',$6,$6),
		($3,$5,'List board',$6,$6),($4,$7,'Foreign board',$8,$8)`,
		boards[0], boards[1], boards[2], boards[3], accountA, actorA, accountB, actorB); err != nil {
		t.Fatal(err)
	}

	viewFolder1, viewFolder2, viewList := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(id,account_id,environment_id,folder_id,view_type,sort_order,created_by)
		VALUES($1,$2,$3,$4,'whiteboard',1024,$5),($6,$2,$3,$4,'whiteboard',2048,$5)`,
		viewFolder1, accountA, environmentA, folderA, actorA, viewFolder2); err != nil {
		t.Fatalf("multiple folder whiteboards: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(id,account_id,environment_id,list_id,view_type,sort_order,created_by)
		VALUES($1,$2,$3,$4,'whiteboard',1024,$5)`, viewList, accountA, environmentA, listA, actorA); err != nil {
		t.Fatalf("list whiteboard: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3),($1,$4,$5),($1,$6,$7)`, accountA, viewFolder1, boards[0], viewFolder2, boards[1], viewList, boards[2]); err != nil {
		t.Fatalf("one-to-one bindings: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_view_operations(
		account_id,actor_id,operation_id,action,request_payload_hash,result_task_view_id
	) VALUES($1,NULL,$2,'update',$3,$4)`, accountA, uuid.New(), strings.Repeat("0", 64), viewList); err == nil {
		t.Fatal("operation accepted a NULL authenticated actor")
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_view_operations(
		account_id,actor_id,operation_id,action,request_payload_hash,result_task_view_id
	) VALUES($1,$2,$3,'update',$4,$5)`, accountA, actorB, uuid.New(), strings.Repeat("0", 64), viewList); err == nil {
		t.Fatal("operation accepted an actor from another account")
	}

	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(account_id,environment_id,view_type,created_by)
		VALUES($1,$2,'whiteboard',$3)`, accountA, environmentA, actorA); err == nil {
		t.Fatal("XOR accepted a location without folder or list")
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(account_id,environment_id,folder_id,list_id,view_type,created_by)
		VALUES($1,$2,$3,$4,'whiteboard',$5)`, accountA, environmentA, folderA, listA, actorA); err == nil {
		t.Fatal("XOR accepted both folder and list")
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(account_id,environment_id,list_id,view_type,created_by)
		VALUES($1,$2,$3,'whiteboard',$4)`, accountA, environmentA, listA2, actorA); err == nil {
		t.Fatal("composite FK accepted a list from another environment")
	}
	foreignView := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO task_location_views(id,account_id,environment_id,list_id,view_type,created_by)
		VALUES($1,$2,$3,$4,'whiteboard',$5)`, foreignView, accountA, environmentA, listA, actorA); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3)`, accountA, foreignView, boards[3]); err == nil {
		t.Fatal("binding accepted a whiteboard from another account")
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3)`, accountA, foreignView, boards[0]); err == nil {
		t.Fatal("one-to-one binding accepted the same whiteboard twice")
	}

	// Exercise the repository transaction as well as the schema: the snapshot
	// inventory, board, initial revision, contextual view, binding and operation
	// must commit together, without creating a standalone grant.
	repos := repository.NewRepositories(db)
	scene := json.RawMessage(`{"elements":[],"appState":{},"files":{}}`)
	snapshotKey := "accounts/" + accountA.String() + "/whiteboards/location-create.json.gz"
	if _, err := db.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
		VALUES($1,$2,'whiteboard_snapshot','application/gzip','location-create.json.gz',128,'whiteboard_revision','pending')`,
		accountA, snapshotKey); err != nil {
		t.Fatal(err)
	}
	createdViewID, createdBoardID, createOperationID := uuid.New(), uuid.New(), uuid.New()
	createInput := repository.TaskLocationViewCreateInput{
		ViewID: createdViewID, BoardID: createdBoardID, AccountID: accountA, ActorID: actorA,
		ScopeType: domain.TaskAccessTargetList, ScopeID: listA, Name: "Atomic board", Scene: scene,
		SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.6", OperationID: createOperationID,
		RequestPayloadHash: strings.Repeat("a", 64), ResultSceneHash: strings.Repeat("b", 64),
		SnapshotObjectKey: snapshotKey, SnapshotContentHash: strings.Repeat("c", 64), SnapshotSizeBytes: 128,
	}
	created, idempotent, err := repos.TaskLocationView.Create(ctx, createInput)
	if err != nil || idempotent || created == nil || created.ID != createdViewID || !created.Capabilities.CanManage {
		t.Fatalf("atomic contextual create failed: item=%#v idempotent=%v err=%v", created, idempotent, err)
	}
	listed, hasMore, err := repos.TaskLocationView.List(ctx, accountA, actorA, repository.TaskLocationViewListOptions{
		ScopeType: domain.TaskAccessTargetList,
		ScopeID:   listA,
		Limit:     50,
	})
	if err != nil {
		t.Fatalf("list contextual views after create: %v", err)
	}
	if hasMore || len(listed) != 2 {
		t.Fatalf("list contextual views after create = %d items (has_more=%v), want 2", len(listed), hasMore)
	}
	for _, item := range listed {
		if item == nil || item.Scope == nil || item.Scope.ScopeType != domain.TaskAccessTargetList ||
			item.Scope.ScopeID != listA || item.Resource.Whiteboard == nil || !item.Capabilities.CanManage {
			t.Fatalf("list returned a non-canonical contextual view: %#v", item)
		}
	}
	firstPage, hasMore, err := repos.TaskLocationView.List(ctx, accountA, actorA, repository.TaskLocationViewListOptions{
		ScopeType: domain.TaskAccessTargetList,
		ScopeID:   listA,
		Limit:     1,
	})
	if err != nil || !hasMore || len(firstPage) != 1 {
		t.Fatalf("first contextual cursor page: items=%d has_more=%v err=%v", len(firstPage), hasMore, err)
	}
	afterOrder, afterID := firstPage[0].SortOrder, firstPage[0].ID
	secondPage, hasMore, err := repos.TaskLocationView.List(ctx, accountA, actorA, repository.TaskLocationViewListOptions{
		ScopeType:      domain.TaskAccessTargetList,
		ScopeID:        listA,
		AfterSortOrder: &afterOrder,
		AfterID:        &afterID,
		Limit:          1,
	})
	if err != nil || hasMore || len(secondPage) != 1 || secondPage[0].ID == firstPage[0].ID {
		t.Fatalf("second contextual cursor page: items=%d has_more=%v err=%v", len(secondPage), hasMore, err)
	}
	replayed, idempotent, err := repos.TaskLocationView.Create(ctx, createInput)
	if err != nil || !idempotent || replayed == nil || replayed.ID != createdViewID {
		t.Fatalf("create retry did not return canonical result: item=%#v idempotent=%v err=%v", replayed, idempotent, err)
	}
	conflictingCreate := createInput
	conflictingCreate.RequestPayloadHash = strings.Repeat("d", 64)
	if _, _, err := repos.TaskLocationView.Create(ctx, conflictingCreate); !errors.Is(err, repository.ErrTaskLocationViewConflict) {
		t.Fatalf("operation id reuse with another create payload was accepted: %v", err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO task_location_view_operations(
		account_id,actor_id,operation_id,action,request_payload_hash,result_task_view_id
	) VALUES($1,$2,$3,'update',$4,$5)`, accountA, actorA, createOperationID, strings.Repeat("d", 64), createdViewID); err == nil {
		t.Fatal("unique account/actor/operation id accepted a duplicate replay row")
	}
	var grants int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2`, accountA, createdBoardID).Scan(&grants); err != nil {
		t.Fatal(err)
	}
	if grants != 0 {
		t.Fatalf("contextual create produced %d standalone grants", grants)
	}

	var canonicalScene json.RawMessage
	if err := db.QueryRow(ctx, `SELECT scene_json FROM whiteboards WHERE account_id=$1 AND id=$2`, accountA, createdBoardID).Scan(&canonicalScene); err != nil {
		t.Fatal(err)
	}
	duplicateSnapshotKey := "accounts/" + accountA.String() + "/whiteboards/location-duplicate.json.gz"
	if _, err := db.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
		VALUES($1,$2,'whiteboard_snapshot','application/gzip','location-duplicate.json.gz',128,'whiteboard_revision','pending')`,
		accountA, duplicateSnapshotKey); err != nil {
		t.Fatal(err)
	}
	duplicateInput := repository.TaskLocationViewDuplicateInput{
		ViewID: uuid.New(), BoardID: uuid.New(), SourceViewID: createdViewID, SourceBoardID: createdBoardID,
		AccountID: accountA, ActorID: actorA, Name: "Atomic board copy", ExpectedVersion: created.Version,
		Scene: canonicalScene, SceneSchemaVersion: "excalidraw", EditorVersion: "0.18.1-clarin.6",
		OperationID: uuid.New(), RequestPayloadHash: strings.Repeat("e", 64), ResultSceneHash: strings.Repeat("f", 64),
		SnapshotObjectKey: duplicateSnapshotKey, SnapshotContentHash: strings.Repeat("1", 64), SnapshotSizeBytes: 128,
	}
	duplicated, idempotent, err := repos.TaskLocationView.Duplicate(ctx, duplicateInput)
	if err != nil || idempotent || duplicated == nil || duplicated.ID != duplicateInput.ViewID || duplicated.Scope == nil ||
		duplicated.Scope.ScopeID != listA {
		t.Fatalf("atomic contextual duplicate failed: item=%#v idempotent=%v err=%v", duplicated, idempotent, err)
	}
	if replayedDuplicate, replayedID, replayErr := repos.TaskLocationView.Duplicate(ctx, duplicateInput); replayErr != nil ||
		!replayedID || replayedDuplicate == nil || replayedDuplicate.ID != duplicateInput.ViewID {
		t.Fatalf("duplicate retry did not return canonical result: item=%#v idempotent=%v err=%v", replayedDuplicate, replayedID, replayErr)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2`, accountA, duplicateInput.BoardID).Scan(&grants); err != nil {
		t.Fatal(err)
	}
	if grants != 0 {
		t.Fatalf("contextual duplicate produced %d standalone grants", grants)
	}

	affectedBoardIDs, err := repos.TaskWork.UpdateListLocation(
		ctx, accountA, listA, nil, true, nil, false, nil, nil, nil, nil, nil, nil,
	)
	if err != nil {
		t.Fatalf("move list with contextual boards: %v", err)
	}
	expectedAffected := map[uuid.UUID]bool{
		boards[2]:              false,
		createdBoardID:         false,
		duplicateInput.BoardID: false,
	}
	for _, boardID := range affectedBoardIDs {
		seen, expected := expectedAffected[boardID]
		if !expected || seen {
			t.Fatalf("list move returned an unexpected or duplicate board invalidation: %s (%v)", boardID, affectedBoardIDs)
		}
		expectedAffected[boardID] = true
	}
	for boardID, seen := range expectedAffected {
		if !seen {
			t.Fatalf("list move omitted contextual board invalidation %s: %v", boardID, affectedBoardIDs)
		}
		var accessRevision int64
		if err := db.QueryRow(ctx, `SELECT access_revision FROM whiteboards WHERE account_id=$1 AND id=$2`, accountA, boardID).Scan(&accessRevision); err != nil {
			t.Fatal(err)
		}
		if accessRevision != 2 {
			t.Fatalf("list move left board %s at access_revision=%d, want 2", boardID, accessRevision)
		}
	}
	for _, viewID := range []uuid.UUID{viewList, createdViewID, duplicateInput.ViewID} {
		var accessRevision int64
		if err := db.QueryRow(ctx, `SELECT access_revision FROM task_location_views WHERE account_id=$1 AND id=$2`, accountA, viewID).Scan(&accessRevision); err != nil {
			t.Fatal(err)
		}
		if accessRevision != 2 {
			t.Fatalf("list move left view %s at access_revision=%d, want 2", viewID, accessRevision)
		}
	}
	noOpAffected, err := repos.TaskWork.UpdateListLocation(
		ctx, accountA, listA, nil, true, nil, false, nil, nil, nil, nil, nil, nil,
	)
	if err != nil || len(noOpAffected) != 0 {
		t.Fatalf("same-location update invalidated contextual boards: affected=%v err=%v", noOpAffected, err)
	}

	failedViewID, failedBoardID := uuid.New(), uuid.New()
	failedCreate := createInput
	failedCreate.ViewID, failedCreate.BoardID, failedCreate.OperationID = failedViewID, failedBoardID, uuid.New()
	failedCreate.RequestPayloadHash = strings.Repeat("2", 64)
	failedCreate.SnapshotObjectKey = "accounts/" + accountA.String() + "/whiteboards/missing-snapshot.json.gz"
	if _, _, err := repos.TaskLocationView.Create(ctx, failedCreate); !errors.Is(err, repository.ErrTaskLocationViewConflict) {
		t.Fatalf("create without an inventoried snapshot did not fail atomically: %v", err)
	}
	var rolledBack int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM whiteboards WHERE account_id=$1 AND id=$2)+
		(SELECT COUNT(*) FROM task_location_views WHERE account_id=$1 AND id=$3)+
		(SELECT COUNT(*) FROM task_location_whiteboard_views WHERE account_id=$1 AND (task_view_id=$3 OR whiteboard_id=$2))`,
		accountA, failedBoardID, failedViewID).Scan(&rolledBack); err != nil {
		t.Fatal(err)
	}
	if rolledBack != 0 {
		t.Fatalf("failed contextual create left %d persisted rows", rolledBack)
	}

	if _, err := db.Exec(ctx, `UPDATE subscriptions SET status='suspended',suspended_at=NOW() WHERE account_id=$1`, accountA); err != nil {
		t.Fatal(err)
	}
	if _, err := repos.Whiteboard.RequireAccess(ctx, accountA, actorA, createdBoardID, domain.WhiteboardAccessView); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("suspended subscription retained canonical board access: %v", err)
	}
	if _, _, err := repos.TaskLocationView.Update(ctx, accountA, actorA, createdViewID, repository.TaskLocationViewUpdateInput{
		Name: "Must stay unchanged", ExpectedVersion: created.Version, OperationID: uuid.New(), RequestPayloadHash: strings.Repeat("3", 64),
	}); !errors.Is(err, repository.ErrTaskLocationViewNotFound) {
		t.Fatalf("suspended subscription admitted a contextual mutation: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE subscriptions SET status='active',suspended_at=NULL,current_period_end=NOW()+INTERVAL '1 year' WHERE account_id=$1`, accountA); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE accounts SET is_active=FALSE WHERE id=$1`, accountA); err != nil {
		t.Fatal(err)
	}
	if _, err := repos.Whiteboard.RequireAccess(ctx, accountA, actorA, createdBoardID, domain.WhiteboardAccessView); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("inactive account retained canonical board access: %v", err)
	}

	if _, err := db.Exec(ctx, `DELETE FROM task_lists WHERE account_id=$1 AND id=$2`, accountA, listA); err == nil {
		t.Fatal("list deletion bypassed RESTRICT while a contextual view exists")
	}
	if _, err := db.Exec(ctx, `DELETE FROM whiteboards WHERE account_id=$1 AND id=$2`, accountA, boards[0]); err == nil {
		t.Fatal("whiteboard deletion bypassed RESTRICT while a binding exists")
	}
}
