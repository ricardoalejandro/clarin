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
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

func whiteboardInt64Pointer(value int64) *int64 { return &value }

func TestWhiteboardMigrationRepositoryIsolationAndIdempotency(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_MIGRATION_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_MIGRATION_INTEGRATION=1 in an isolated PostgreSQL environment")
	}
	rawURL := os.Getenv("DATABASE_URL")
	if rawURL == "" {
		t.Fatal("DATABASE_URL is required")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	const databaseName = "clarin_whiteboard_migration_test"
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
		t.Fatalf("idempotent migrate: %v", err)
	}
	for constraintName, expectedDefinition := range map[string]string{
		"whiteboard_folders_created_by_account_fk":                      "FOREIGN KEY (account_id, created_by) REFERENCES user_accounts(account_id, user_id)",
		"whiteboard_assets_uploaded_by_account_fk":                      "FOREIGN KEY (account_id, uploaded_by) REFERENCES user_accounts(account_id, user_id)",
		"whiteboard_guest_sessions_link_board_account_fk":               "FOREIGN KEY (account_id, board_id, share_link_id) REFERENCES whiteboard_share_links(account_id, board_id, id)",
		"whiteboard_operations_guest_board_account_fk":                  "FOREIGN KEY (account_id, board_id, guest_session_id) REFERENCES whiteboard_guest_sessions(account_id, board_id, id)",
		"whiteboard_revisions_guest_board_account_fk":                   "FOREIGN KEY (account_id, board_id, guest_session_id) REFERENCES whiteboard_guest_sessions(account_id, board_id, id)",
		"whiteboard_assets_guest_board_account_fk":                      "FOREIGN KEY (account_id, board_id, guest_session_id) REFERENCES whiteboard_guest_sessions(account_id, board_id, id)",
		"whiteboard_activity_guest_board_account_fk":                    "FOREIGN KEY (account_id, board_id, guest_session_id) REFERENCES whiteboard_guest_sessions(account_id, board_id, id)",
		"whiteboard_comment_threads_account_id_board_id_fkey":           "FOREIGN KEY (account_id, board_id) REFERENCES whiteboards(account_id, id)",
		"whiteboard_comments_account_id_board_id_thread_id_fkey":        "FOREIGN KEY (account_id, board_id, thread_id) REFERENCES whiteboard_comment_threads(account_id, board_id, id)",
		"whiteboard_library_import_sessions_account_id_library_id_fkey": "FOREIGN KEY (account_id, library_id) REFERENCES whiteboard_libraries(account_id, id)",
	} {
		var definition string
		if err := db.QueryRow(ctx, `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname=$1`, constraintName).Scan(&definition); err != nil {
			t.Fatalf("read constraint %s: %v", constraintName, err)
		}
		if !strings.Contains(definition, expectedDefinition) {
			t.Fatalf("constraint %s lost account/board scope: %s", constraintName, definition)
		}
	}
	var libraryDescriptionConstraintValidated bool
	if err := db.QueryRow(ctx, `SELECT convalidated FROM pg_constraint
		WHERE conname='whiteboard_libraries_description_length_check'`).Scan(&libraryDescriptionConstraintValidated); err != nil {
		t.Fatalf("read library description constraint validation state: %v", err)
	}
	if !libraryDescriptionConstraintValidated {
		t.Fatal("whiteboard library description constraint must be validated")
	}
	var importCompletionConstraintValidated bool
	var importCompletionConstraintDefinition string
	if err := db.QueryRow(ctx, `SELECT convalidated,pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname='whiteboard_library_import_completed_version_check'`).Scan(
		&importCompletionConstraintValidated, &importCompletionConstraintDefinition); err != nil {
		t.Fatalf("read library import completion constraint: %v", err)
	}
	if !importCompletionConstraintValidated || !strings.Contains(importCompletionConstraintDefinition, "completed_library_version") {
		t.Fatalf("library import completion version is not enforced: validated=%v definition=%s",
			importCompletionConstraintValidated, importCompletionConstraintDefinition)
	}
	accountA, accountB := uuid.New(), uuid.New()
	creator, viewer, observer, foreign := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO accounts(id,name) VALUES($1,'Whiteboard A'),($2,'Whiteboard B')`, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name) VALUES
		($1,$4,$5,$6,'test','Creator'),($2,$4,$7,$8,'test','Viewer'),($3,$9,$10,$11,'test','Foreign')`,
		creator, viewer, foreign, accountA, "wb-"+creator.String(), creator.String()+"@test.invalid",
		"wb-"+viewer.String(), viewer.String()+"@test.invalid", accountB,
		"wb-"+foreign.String(), foreign.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default) VALUES
		($1,$4,'agent',TRUE),($2,$4,'agent',FALSE),($3,$5,'agent',TRUE)`, creator, viewer, foreign, accountA, accountB); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO users(id,account_id,username,email,password_hash,display_name)
		VALUES($1,$2,$3,$4,'test','Observer')`, observer, accountA, "wb-"+observer.String(), observer.String()+"@test.invalid"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO user_accounts(user_id,account_id,role,is_default)
		VALUES($1,$2,'agent',FALSE)`, observer, accountA); err != nil {
		t.Fatal(err)
	}
	repo := repository.NewRepositories(db).Whiteboard
	if _, err := repo.CreateFolder(ctx, accountA, foreign, repository.WhiteboardFolderInput{Name: "Foreign author"}); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("cross-account folder author was accepted: %v", err)
	}
	lockTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := lockTx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, accountA.String()); err != nil {
		_ = lockTx.Rollback(ctx)
		t.Fatal(err)
	}
	blockedContext, cancelBlocked := context.WithTimeout(ctx, 100*time.Millisecond)
	_, blockedErr := repo.CreateFolder(blockedContext, accountA, creator, repository.WhiteboardFolderInput{Name: "Must wait"})
	cancelBlocked()
	if !errors.Is(blockedErr, context.DeadlineExceeded) {
		_ = lockTx.Rollback(ctx)
		t.Fatalf("same-account hierarchy mutation bypassed advisory lock: %v", blockedErr)
	}
	if _, err := repo.CreateFolder(ctx, accountB, foreign, repository.WhiteboardFolderInput{Name: "Other account proceeds"}); err != nil {
		_ = lockTx.Rollback(ctx)
		t.Fatalf("account-scoped lock blocked another account: %v", err)
	}
	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	var parentID *uuid.UUID
	for depth := 1; depth <= 20; depth++ {
		folder, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{
			ParentID: parentID, Name: "Depth " + strings.Repeat("x", depth), Description: "integration",
		})
		if err != nil {
			t.Fatalf("create folder depth %d: %v", depth, err)
		}
		value := folder.ID
		parentID = &value
	}
	if _, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{ParentID: parentID, Name: "Too deep"}); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("depth 21 was not rejected: %v", err)
	}
	emptyFolder, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{Name: "Archive me"})
	if err != nil {
		t.Fatal(err)
	}
	if err := repo.ArchiveFolder(ctx, accountA, emptyFolder.ID, 0); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("folder archive accepted missing expected_version: %v", err)
	}
	if err := repo.ArchiveFolder(ctx, accountA, emptyFolder.ID, emptyFolder.Version); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.RestoreFolder(ctx, accountA, emptyFolder.ID, 0); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("folder restore accepted missing expected_version: %v", err)
	}
	restoredFolder, err := repo.RestoreFolder(ctx, accountA, emptyFolder.ID, emptyFolder.Version+1)
	if err != nil || restoredFolder.Version != emptyFolder.Version+2 {
		t.Fatalf("folder restore did not preserve optimistic version: %#v %v", restoredFolder, err)
	}

	placementRootA, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{Name: "Placement A", SortOrder: whiteboardInt64Pointer(1)})
	if err != nil {
		t.Fatal(err)
	}
	placementRootB, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{Name: "Placement B", SortOrder: whiteboardInt64Pointer(2)})
	if err != nil {
		t.Fatal(err)
	}
	placementChild, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{ParentID: &placementRootA.ID, Name: "Placement child"})
	if err != nil {
		t.Fatal(err)
	}
	placementResult, err := repo.UpdateFolder(ctx, accountA, creator, placementChild.ID, repository.WhiteboardFolderInput{
		Name: placementChild.Name, Description: placementChild.Description, ExpectedVersion: placementChild.Version,
		Placement: &repository.WhiteboardFolderPlacement{BeforeFolderID: &placementRootB.ID},
	})
	if err != nil {
		t.Fatalf("move child to account root before sibling: %v", err)
	}
	canonicalPlacementRootB := placementRootB
	for _, affectedFolder := range placementResult.AffectedFolders {
		if affectedFolder.ID == placementRootB.ID {
			canonicalPlacementRootB = affectedFolder
		}
	}
	if placementResult.Folder.ParentID != nil || !(placementResult.Folder.SortOrder < canonicalPlacementRootB.SortOrder) {
		t.Fatalf("child did not leave its parent at the requested root position: %#v", placementResult.Folder)
	}
	foreignRoot, err := repo.CreateFolder(ctx, accountB, foreign, repository.WhiteboardFolderInput{Name: "Foreign placement"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpdateFolder(ctx, accountA, creator, placementResult.Folder.ID, repository.WhiteboardFolderInput{
		Name: placementResult.Folder.Name, ExpectedVersion: placementResult.Folder.Version,
		Placement: &repository.WhiteboardFolderPlacement{BeforeFolderID: &foreignRoot.ID},
	}); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("cross-account placement anchor was accepted: %v", err)
	}

	gapTarget, err := repo.CreateFolder(ctx, accountA, creator, repository.WhiteboardFolderInput{Name: "Gap target", SortOrder: whiteboardInt64Pointer(10)})
	if err != nil {
		t.Fatal(err)
	}
	gapResult, err := repo.UpdateFolder(ctx, accountA, creator, gapTarget.ID, repository.WhiteboardFolderInput{
		Name: gapTarget.Name, ExpectedVersion: gapTarget.Version,
		Placement: &repository.WhiteboardFolderPlacement{BeforeFolderID: &placementRootB.ID},
	})
	if err != nil {
		t.Fatalf("rebalance exhausted folder order gap: %v", err)
	}
	if len(gapResult.AffectedFolders) < 3 {
		t.Fatalf("rebalance did not return every canonically affected sibling: %#v", gapResult.AffectedFolders)
	}

	sharedLibrary, err := repo.CreateLibrary(ctx, accountA, creator, repository.WhiteboardLibraryInput{
		Name: "Shared library", LibraryJSON: json.RawMessage(`{"libraryItems":[]}`), Visibility: domain.WhiteboardAccessAccount,
	})
	if err != nil {
		t.Fatal(err)
	}
	librarySummaries, _, err := repo.ListLibraries(ctx, accountA, creator, repository.WhiteboardLibraryListOptions{Limit: 200})
	if err != nil || len(librarySummaries) != 1 || len(librarySummaries[0].LibraryJSON) != 0 || librarySummaries[0].ItemCount != 0 || librarySummaries[0].ContentSizeBytes <= 0 {
		t.Fatalf("library collection did not return a bounded summary: %#v %v", librarySummaries, err)
	}
	libraryDetail, err := repo.GetLibrary(ctx, accountA, creator, sharedLibrary.ID)
	if err != nil || len(libraryDetail.LibraryJSON) == 0 {
		t.Fatalf("library detail omitted its canonical JSON: %#v %v", libraryDetail, err)
	}
	if _, err := repo.UpdateLibrary(ctx, accountA, viewer, sharedLibrary.ID, repository.WhiteboardLibraryInput{
		Name: sharedLibrary.Name, LibraryJSON: sharedLibrary.LibraryJSON, Visibility: domain.WhiteboardAccessAccount,
		ExpectedVersion: sharedLibrary.Version,
	}); !errors.Is(err, repository.ErrWhiteboardForbidden) {
		t.Fatalf("account member changed shared library content: %v", err)
	}
	libraryFileID := "library_image_1"
	libraryObjectKey := storage.PrivateObjectKey(accountA, "whiteboards", "libraries", sharedLibrary.ID.String(), "integration-"+libraryFileID+".png")
	libraryMedia, uploadRequired, err := repo.ReserveWhiteboardAsset(ctx, repository.MediaAssetUpsert{
		AccountID: accountA, ContentHash: domain.MediaAssetHashWhiteboardPrefix + "library:" + sharedLibrary.ID.String() + ":integration",
		ObjectKey: libraryObjectKey, MediaType: "image", ContentType: "image/png", Filename: "integration.png", SizeBytes: 68,
	})
	if err != nil || !uploadRequired {
		t.Fatalf("reserve library asset: %#v %v", libraryMedia, err)
	}
	libraryAsset, err := repo.AttachLibraryAsset(ctx, accountA, creator, sharedLibrary.ID, libraryMedia.ID, libraryFileID)
	if err != nil || libraryAsset.LibraryID == nil || *libraryAsset.LibraryID != sharedLibrary.ID || libraryAsset.CommittedAt != nil || libraryAsset.DraftExpiresAt == nil {
		t.Fatalf("library upload was not an account-scoped draft: %#v %v", libraryAsset, err)
	}
	viewerDrafts, _, err := repo.ListLibraryAssets(ctx, accountA, viewer, sharedLibrary.ID, repository.WhiteboardAssetListOptions{})
	if err != nil || len(viewerDrafts) != 0 {
		t.Fatalf("shared-library viewer observed unpublished drafts: %#v %v", viewerDrafts, err)
	}
	if _, err := repo.AttachLibraryAsset(ctx, accountB, foreign, sharedLibrary.ID, libraryMedia.ID, libraryFileID); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account library attachment was visible: %v", err)
	}
	libraryWithImage := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"id":"image-item","elements":[{"id":"image","type":"image","fileId":"library_image_1"}]}],"files":{"library_image_1":{"mimeType":"image/png"}}}`)
	sharedLibrary, err = repo.UpdateLibrary(ctx, accountA, creator, sharedLibrary.ID, repository.WhiteboardLibraryInput{
		Name: sharedLibrary.Name, LibraryJSON: libraryWithImage, Visibility: domain.WhiteboardAccessAccount,
		ExpectedVersion: sharedLibrary.Version,
	})
	if err != nil {
		t.Fatalf("promote referenced library draft: %v", err)
	}
	viewerAssets, _, err := repo.ListLibraryAssets(ctx, accountA, viewer, sharedLibrary.ID, repository.WhiteboardAssetListOptions{ReferencedOnly: true})
	if err != nil || len(viewerAssets) != 1 || viewerAssets[0].CommittedAt == nil {
		t.Fatalf("published library asset was not visible: %#v %v", viewerAssets, err)
	}
	if err := repo.DeleteLibraryAsset(ctx, accountA, creator, sharedLibrary.ID, libraryAsset.ID); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("live library image was deletable: %v", err)
	}
	sharedLibrary, err = repo.UpdateLibrary(ctx, accountA, creator, sharedLibrary.ID, repository.WhiteboardLibraryInput{
		Name: sharedLibrary.Name, LibraryJSON: json.RawMessage(`{"type":"excalidrawlib","libraryItems":[],"files":{}}`),
		Visibility: domain.WhiteboardAccessAccount, ExpectedVersion: sharedLibrary.Version,
	})
	if err != nil {
		t.Fatalf("remove committed library reference: %v", err)
	}
	ownerAssets, _, err := repo.ListLibraryAssets(ctx, accountA, creator, sharedLibrary.ID, repository.WhiteboardAssetListOptions{})
	if err != nil || len(ownerAssets) != 0 {
		t.Fatalf("unreferenced committed library asset survived reconciliation: %#v %v", ownerAssets, err)
	}
	libraryMedia, _, err = repo.ReserveWhiteboardAsset(ctx, repository.MediaAssetUpsert{
		AccountID: accountA, ContentHash: domain.MediaAssetHashWhiteboardPrefix + "library:" + sharedLibrary.ID.String() + ":integration",
		ObjectKey: libraryObjectKey, MediaType: "image", ContentType: "image/png", Filename: "integration.png", SizeBytes: 68,
	})
	if err != nil {
		t.Fatalf("reserve deduplicated library draft: %v", err)
	}
	libraryDraft, err := repo.AttachLibraryAsset(ctx, accountA, creator, sharedLibrary.ID, libraryMedia.ID, libraryFileID)
	if err != nil {
		t.Fatalf("reattach library draft: %v", err)
	}
	if err := repo.DeleteLibraryAsset(ctx, accountA, creator, sharedLibrary.ID, libraryDraft.ID); err != nil {
		t.Fatalf("unreferenced library draft could not be deleted: %v", err)
	}
	sharedLibrary, err = repo.UpdateLibrary(ctx, accountA, creator, sharedLibrary.ID, repository.WhiteboardLibraryInput{
		Name: sharedLibrary.Name, LibraryJSON: sharedLibrary.LibraryJSON, Visibility: domain.WhiteboardAccessPrivate,
		ExpectedVersion: sharedLibrary.Version,
	})
	if err != nil {
		t.Fatalf("library owner could not administer visibility: %v", err)
	}

	boardID, createOperation := uuid.New(), uuid.New()
	scene := json.RawMessage(`{"type":"excalidraw","elements":[],"appState":{},"files":{}}`)
	snapshotKey := storage.PrivateObjectKey(accountA, "whiteboards", boardID.String(), "revisions", createOperation.String()+".json.gz")
	if reserved, err := repo.ReserveRevisionSnapshot(ctx, accountA, snapshotKey, strings.Repeat("1", 64), 32); err != nil || !reserved {
		t.Fatal(err)
	}
	board, err := repo.CreateBoard(ctx, repository.WhiteboardCreateInput{
		ID: boardID, AccountID: accountA, ActorID: creator, Name: "Private board", Scene: scene,
		SceneSchemaVersion: "excalidraw", EditorVersion: "test", AccessMode: domain.WhiteboardAccessPrivate,
		OperationID: createOperation, RequestPayloadHash: strings.Repeat("2", 64), ResultSceneHash: strings.Repeat("2", 64), SnapshotObjectKey: snapshotKey,
		SnapshotContentHash: strings.Repeat("1", 64), SnapshotSizeBytes: 32,
	})
	if err != nil {
		t.Fatal(err)
	}
	if board.ID != boardID || board.SceneSequence != 0 {
		t.Fatalf("unexpected board: %#v", board)
	}
	if _, err := repo.RequireAccess(ctx, accountA, viewer, boardID, domain.WhiteboardAccessView); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("private board leaked before grant: %v", err)
	}
	if _, err := repo.GetBoard(ctx, accountB, foreign, boardID); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account board leaked: %v", err)
	}
	if _, _, err := repo.ListBoardActivity(ctx, accountB, foreign, boardID, repository.WhiteboardActivityListOptions{}); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account activity leaked: %v", err)
	}
	if _, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{{UserID: foreign, AccessLevel: domain.WhiteboardAccessView}}, board.AccessRevision, uuid.New()); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("cross-account grant was accepted: %v", err)
	}
	if _, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		nil, 0, uuid.New()); !errors.Is(err, repository.ErrWhiteboardInvalid) {
		t.Fatalf("ACL replacement accepted missing expected_access_revision: %v", err)
	}
	commentPolicy, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{
			{UserID: viewer, AccessLevel: domain.WhiteboardAccessComment},
			{UserID: observer, AccessLevel: domain.WhiteboardAccessView},
		}, board.AccessRevision, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if commentPolicy.AccessRevision != board.AccessRevision+1 {
		t.Fatalf("comment ACL revision did not advance: %#v", commentPolicy)
	}
	if access, err := repo.RequireAccess(ctx, accountA, viewer, boardID, domain.WhiteboardAccessComment); err != nil || !access.CanComment || access.CanEdit {
		t.Fatalf("comment-only grant did not preserve cumulative boundary: %#v %v", access, err)
	}
	if _, err := repo.RequireAccess(ctx, accountA, viewer, boardID, domain.WhiteboardAccessEdit); !errors.Is(err, repository.ErrWhiteboardForbidden) {
		t.Fatalf("comment-only member edited the scene: %v", err)
	}
	if _, err := repo.CreateWhiteboardCommentThread(ctx, accountA, observer, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: uuid.New(), AnchorX: 5, AnchorY: 5, Body: "No autorizado"}); !errors.Is(err, repository.ErrWhiteboardForbidden) {
		t.Fatalf("view-only member created a comment thread: %v", err)
	}
	threadOperation := uuid.New()
	thread, err := repo.CreateWhiteboardCommentThread(ctx, accountA, viewer, boardID, repository.WhiteboardCommentThreadCreateInput{
		OperationID: threadOperation, AnchorX: 10, AnchorY: 20, Body: "Primero 👀",
	})
	if err != nil || len(thread.Comments) != 1 {
		t.Fatalf("comment-only member could not create thread: %#v %v", thread, err)
	}
	replayedThread, err := repo.CreateWhiteboardCommentThread(ctx, accountA, viewer, boardID, repository.WhiteboardCommentThreadCreateInput{
		OperationID: threadOperation, AnchorX: 10, AnchorY: 20, Body: "Primero 👀",
	})
	if err != nil || replayedThread.ID != thread.ID || len(replayedThread.Comments) != 1 {
		t.Fatalf("thread operation replay duplicated content: %#v %v", replayedThread, err)
	}
	replyOperation := uuid.New()
	repliedThread, err := repo.AddWhiteboardCommentReply(ctx, accountA, viewer, boardID, thread.ID,
		repository.WhiteboardCommentReplyInput{OperationID: replyOperation, Body: "Respuesta"})
	if err != nil || len(repliedThread.Comments) != 2 {
		t.Fatalf("comment reply was not persisted: %#v %v", repliedThread, err)
	}
	for index := 0; index < 5; index++ {
		repliedThread, err = repo.AddWhiteboardCommentReply(ctx, accountA, viewer, boardID, thread.ID,
			repository.WhiteboardCommentReplyInput{OperationID: uuid.New(), Body: "Respuesta adicional " + strings.Repeat("x", index+1)})
		if err != nil {
			t.Fatalf("append bounded comment preview fixture %d: %v", index, err)
		}
	}
	previewThreads, _, err := repo.ListWhiteboardCommentThreads(ctx, accountA, viewer, boardID,
		repository.WhiteboardCommentThreadListOptions{Status: domain.WhiteboardCommentOpen, Limit: 200})
	if err != nil || len(previewThreads) != 1 || len(previewThreads[0].Comments) != 5 ||
		previewThreads[0].CommentCount != 7 || !previewThreads[0].CommentsHasMore {
		t.Fatalf("comment collection escaped bounded preview contract: %#v %v", previewThreads, err)
	}
	commentPage, commentPageMore, err := repo.ListWhiteboardThreadComments(ctx, accountA, viewer, boardID, thread.ID,
		repository.WhiteboardCommentListOptions{Limit: 3})
	if err != nil || len(commentPage) != 3 || !commentPageMore {
		t.Fatalf("thread comment pagination failed: %#v more=%v err=%v", commentPage, commentPageMore, err)
	}
	resolvedThread, err := repo.UpdateWhiteboardCommentThreadStatus(ctx, accountA, viewer, boardID, thread.ID,
		repository.WhiteboardCommentStatusInput{OperationID: uuid.New(), ExpectedVersion: repliedThread.Version, Status: domain.WhiteboardCommentResolved})
	if err != nil || resolvedThread.Status != domain.WhiteboardCommentResolved {
		t.Fatalf("comment thread was not resolved: %#v %v", resolvedThread, err)
	}
	replayedReply, err := repo.AddWhiteboardCommentReply(ctx, accountA, viewer, boardID, thread.ID,
		repository.WhiteboardCommentReplyInput{OperationID: replyOperation, Body: "Respuesta"})
	if err != nil || replayedReply.Status != domain.WhiteboardCommentResolved || len(replayedReply.Comments) != 7 {
		t.Fatalf("reply ACK retry revalidated resolved state or duplicated content: %#v %v", replayedReply, err)
	}
	firstOpenThread, err := repo.CreateWhiteboardCommentThread(ctx, accountA, viewer, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: uuid.New(), AnchorX: 30, AnchorY: 40, Body: "Abierto uno"})
	if err != nil {
		t.Fatalf("create first open thread for counts: %v", err)
	}
	elementID := "shape-marker"
	secondOpenThread, err := repo.CreateWhiteboardCommentThread(ctx, accountA, viewer, boardID,
		repository.WhiteboardCommentThreadCreateInput{OperationID: uuid.New(), ElementID: &elementID, AnchorX: 50, AnchorY: 60, Body: "Abierto dos"})
	if err != nil {
		t.Fatalf("create second open thread for markers: %v", err)
	}
	counts, err := repo.GetWhiteboardCommentThreadCounts(ctx, accountA, viewer, boardID)
	if err != nil || counts.Open != 2 || counts.Resolved != 1 || counts.All != 3 {
		t.Fatalf("canonical comment counts are wrong: %#v %v", counts, err)
	}
	for status, expected := range map[string]int{
		domain.WhiteboardCommentOpen: 2, domain.WhiteboardCommentResolved: 1, "all": 3,
	} {
		filtered, _, err := repo.ListWhiteboardCommentThreads(ctx, accountA, viewer, boardID,
			repository.WhiteboardCommentThreadListOptions{Status: status, Limit: 10})
		if err != nil || len(filtered) != expected {
			t.Fatalf("comment status %q was not applied: got=%d expected=%d err=%v", status, len(filtered), expected, err)
		}
		for _, filteredThread := range filtered {
			if status != "all" && filteredThread.Status != status {
				t.Fatalf("comment status %q leaked thread %s", status, filteredThread.Status)
			}
		}
	}
	firstMarkerPage, markerHasMore, err := repo.ListWhiteboardCommentMarkers(ctx, accountA, viewer, boardID,
		repository.WhiteboardCommentMarkerListOptions{Limit: 1})
	if err != nil || len(firstMarkerPage) != 1 || !markerHasMore || firstMarkerPage[0].CommentCount != 1 {
		t.Fatalf("first open marker page is invalid: %#v more=%v err=%v", firstMarkerPage, markerHasMore, err)
	}
	secondMarkerPage, markerHasMore, err := repo.ListWhiteboardCommentMarkers(ctx, accountA, viewer, boardID,
		repository.WhiteboardCommentMarkerListOptions{BeforeUpdatedAt: &firstMarkerPage[0].UpdatedAt, BeforeID: &firstMarkerPage[0].ID, Limit: 1})
	if err != nil || len(secondMarkerPage) != 1 || markerHasMore || secondMarkerPage[0].ID == firstMarkerPage[0].ID {
		t.Fatalf("second open marker page is invalid: %#v more=%v err=%v", secondMarkerPage, markerHasMore, err)
	}
	markerIDs := map[uuid.UUID]bool{firstMarkerPage[0].ID: true, secondMarkerPage[0].ID: true}
	if !markerIDs[firstOpenThread.ID] || !markerIDs[secondOpenThread.ID] || markerIDs[resolvedThread.ID] {
		t.Fatalf("marker collection did not contain exactly open threads: %#v", markerIDs)
	}
	detail, err := repo.GetWhiteboardCommentThread(ctx, accountA, viewer, boardID, secondOpenThread.ID)
	if err != nil || detail.ID != secondOpenThread.ID || len(detail.Comments) != 1 || detail.Comments[0].Body != "Abierto dos" {
		t.Fatalf("authorized comment thread detail failed: %#v %v", detail, err)
	}
	ownedComment := detail.Comments[0]
	if _, err := repo.EditWhiteboardComment(ctx, accountA, creator, boardID, detail.ID, ownedComment.ID,
		repository.WhiteboardCommentEditInput{OperationID: uuid.New(), ExpectedVersion: ownedComment.Version, Body: "Edición ajena"}); !errors.Is(err, repository.ErrWhiteboardForbidden) {
		t.Fatalf("another member edited a comment they do not own: %v", err)
	}
	if _, err := repo.EditWhiteboardComment(ctx, accountA, viewer, boardID, detail.ID, ownedComment.ID,
		repository.WhiteboardCommentEditInput{OperationID: uuid.New(), ExpectedVersion: ownedComment.Version + 1, Body: "Versión obsoleta"}); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("stale comment edit did not conflict: %v", err)
	}
	editedThread, err := repo.EditWhiteboardComment(ctx, accountA, viewer, boardID, detail.ID, ownedComment.ID,
		repository.WhiteboardCommentEditInput{OperationID: uuid.New(), ExpectedVersion: ownedComment.Version, Body: "Edición canónica"})
	if err != nil || len(editedThread.Comments) != 1 || editedThread.Comments[0].Body != "Edición canónica" || editedThread.Comments[0].Version != ownedComment.Version+1 {
		t.Fatalf("owned comment edit was not persisted: %#v %v", editedThread, err)
	}
	if _, err := repo.DeleteWhiteboardComment(ctx, accountA, viewer, boardID, detail.ID, ownedComment.ID,
		repository.WhiteboardCommentDeleteInput{OperationID: uuid.New(), ExpectedVersion: ownedComment.Version}); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("stale comment delete did not conflict: %v", err)
	}
	deletedThread, err := repo.DeleteWhiteboardComment(ctx, accountA, viewer, boardID, detail.ID, ownedComment.ID,
		repository.WhiteboardCommentDeleteInput{OperationID: uuid.New(), ExpectedVersion: editedThread.Comments[0].Version})
	if err != nil || len(deletedThread.Comments) != 1 || deletedThread.Comments[0].DeletedAt == nil || deletedThread.Comments[0].Body != "" {
		t.Fatalf("owned comment delete did not leave a traceable tombstone: %#v %v", deletedThread, err)
	}
	if _, err := repo.AddWhiteboardCommentReply(ctx, accountA, viewer, boardID, resolvedThread.ID,
		repository.WhiteboardCommentReplyInput{OperationID: uuid.New(), Body: "No debe entrar"}); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("new reply to resolved thread did not conflict: %v", err)
	}
	if _, err := repo.GetWhiteboardCommentThread(ctx, accountA, viewer, boardID, uuid.New()); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("missing comment thread did not return not found: %v", err)
	}
	if _, _, err := repo.ListWhiteboardCommentThreads(ctx, accountB, foreign, boardID, repository.WhiteboardCommentThreadListOptions{}); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account comment threads leaked: %v", err)
	}
	if _, _, err := repo.ListWhiteboardCommentMarkers(ctx, accountB, foreign, boardID, repository.WhiteboardCommentMarkerListOptions{}); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account comment markers leaked: %v", err)
	}
	if _, err := repo.GetWhiteboardCommentThreadCounts(ctx, accountB, foreign, boardID); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account comment counts leaked: %v", err)
	}
	if _, err := repo.GetWhiteboardCommentThread(ctx, accountB, foreign, boardID, secondOpenThread.ID); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account comment detail leaked: %v", err)
	}
	editPolicy, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{{UserID: viewer, AccessLevel: domain.WhiteboardAccessEdit}}, commentPolicy.AccessRevision, uuid.New())
	if err != nil {
		t.Fatal(err)
	}
	if editPolicy.AccessRevision != commentPolicy.AccessRevision+1 {
		t.Fatalf("edit ACL revision did not advance: %#v", editPolicy)
	}
	if _, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		nil, board.AccessRevision, uuid.New()); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("stale ACL replacement did not conflict: %v", err)
	}
	if _, err := repo.RequireAccess(ctx, accountA, viewer, boardID, domain.WhiteboardAccessEdit); err != nil {
		t.Fatalf("same-account grant did not apply: %v", err)
	}

	importNow := time.Now().UTC()
	mainNavigationHash := strings.Repeat("9", 64)
	mainCallbackHash := strings.Repeat("a", 64)
	importItem, err := repo.StartWhiteboardLibraryImport(ctx, accountA, creator, boardID, sharedLibrary.ID,
		repository.WhiteboardLibraryImportStartInput{TokenHash: mainNavigationHash, ExpiresAt: importNow.Add(15 * time.Minute)})
	if err != nil {
		t.Fatalf("start public library import: %v", err)
	}
	if _, _, err := repo.ClaimWhiteboardLibraryImport(ctx, accountA, creator, mainCallbackHash, importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("callback was accepted before navigation rotated its secret: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountB, creator, boardID, importItem.ID,
		mainNavigationHash, mainCallbackHash, importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("another account rotated a library navigation token: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountA, creator, boardID, importItem.ID,
		mainNavigationHash, mainCallbackHash, importNow); err != nil {
		t.Fatalf("rotate public library navigation token: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountA, creator, boardID, importItem.ID,
		mainNavigationHash, strings.Repeat("f", 64), importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("replayed public library navigation token: %v", err)
	}
	if _, _, err := repo.ClaimWhiteboardLibraryImport(ctx, accountB, creator, mainCallbackHash, importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("same actor claimed another account's library import: %v", err)
	}
	claimedImport, idempotentClaim, err := repo.ClaimWhiteboardLibraryImport(ctx, accountA, creator, mainCallbackHash, importNow)
	if err != nil || idempotentClaim || claimedImport.ID != importItem.ID {
		t.Fatalf("claim public library import: %#v %v", claimedImport, err)
	}
	importedLibraryJSON := json.RawMessage(`{"type":"excalidrawlib","libraryItems":[{"id":"catalog-item","status":"published","created":1,"elements":[{"id":"catalog-rect","type":"rectangle","version":1,"versionNonce":2}]}],"source":"clarin"}`)
	if _, err := repo.MarkWhiteboardLibraryImportReady(ctx, accountB, foreign, importItem.ID,
		"https://libraries.excalidraw.com/libraries/author/catalog.excalidrawlib", importedLibraryJSON); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("another account marked a library import ready: %v", err)
	}
	readyImport, err := repo.MarkWhiteboardLibraryImportReady(ctx, accountA, creator, importItem.ID,
		"https://libraries.excalidraw.com/libraries/author/catalog.excalidrawlib", importedLibraryJSON)
	if err != nil || readyImport.Status != domain.WhiteboardLibraryImportReady {
		t.Fatalf("validated library import was not ready: %#v %v", readyImport, err)
	}
	if _, err := repo.GetWhiteboardLibraryImport(ctx, accountB, foreign, boardID, importItem.ID, importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("cross-account library import leaked: %v", err)
	}
	completeOperation := uuid.New()
	if _, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID,
		completeOperation, sharedLibrary.Version, importNow); !errors.Is(err, repository.ErrWhiteboardLibraryImportNotPersisted) {
		t.Fatalf("library import ACK accepted content that was not persisted: %v", err)
	}
	var retainedStatus string
	var retainedPayload []byte
	if err := db.QueryRow(ctx, `SELECT status,library_json FROM whiteboard_library_import_sessions WHERE id=$1`, importItem.ID).
		Scan(&retainedStatus, &retainedPayload); err != nil {
		t.Fatal(err)
	}
	if retainedStatus != domain.WhiteboardLibraryImportReady || len(retainedPayload) == 0 {
		t.Fatalf("failed ACK consumed its payload: status=%s bytes=%d", retainedStatus, len(retainedPayload))
	}
	sharedLibrary, err = repo.UpdateLibrary(ctx, accountA, creator, sharedLibrary.ID, repository.WhiteboardLibraryInput{
		Name: sharedLibrary.Name, LibraryJSON: importedLibraryJSON, Visibility: domain.WhiteboardAccessPrivate,
		ExpectedVersion: sharedLibrary.Version,
	})
	if err != nil {
		t.Fatalf("persist imported public library items: %v", err)
	}
	if _, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID,
		completeOperation, sharedLibrary.Version-1, importNow); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("library import ACK accepted a divergent version: %v", err)
	}
	libraryLockTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := libraryLockTx.Exec(ctx, `SELECT id FROM whiteboard_libraries WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, sharedLibrary.ID); err != nil {
		_ = libraryLockTx.Rollback(ctx)
		t.Fatal(err)
	}
	blockedLibraryContext, cancelLibraryBlock := context.WithTimeout(ctx, 100*time.Millisecond)
	_, blockedLibraryErr := repo.CompleteWhiteboardLibraryImport(blockedLibraryContext, accountA, creator, boardID,
		importItem.ID, completeOperation, sharedLibrary.Version, importNow)
	cancelLibraryBlock()
	if !errors.Is(blockedLibraryErr, context.DeadlineExceeded) {
		_ = libraryLockTx.Rollback(ctx)
		t.Fatalf("library import ACK bypassed the canonical library lock: %v", blockedLibraryErr)
	}
	if err := libraryLockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	importLockTx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := importLockTx.Exec(ctx, `SELECT id FROM whiteboard_library_import_sessions
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountA, importItem.ID); err != nil {
		_ = importLockTx.Rollback(ctx)
		t.Fatal(err)
	}
	blockedImportContext, cancelImportBlock := context.WithTimeout(ctx, 100*time.Millisecond)
	_, blockedImportErr := repo.CompleteWhiteboardLibraryImport(blockedImportContext, accountA, creator, boardID,
		importItem.ID, completeOperation, sharedLibrary.Version, importNow)
	cancelImportBlock()
	if !errors.Is(blockedImportErr, context.DeadlineExceeded) {
		_ = importLockTx.Rollback(ctx)
		t.Fatalf("library import ACK bypassed the import-session lock: %v", blockedImportErr)
	}
	if err := importLockTx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	completedImport, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID, completeOperation, sharedLibrary.Version, importNow)
	if err != nil || completedImport.Status != domain.WhiteboardLibraryImportCompleted || len(completedImport.LibraryJSON) != 0 {
		t.Fatalf("library import completion retained payload or failed: %#v %v", completedImport, err)
	}
	if completedImport.CompletedLibraryVersion == nil || *completedImport.CompletedLibraryVersion != sharedLibrary.Version {
		t.Fatalf("library import completion omitted confirmed version: %#v", completedImport)
	}
	if replayedImport, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID, completeOperation, sharedLibrary.Version, importNow); err != nil || replayedImport.Status != domain.WhiteboardLibraryImportCompleted {
		t.Fatalf("library import completion was not idempotent: %#v %v", replayedImport, err)
	}
	if _, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID,
		completeOperation, sharedLibrary.Version+1, importNow); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("idempotent ACK accepted a divergent version: %v", err)
	}
	if _, err := repo.CompleteWhiteboardLibraryImport(ctx, accountA, creator, boardID, importItem.ID,
		uuid.New(), sharedLibrary.Version, importNow); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("completed import accepted another operation: %v", err)
	}

	revocableLibrary, err := repo.CreateLibrary(ctx, accountA, observer, repository.WhiteboardLibraryInput{
		Name: "Revocable personal library", LibraryJSON: json.RawMessage(`{"type":"excalidrawlib","libraryItems":[]}`),
		Visibility: domain.WhiteboardAccessPrivate,
	})
	if err != nil {
		t.Fatalf("create revocable personal library: %v", err)
	}
	callbackGrantPolicy, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{
			{UserID: viewer, AccessLevel: domain.WhiteboardAccessEdit},
			{UserID: observer, AccessLevel: domain.WhiteboardAccessView},
		}, editPolicy.AccessRevision, uuid.New())
	if err != nil {
		t.Fatalf("grant callback actor view access: %v", err)
	}
	pendingRevokedImport, err := repo.StartWhiteboardLibraryImport(ctx, accountA, observer, boardID, revocableLibrary.ID,
		repository.WhiteboardLibraryImportStartInput{TokenHash: strings.Repeat("6", 64), ExpiresAt: importNow.Add(15 * time.Minute)})
	if err != nil {
		t.Fatalf("start import before callback revocation: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountA, observer, boardID, pendingRevokedImport.ID,
		strings.Repeat("6", 64), strings.Repeat("b", 64), importNow); err != nil {
		t.Fatalf("navigate import before callback revocation: %v", err)
	}
	callbackRevokedPolicy, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{{UserID: viewer, AccessLevel: domain.WhiteboardAccessEdit}},
		callbackGrantPolicy.AccessRevision, uuid.New())
	if err != nil {
		t.Fatalf("revoke callback actor before claim: %v", err)
	}
	if _, _, err := repo.ClaimWhiteboardLibraryImport(ctx, accountA, observer, strings.Repeat("b", 64), importNow); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("revoked actor claimed a pending public-library callback: %v", err)
	}
	var pendingRevokedStatus string
	if err := db.QueryRow(ctx, `SELECT status FROM whiteboard_library_import_sessions WHERE account_id=$1 AND id=$2`,
		accountA, pendingRevokedImport.ID).Scan(&pendingRevokedStatus); err != nil {
		t.Fatal(err)
	}
	if pendingRevokedStatus != domain.WhiteboardLibraryImportPending {
		t.Fatalf("denied callback consumed its token: status=%s", pendingRevokedStatus)
	}

	fetchGrantPolicy, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{
			{UserID: viewer, AccessLevel: domain.WhiteboardAccessEdit},
			{UserID: observer, AccessLevel: domain.WhiteboardAccessView},
		}, callbackRevokedPolicy.AccessRevision, uuid.New())
	if err != nil {
		t.Fatalf("restore callback actor view access: %v", err)
	}
	fetchRevokedImport, err := repo.StartWhiteboardLibraryImport(ctx, accountA, observer, boardID, revocableLibrary.ID,
		repository.WhiteboardLibraryImportStartInput{TokenHash: strings.Repeat("5", 64), ExpiresAt: importNow.Add(15 * time.Minute)})
	if err != nil {
		t.Fatalf("start import before in-flight revocation: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountA, observer, boardID, fetchRevokedImport.ID,
		strings.Repeat("5", 64), strings.Repeat("c", 64), importNow); err != nil {
		t.Fatalf("navigate import before in-flight revocation: %v", err)
	}
	if _, idempotent, err := repo.ClaimWhiteboardLibraryImport(ctx, accountA, observer, strings.Repeat("c", 64), importNow); err != nil || idempotent {
		t.Fatalf("claim import before in-flight revocation: idempotent=%v err=%v", idempotent, err)
	}
	if _, err := repo.ReplaceBoardAccess(ctx, accountA, creator, boardID, domain.WhiteboardAccessPrivate,
		[]repository.WhiteboardGrantInput{{UserID: viewer, AccessLevel: domain.WhiteboardAccessEdit}},
		fetchGrantPolicy.AccessRevision, uuid.New()); err != nil {
		t.Fatalf("revoke callback actor during fetch: %v", err)
	}
	if _, err := repo.MarkWhiteboardLibraryImportReady(ctx, accountA, observer, fetchRevokedImport.ID,
		"https://libraries.excalidraw.com/libraries/author/revoked.excalidrawlib", importedLibraryJSON); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("revoked in-flight callback persisted a validated payload: %v", err)
	}
	var fetchRevokedStatus string
	var fetchRevokedPayload []byte
	if err := db.QueryRow(ctx, `SELECT status,library_json FROM whiteboard_library_import_sessions
		WHERE account_id=$1 AND id=$2`, accountA, fetchRevokedImport.ID).Scan(&fetchRevokedStatus, &fetchRevokedPayload); err != nil {
		t.Fatal(err)
	}
	if fetchRevokedStatus != domain.WhiteboardLibraryImportFetching || len(fetchRevokedPayload) != 0 {
		t.Fatalf("revoked in-flight callback retained a payload: status=%s bytes=%d", fetchRevokedStatus, len(fetchRevokedPayload))
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_library_import_sessions(
		account_id,board_id,library_id,actor_id,token_hash,status,completion_operation_id,completed_at,expires_at
	) VALUES($1,$2,$3,$4,$5,'completed',$6,NOW(),$7)`, accountA, boardID, sharedLibrary.ID, creator,
		strings.Repeat("7", 64), uuid.New(), importNow.Add(15*time.Minute)); err == nil {
		t.Fatal("database accepted a completed library import without a confirmed version")
	}
	expiredImport, err := repo.StartWhiteboardLibraryImport(ctx, accountA, creator, boardID, sharedLibrary.ID,
		repository.WhiteboardLibraryImportStartInput{TokenHash: strings.Repeat("8", 64), ExpiresAt: importNow.Add(15 * time.Minute)})
	if err != nil {
		t.Fatalf("start expiring public library import: %v", err)
	}
	if err := repo.RotateWhiteboardLibraryImportNavigation(ctx, accountA, creator, boardID, expiredImport.ID,
		strings.Repeat("8", 64), strings.Repeat("d", 64), importNow); err != nil {
		t.Fatalf("navigate expiring public library import: %v", err)
	}
	if _, _, err := repo.ClaimWhiteboardLibraryImport(ctx, accountA, creator, strings.Repeat("d", 64), importNow); err != nil {
		t.Fatalf("claim expiring public library import: %v", err)
	}
	if _, err := repo.MarkWhiteboardLibraryImportReady(ctx, accountA, creator, expiredImport.ID,
		"https://libraries.excalidraw.com/libraries/author/expired.excalidrawlib", json.RawMessage(`{"type":"excalidrawlib","libraryItems":[]}`)); err != nil {
		t.Fatalf("ready expiring public library import: %v", err)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboard_library_import_sessions SET expires_at=$1 WHERE id=$2`, importNow.Add(-time.Minute), expiredImport.ID); err != nil {
		t.Fatal(err)
	}
	if cleared, err := repo.ExpireWhiteboardLibraryImports(ctx, importNow, 10); err != nil || cleared != 1 {
		t.Fatalf("expired public library payload cleanup=%d: %v", cleared, err)
	}
	var expiredStatus string
	var expiredPayload []byte
	if err := db.QueryRow(ctx, `SELECT status,library_json FROM whiteboard_library_import_sessions WHERE id=$1`, expiredImport.ID).Scan(&expiredStatus, &expiredPayload); err != nil {
		t.Fatal(err)
	}
	if expiredStatus != domain.WhiteboardLibraryImportFailed || len(expiredPayload) != 0 {
		t.Fatalf("expired public library payload survived cleanup: status=%s bytes=%d", expiredStatus, len(expiredPayload))
	}

	patchOperation := uuid.New()
	patchInput := repository.WhiteboardSceneWriteInput{
		ExpectedSequence: 0, OperationID: patchOperation,
		Scene: json.RawMessage(`{"type":"excalidraw","elements":[{"id":"one"}],"appState":{},"files":{}}`),
		Patch: json.RawMessage(`{"elements":[{"id":"one"}]}`), SceneSchemaVersion: "excalidraw",
		EditorVersion: "test", ResultSceneHash: strings.Repeat("3", 64),
	}
	result, err := repo.ApplyScenePatch(ctx, accountA, viewer, boardID, patchInput)
	if err != nil || result.Scene.Sequence != 1 || result.Revision != nil {
		t.Fatalf("patch did not advance without revision: %#v %v", result, err)
	}
	replayed, err := repo.ApplyScenePatch(ctx, accountA, viewer, boardID, patchInput)
	if err != nil || !replayed.Idempotent || replayed.Scene.Sequence != 1 {
		t.Fatalf("operation replay was not idempotent: %#v %v", replayed, err)
	}
	activities, _, err := repo.ListBoardActivity(ctx, accountA, viewer, boardID, repository.WhiteboardActivityListOptions{Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	patchActivityCount := 0
	for _, activity := range activities {
		if activity.OperationID != nil && *activity.OperationID == patchOperation && activity.Action == repository.WhiteboardActivityScenePatched {
			patchActivityCount++
		}
		if strings.Contains(string(activity.Details), strings.Repeat("4", 64)) || strings.Contains(string(activity.Details), strings.Repeat("5", 64)) {
			t.Fatalf("activity exposed a share/session token: %s", activity.Details)
		}
	}
	if patchActivityCount != 1 {
		t.Fatalf("idempotent scene patch produced %d activity rows", patchActivityCount)
	}
	patchInput.OperationID = uuid.New()
	if _, err := repo.ApplyScenePatch(ctx, accountA, viewer, boardID, patchInput); !errors.Is(err, repository.ErrWhiteboardConflict) {
		t.Fatalf("stale sequence did not conflict: %v", err)
	}

	link, err := repo.CreateShareLink(ctx, accountA, creator, boardID, repository.WhiteboardShareLinkInput{
		AccessLevel: domain.WhiteboardAccessEdit, TokenHash: strings.Repeat("4", 64), AllowExport: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	guestSession, err := repo.CreateGuestSession(ctx, repository.WhiteboardGuestSessionInput{
		LinkID: link.ID, TokenHash: strings.Repeat("5", 64), DisplayName: "Guest",
		ExpiresAt: now.Add(time.Hour), Now: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if guestSession.BoardID != boardID {
		t.Fatalf("guest session moved boards: %#v", guestSession)
	}
	// A guest may hydrate only committed assets still referenced by the current
	// canonical scene. Knowing an old link UUID must not retain access after an
	// element is removed, and a referenced upload draft is not yet public data.
	liveMediaID, removedMediaID, draftMediaID := uuid.New(), uuid.New(), uuid.New()
	liveLinkID, removedLinkID, draftLinkID := uuid.New(), uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,filename,content_type,status)
		VALUES($1,$4,$5,$6,'live.png','image/png','active'),
		      ($2,$4,$7,$8,'removed.png','image/png','active'),
		      ($3,$4,$9,$10,'draft.png','image/png','active')`,
		liveMediaID, removedMediaID, draftMediaID, accountA,
		domain.MediaAssetHashWhiteboardPrefix+strings.Repeat("d", 64), accountA.String()+"/_private/whiteboards/live.png",
		domain.MediaAssetHashWhiteboardPrefix+strings.Repeat("e", 64), accountA.String()+"/_private/whiteboards/removed.png",
		domain.MediaAssetHashWhiteboardPrefix+strings.Repeat("f", 64), accountA.String()+"/_private/whiteboards/draft.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at
	) VALUES($1,$7,$8,$4,'guest-live','asset',$9,NOW(),NULL),
	         ($2,$7,$8,$5,'guest-removed','asset',$9,NOW(),NULL),
	         ($3,$7,$8,$6,'guest-draft','asset',$9,NULL,NOW()+INTERVAL '1 hour')`,
		liveLinkID, removedLinkID, draftLinkID, liveMediaID, removedMediaID, draftMediaID, accountA, boardID, creator); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboards SET scene_json=$3::jsonb WHERE account_id=$1 AND id=$2`, accountA, boardID,
		json.RawMessage(`{"type":"excalidraw","elements":[{"id":"live","type":"image","fileId":"guest-live"},{"id":"draft","type":"image","fileId":"guest-draft"}],"appState":{},"files":{}}`)); err != nil {
		t.Fatal(err)
	}
	if asset, err := repo.ResolveBoardAssetDownloadAsGuest(ctx, strings.Repeat("5", 64), liveLinkID, now); err != nil || asset.Filename != "live.png" {
		t.Fatalf("guest could not download canonical committed asset: %#v %v", asset, err)
	}
	for label, linkID := range map[string]uuid.UUID{"removed": removedLinkID, "draft": draftLinkID} {
		if _, err := repo.ResolveBoardAssetDownloadAsGuest(ctx, strings.Repeat("5", 64), linkID, now); !errors.Is(err, repository.ErrWhiteboardNotFound) {
			t.Fatalf("guest downloaded %s asset outside canonical committed scene: %v", label, err)
		}
	}
	siblingBoardID, mediaAssetID := uuid.New(), uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboards(id,account_id,name,scene_json,created_by,updated_by)
		VALUES($1,$2,'Sibling board','{}'::jsonb,$3,$3)`, siblingBoardID, accountA, creator); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,status)
		VALUES($1,$2,$3,$4,'active')`, mediaAssetID, accountA, "sha256:whiteboard:"+strings.Repeat("7", 64),
		accountA.String()+"/_private/whiteboards/test.png"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_assets(account_id,board_id,media_asset_id,file_id,uploaded_by,guest_session_id,committed_at)
		VALUES($1,$2,$3,'cross-board',$4,$5,NOW())`, accountA, siblingBoardID, mediaAssetID, creator, guestSession.ID); err == nil {
		t.Fatal("guest session from a sibling board was accepted as asset provenance")
	}
	guestPatch := patchInput
	guestPatch.ExpectedSequence = 1
	guestPatch.OperationID = uuid.New()
	guestPatch.ResultSceneHash = strings.Repeat("6", 64)
	guestResult, err := repo.ApplyScenePatchAsGuest(ctx, strings.Repeat("5", 64), guestPatch, now)
	if err != nil || guestResult.Scene.Sequence != 2 {
		t.Fatalf("editable guest could not patch: %#v %v", guestResult, err)
	}
	var removedAssetInventory, removedAssetGCJobs int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 AND status='whiteboard_gc_pending'`, accountA,
		accountA.String()+"/_private/whiteboards/removed.png").Scan(&removedAssetInventory); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_media_gc_jobs
		WHERE account_id=$1 AND media_asset_id=$2`, accountA, removedMediaID).Scan(&removedAssetGCJobs); err != nil {
		t.Fatal(err)
	}
	if removedAssetInventory != 1 || removedAssetGCJobs != 1 {
		t.Fatalf("legacy asset GC inventory was not backfilled: inventory=%d jobs=%d", removedAssetInventory, removedAssetGCJobs)
	}
	if err := repo.RevokeGuestSession(ctx, accountA, creator, boardID, guestSession.ID); err != nil {
		t.Fatal(err)
	}
	guestPatch.ExpectedSequence = 2
	guestPatch.OperationID = uuid.New()
	if _, err := repo.ApplyScenePatchAsGuest(ctx, strings.Repeat("5", 64), guestPatch, now); !errors.Is(err, repository.ErrWhiteboardSessionUnavailable) {
		t.Fatalf("revoked guest still wrote: %v", err)
	}
	activities, _, err = repo.ListBoardActivity(ctx, accountA, creator, boardID, repository.WhiteboardActivityListOptions{Limit: 200})
	if err != nil {
		t.Fatal(err)
	}
	seenGuestJoin, seenGuestPatch, seenGuestRevoke := false, false, false
	for _, activity := range activities {
		seenGuestJoin = seenGuestJoin || activity.Action == repository.WhiteboardActivityGuestJoined
		seenGuestPatch = seenGuestPatch || (activity.Action == repository.WhiteboardActivityScenePatched && activity.GuestSessionID != nil)
		seenGuestRevoke = seenGuestRevoke || activity.Action == repository.WhiteboardActivityGuestRevoked
		if strings.Contains(string(activity.Details), strings.Repeat("4", 64)) || strings.Contains(string(activity.Details), strings.Repeat("5", 64)) {
			t.Fatalf("activity exposed a share/session token: %s", activity.Details)
		}
	}
	if !seenGuestJoin || !seenGuestPatch || !seenGuestRevoke {
		t.Fatalf("guest lifecycle activity incomplete: join=%v patch=%v revoke=%v", seenGuestJoin, seenGuestPatch, seenGuestRevoke)
	}

	// Duplication is one private transaction: it owns fresh history and ACL and
	// never inherits the source's direct viewer grant or public share link.
	sourceScene, err := repo.GetScene(ctx, accountA, creator, boardID, domain.WhiteboardAccessView)
	if err != nil {
		t.Fatal(err)
	}
	duplicateID, duplicateOperation := uuid.New(), uuid.New()
	duplicateSnapshotKey := storage.PrivateObjectKey(accountA, "whiteboards", duplicateID.String(), "revisions", duplicateOperation.String()+".json.gz")
	if reserved, err := repo.ReserveRevisionSnapshot(ctx, accountA, duplicateSnapshotKey, strings.Repeat("9", 64), 32); err != nil || !reserved {
		t.Fatalf("reserve duplicate snapshot: reserved=%v err=%v", reserved, err)
	}
	duplicated, err := repo.DuplicateBoard(ctx, repository.WhiteboardDuplicateInput{
		ID: duplicateID, AccountID: accountA, ActorID: creator, SourceBoardID: boardID,
		Name: "Private board (copia)", Description: "copy", Scene: sourceScene.Scene,
		SceneSchemaVersion: sourceScene.SceneSchemaVersion, EditorVersion: sourceScene.EditorVersion,
		OperationID: duplicateOperation, RequestPayloadHash: strings.Repeat("a", 64), ResultSceneHash: strings.Repeat("b", 64),
		SnapshotObjectKey: duplicateSnapshotKey, SnapshotContentHash: strings.Repeat("9", 64), SnapshotSizeBytes: 32,
	})
	if err != nil || duplicated.AccessMode != domain.WhiteboardAccessPrivate || duplicated.SceneSequence != 0 {
		t.Fatalf("atomic duplicate failed: %#v %v", duplicated, err)
	}
	if _, err := repo.RequireAccess(ctx, accountA, viewer, duplicateID, domain.WhiteboardAccessView); !errors.Is(err, repository.ErrWhiteboardNotFound) {
		t.Fatalf("duplicate inherited source grant: %v", err)
	}
	var duplicateGrants, duplicateShares, duplicateRevisions int
	if err := db.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM whiteboard_grants WHERE account_id=$1 AND board_id=$2),
		(SELECT COUNT(*) FROM whiteboard_share_links WHERE account_id=$1 AND board_id=$2),
		(SELECT COUNT(*) FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2)`, accountA, duplicateID).
		Scan(&duplicateGrants, &duplicateShares, &duplicateRevisions); err != nil {
		t.Fatal(err)
	}
	if duplicateGrants != 1 || duplicateShares != 0 || duplicateRevisions != 1 {
		t.Fatalf("duplicate inherited collaboration state: grants=%d shares=%d revisions=%d", duplicateGrants, duplicateShares, duplicateRevisions)
	}

	// A stale upload-cleanup job must never delete a snapshot that gained an
	// immutable revision before the worker prepared physical deletion.
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_snapshot_gc_jobs(account_id,object_key,available_at)
		VALUES($1,$2,NOW())`, accountA, snapshotKey); err != nil {
		t.Fatal(err)
	}
	referencedSnapshotJob, err := repo.ClaimWhiteboardSnapshotGCJob(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if prepared, err := repo.PrepareWhiteboardSnapshotGCDeletion(ctx, referencedSnapshotJob); err != nil || prepared {
		t.Fatalf("referenced snapshot prepared for deletion: prepared=%v err=%v", prepared, err)
	}
	if err := repo.CompleteWhiteboardSnapshotGCJob(ctx, referencedSnapshotJob, false); err != nil {
		t.Fatal(err)
	}

	// Expired automatic revisions disappear transactionally and their snapshot
	// becomes a durable, retryable GC job. Manual/system history is unaffected.
	expiredSnapshotKey := storage.PrivateObjectKey(accountA, "whiteboards", boardID.String(), "revisions", uuid.NewString()+".json.gz")
	if _, err := db.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,size_bytes,source,status)
		VALUES($1,$2,'document',8,'whiteboard_revision','active')`, accountA, expiredSnapshotKey); err != nil {
		t.Fatal(err)
	}
	var nextRevisionNumber int64
	if err := db.QueryRow(ctx, `SELECT COALESCE(MAX(revision_number),0)+1 FROM whiteboard_revisions
		WHERE account_id=$1 AND board_id=$2`, accountA, boardID).Scan(&nextRevisionNumber); err != nil {
		t.Fatal(err)
	}
	expiredRevisionID := uuid.New()
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_revisions(
		id,account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,scene_schema_version,editor_version
	) VALUES($1,$2,$3,$4,2,$5,'snapshot','automatic',NOW()-INTERVAL '1 minute',$6,$7,8,'excalidraw','test')`,
		expiredRevisionID, accountA, boardID, nextRevisionNumber, uuid.New(), expiredSnapshotKey, strings.Repeat("8", 64)); err != nil {
		t.Fatal(err)
	}
	if count, err := repo.EnqueueExpiredWhiteboardRevisions(ctx, 50); err != nil || count != 1 {
		t.Fatalf("expired revision sweep: count=%d err=%v", count, err)
	}
	var expiredRevisionCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_revisions WHERE id=$1`, expiredRevisionID).Scan(&expiredRevisionCount); err != nil || expiredRevisionCount != 0 {
		t.Fatalf("expired revision survived: count=%d err=%v", expiredRevisionCount, err)
	}
	expiredSnapshotJob, err := repo.ClaimWhiteboardSnapshotGCJob(ctx)
	if err != nil || expiredSnapshotJob.ObjectKey != expiredSnapshotKey {
		t.Fatalf("claim expired snapshot: job=%#v err=%v", expiredSnapshotJob, err)
	}
	if prepared, err := repo.PrepareWhiteboardSnapshotGCDeletion(ctx, expiredSnapshotJob); err != nil || !prepared {
		t.Fatalf("orphan snapshot was not prepared: prepared=%v err=%v", prepared, err)
	}
	if _, err := repo.ReserveRevisionSnapshot(ctx, accountA, expiredSnapshotKey, strings.Repeat("8", 64), 8); !errors.Is(err, repository.ErrWhiteboardUploadInProgress) {
		t.Fatalf("snapshot was resurrected during physical deletion: %v", err)
	}
	if err := repo.RetryWhiteboardSnapshotGCJob(ctx, expiredSnapshotJob, errors.New("temporary object-store failure")); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboard_snapshot_gc_jobs SET available_at=NOW()
		WHERE account_id=$1 AND object_key=$2`, accountA, expiredSnapshotKey); err != nil {
		t.Fatal(err)
	}
	expiredSnapshotJob, err = repo.ClaimWhiteboardSnapshotGCJob(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if prepared, err := repo.PrepareWhiteboardSnapshotGCDeletion(ctx, expiredSnapshotJob); err != nil || !prepared {
		t.Fatalf("retried snapshot was not prepared: prepared=%v err=%v", prepared, err)
	}
	if err := repo.CompleteWhiteboardSnapshotGCJob(ctx, expiredSnapshotJob, true); err != nil {
		t.Fatal(err)
	}

	createGCAsset := func(hashCharacter string) (uuid.UUID, string) {
		t.Helper()
		assetID := uuid.New()
		objectKey := storage.PrivateObjectKey(accountA, "whiteboards", boardID.String(), "assets", assetID.String()+".png")
		if _, err := db.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,size_bytes,source,status)
			VALUES($1,$2,'image',8,'whiteboard_asset','active')`, accountA, objectKey); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO media_assets(id,account_id,content_hash,object_key,media_type,size_bytes,status)
			VALUES($1,$2,$3,$4,'image',8,'active')`, assetID, accountA,
			domain.MediaAssetHashWhiteboardPrefix+strings.Repeat(hashCharacter, 64), objectKey); err != nil {
			t.Fatal(err)
		}
		return assetID, objectKey
	}

	// Old uncommitted links are released, but a revision manifest remains a
	// first-class byte reference and prevents media collection.
	var systemRevisionID uuid.UUID
	if err := db.QueryRow(ctx, `SELECT id FROM whiteboard_revisions
		WHERE account_id=$1 AND board_id=$2 AND revision_kind='system' LIMIT 1`, accountA, boardID).Scan(&systemRevisionID); err != nil {
		t.Fatal(err)
	}
	historicalAssetID, _ := createGCAsset("a")
	orphanAssetID, orphanAssetKey := createGCAsset("b")
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_assets(
		account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at,created_at
	) VALUES($1,$2,$3,'historical-only','asset',$5,NULL,NOW()-INTERVAL '1 minute',NOW()-INTERVAL '2 hours'),
		      ($1,$2,$4,'orphan-only','asset',$5,NULL,NOW()-INTERVAL '1 minute',NOW()-INTERVAL '2 hours')`,
		accountA, boardID, historicalAssetID, orphanAssetID, creator); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_revision_assets(account_id,board_id,revision_id,media_asset_id,file_id)
		VALUES($1,$2,$3,$4,'historical-only')`, accountA, boardID, systemRevisionID, historicalAssetID); err != nil {
		t.Fatal(err)
	}
	if count, err := repo.EnqueueUnreferencedWhiteboardAssetLinks(ctx, 50); err != nil || count != 2 {
		t.Fatalf("abandoned asset sweep: count=%d err=%v", count, err)
	}
	var historicalJobCount, orphanJobCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_media_gc_jobs
		WHERE account_id=$1 AND media_asset_id=$2`, accountA, historicalAssetID).Scan(&historicalJobCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM whiteboard_media_gc_jobs
		WHERE account_id=$1 AND media_asset_id=$2`, accountA, orphanAssetID).Scan(&orphanJobCount); err != nil {
		t.Fatal(err)
	}
	if historicalJobCount != 0 || orphanJobCount != 1 {
		t.Fatalf("revision reference proof failed: historical_jobs=%d orphan_jobs=%d", historicalJobCount, orphanJobCount)
	}
	if _, err := db.Exec(ctx, `UPDATE whiteboard_media_gc_jobs SET available_at=NOW()
		WHERE account_id=$1 AND media_asset_id=$2`, accountA, orphanAssetID); err != nil {
		t.Fatal(err)
	}
	orphanMediaJob, err := repo.ClaimWhiteboardMediaGCJob(ctx)
	if err != nil || orphanMediaJob.ObjectKey != orphanAssetKey {
		t.Fatalf("claim orphan media: job=%#v err=%v", orphanMediaJob, err)
	}
	if prepared, err := repo.PrepareWhiteboardMediaGCDeletion(ctx, orphanMediaJob); err != nil || !prepared {
		t.Fatalf("orphan media was not prepared: prepared=%v err=%v", prepared, err)
	}
	if _, _, err := repo.ReserveWhiteboardAsset(ctx, repository.MediaAssetUpsert{
		AccountID: accountA, ContentHash: domain.MediaAssetHashWhiteboardPrefix + strings.Repeat("b", 64),
		ObjectKey: storage.PrivateObjectKey(accountA, "whiteboards", boardID.String(), "assets", "replacement.png"),
		MediaType: "image", ContentType: "image/png", Filename: "replacement.png", SizeBytes: 8,
	}); !errors.Is(err, repository.ErrWhiteboardUploadInProgress) {
		t.Fatalf("media was resurrected during physical deletion: %v", err)
	}
	if err := repo.CompleteWhiteboardMediaGCJob(ctx, orphanMediaJob, true); err != nil {
		t.Fatal(err)
	}

	// Reusing a pending content hash keeps its inventoried key and requires a
	// fresh upload; it must not abandon the former object without a GC owner.
	pendingAssetID, pendingAssetKey := createGCAsset("c")
	if _, err := db.Exec(ctx, `UPDATE media_assets SET status='whiteboard_gc_pending'
		WHERE account_id=$1 AND id=$2`, accountA, pendingAssetID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_gc_pending'
		WHERE account_id=$1 AND object_key=$2`, accountA, pendingAssetKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO whiteboard_media_gc_jobs(account_id,media_asset_id,object_key,available_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour')`, accountA, pendingAssetID, pendingAssetKey); err != nil {
		t.Fatal(err)
	}
	newPendingKey := storage.PrivateObjectKey(accountA, "whiteboards", boardID.String(), "assets", "new-pending.png")
	reusedAsset, uploadRequired, err := repo.ReserveWhiteboardAsset(ctx, repository.MediaAssetUpsert{
		AccountID: accountA, ContentHash: domain.MediaAssetHashWhiteboardPrefix + strings.Repeat("c", 64),
		ObjectKey: newPendingKey, MediaType: "image", ContentType: "image/png", Filename: "new-pending.png", SizeBytes: 8,
	})
	if err != nil || !uploadRequired || reusedAsset.ObjectKey != pendingAssetKey {
		t.Fatalf("pending object was not safely reused: asset=%#v upload=%v err=%v", reusedAsset, uploadRequired, err)
	}
	var abandonedNewKeyCount int
	if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM storage_objects WHERE account_id=$1 AND object_key=$2`,
		accountA, newPendingKey).Scan(&abandonedNewKeyCount); err != nil || abandonedNewKeyCount != 0 {
		t.Fatalf("pending reuse created an abandoned key: count=%d err=%v", abandonedNewKeyCount, err)
	}
}
