package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestWhiteboardReferencedAssetFilterUsesCanonicalLiveReferences(t *testing.T) {
	t.Parallel()
	scene := json.RawMessage(`{"type":"excalidraw","elements":[
		{"id":"one","fileId":"file-b"},
		{"id":"two","fileId":"file-a"},
		{"id":"duplicate","fileId":"file-b"},
		{"id":"deleted","fileId":"ignored","isDeleted":true}
	]}`)
	ids, err := whiteboardReferencedAssetFileIDs(scene, true, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 2 || ids[0] != "file-a" || ids[1] != "file-b" {
		t.Fatalf("unexpected canonical reference filter: %#v", ids)
	}
	all, err := whiteboardReferencedAssetFileIDs(nil, false, false)
	if err != nil || all != nil {
		t.Fatalf("unfiltered listing unexpectedly parsed a scene: %#v %v", all, err)
	}
}

func TestWhiteboardReferencedLibraryAssetFilterAndMalformedDocument(t *testing.T) {
	t.Parallel()
	library := json.RawMessage(`{"libraryItems":[{"elements":[{"id":"image","fileId":"library-file"}]}]}`)
	ids, err := whiteboardReferencedAssetFileIDs(library, true, true)
	if err != nil || len(ids) != 1 || ids[0] != "library-file" {
		t.Fatalf("unexpected library reference filter: %#v %v", ids, err)
	}
	if _, err := whiteboardReferencedAssetFileIDs(json.RawMessage(`{"elements":`), true, false); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("malformed canonical document was accepted: %v", err)
	}
}

func TestWhiteboardGuestAssetDownloadQueryRequiresCanonicalCommittedAsset(t *testing.T) {
	t.Parallel()
	for _, required := range []string{
		"link.kind='asset'",
		"link.committed_at IS NOT NULL",
		"jsonb_array_elements(",
		"jsonb_typeof(board.scene_json->'elements')='array'",
		"element->>'fileId'=link.file_id",
		"element->'isDeleted'",
	} {
		if !strings.Contains(whiteboardGuestAssetDownloadQuery, required) {
			t.Fatalf("guest asset query lost authorization predicate %q", required)
		}
	}
}

func TestWhiteboardAssetMutationsUseWorkParentViewBoardLockOrder(t *testing.T) {
	t.Parallel()
	assetSource := readRepositorySource(t, "whiteboard_asset_repository.go")
	attachStart := strings.Index(assetSource, "func (r *WhiteboardRepository) attachBoardAsset(")
	attachEnd := strings.Index(assetSource, "func (r *WhiteboardRepository) GetBoardAsset(")
	deleteStart := strings.Index(assetSource, "func (r *WhiteboardRepository) DeleteBoardAsset(")
	if attachStart < 0 || attachEnd <= attachStart || deleteStart < 0 {
		t.Fatal("whiteboard asset mutation bounds changed")
	}
	attach := assetSource[attachStart:attachEnd]
	attachLock := strings.Index(attach, "lockActiveWhiteboardMutationRowsTx(ctx, tx, accountID, boardID)")
	attachActorAuth := strings.Index(attach, "requireWhiteboardAccessTx(ctx, tx, accountID, *actorID")
	attachGuestAuth := strings.Index(attach, "resolveGuestSessionWith(ctx, tx, guestTokenHash")
	if attachLock < 0 || attachActorAuth < 0 || attachGuestAuth < 0 || attachLock > attachActorAuth || attachLock > attachGuestAuth {
		t.Fatal("asset attach must lock Work parent/view/board before actor or guest reauthorization")
	}
	if !strings.Contains(attach, "if workState != nil") || !strings.Contains(attach, "ErrWhiteboardSessionUnavailable") {
		t.Fatal("guest asset attach could regain authority over a Work-origin board")
	}

	delete := assetSource[deleteStart:]
	deleteLock := strings.Index(delete, "lockActiveWhiteboardMutationRowsTx(ctx, tx, accountID, boardID)")
	deleteScene := strings.Index(delete, "SELECT scene_json FROM whiteboards")
	deleteAuth := strings.Index(delete, "requireWhiteboardAccessTx(ctx, tx, accountID, actorID")
	if deleteLock < 0 || deleteScene < 0 || deleteAuth < 0 || !(deleteLock < deleteScene && deleteScene < deleteAuth) {
		t.Fatal("asset/thumbnail delete must lock Work parent/view/board before reading scene and reauthorizing")
	}

	lockSource := readRepositorySource(t, "whiteboard_work_lock_repository.go")
	parentIndex := strings.Index(lockSource, "lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, false, false)")
	boardIndex := strings.Index(lockSource, "SELECT id FROM whiteboards")
	if parentIndex < 0 || boardIndex < 0 || parentIndex > boardIndex {
		t.Fatal("common active mutation lock must preserve parent -> view -> board order")
	}
}
