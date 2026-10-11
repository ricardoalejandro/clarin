package repository

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

var storageWhiteboardSceneFixture = json.RawMessage(`{"type":"excalidraw","version":2,"futureRoot":{"keep":true},"elements":[
 {"id":"photo","type":"image","fileId":"file-a","index":"a0","version":2,"versionNonce":31,"isDeleted":false,"future":{"keep":"yes"}},
 {"id":"caption","type":"text","index":"a1","version":3,"versionNonce":32,"text":"Keep the notes"},
 {"id":"other","type":"image","fileId":"file-b","index":"a2","version":1,"versionNonce":33},
 {"id":"already-deleted","type":"image","fileId":"file-a","index":"a3","version":8,"versionNonce":34,"isDeleted":true}
 ],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}`)

func storageTestElements(t *testing.T, scene json.RawMessage) map[string]map[string]any {
	t.Helper()
	raw, err := storageWhiteboardElements(scene)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]map[string]any{}
	for _, element := range raw {
		var fields map[string]any
		if err := json.Unmarshal(element, &fields); err != nil {
			t.Fatal(err)
		}
		result[fields["id"].(string)] = fields
	}
	return result
}

func TestStorageWhiteboardRemovalPreservesOtherContentAndOpaqueFields(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	next, changes, patch, err := removeStorageWhiteboardElements(storageWhiteboardSceneFixture, "file-a", now)
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 1 || len(patch) != 1 || changes[0].ID != "photo" {
		t.Fatalf("removal touched unrelated/deleted elements: %#v", changes)
	}
	elements := storageTestElements(t, next)
	if elements["photo"]["isDeleted"] != true || elements["photo"]["version"] != float64(3) || elements["photo"]["updated"] != float64(now.UnixMilli()) {
		t.Fatalf("deletion did not advance canonical version: %v", elements["photo"])
	}
	if elements["caption"]["text"] != "Keep the notes" || elements["other"]["version"] != float64(1) || elements["already-deleted"]["version"] != float64(8) {
		t.Fatal("unrelated scene content changed")
	}
	if elements["photo"]["future"].(map[string]any)["keep"] != "yes" || !strings.Contains(string(next), `"futureRoot":{"keep":true}`) {
		t.Fatal("opaque fields were lost")
	}
	refs, err := whiteboardcore.ReferencedFileIDs(next)
	if err != nil || len(refs) != 1 || refs[0] != "file-b" {
		t.Fatalf("removed image remains live: %v %v", refs, err)
	}
}

func TestStorageWhiteboardRestorationKeepsLaterUnrelatedEdits(t *testing.T) {
	removed, changes, _, err := removeStorageWhiteboardElements(storageWhiteboardSceneFixture, "file-a", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	concurrent, _, err := whiteboardcore.MaterializeScenePatch(removed, []json.RawMessage{json.RawMessage(`{"id":"caption","type":"text","index":"a1","version":4,"versionNonce":90,"text":"New notes after removal"}`)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	restored, patch, err := restoreStorageWhiteboardElements(concurrent, changes, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(patch) != 1 {
		t.Fatalf("unexpected restoration patch: %d", len(patch))
	}
	elements := storageTestElements(t, restored)
	if elements["photo"]["isDeleted"] != false || elements["photo"]["version"] != float64(4) || elements["caption"]["text"] != "New notes after removal" {
		t.Fatalf("restore overwrote concurrent edits: %v", elements)
	}
}

func TestStorageWhiteboardRestorationRejectsChangedTarget(t *testing.T) {
	removed, changes, _, err := removeStorageWhiteboardElements(storageWhiteboardSceneFixture, "file-a", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, replacement := range []string{`{"id":"photo","type":"image","fileId":"file-a","index":"a0","version":4,"versionNonce":90,"isDeleted":true}`, `{"id":"photo","type":"image","fileId":"replacement-file","index":"a0","version":4,"versionNonce":90}`} {
		concurrent, _, err := whiteboardcore.MaterializeScenePatch(removed, []json.RawMessage{json.RawMessage(replacement)}, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := restoreStorageWhiteboardElements(concurrent, changes, time.Now()); !errors.Is(err, ErrWhiteboardConflict) {
			t.Fatalf("changed target should conflict: %v", err)
		}
	}
}

func TestStorageWhiteboardRestorationRejectsMissingTarget(t *testing.T) {
	_, changes, _, err := removeStorageWhiteboardElements(storageWhiteboardSceneFixture, "file-a", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := restoreStorageWhiteboardElements(json.RawMessage(`{"elements":[]}`), changes, time.Now()); !errors.Is(err, ErrWhiteboardConflict) {
		t.Fatalf("missing target should conflict: %v", err)
	}
}

func TestStorageWhiteboardRemovalSupportsDraftWithoutSceneMutation(t *testing.T) {
	next, changes, patch, err := removeStorageWhiteboardElements(storageWhiteboardSceneFixture, "unused-draft", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 0 || len(patch) != 0 || string(next) != string(storageWhiteboardSceneFixture) {
		t.Fatal("unused draft changed the canonical scene")
	}
}

func TestStorageWhiteboardRemovalRejectsInvalidElementVersion(t *testing.T) {
	for _, scene := range []string{`{"elements":[{"id":"a","fileId":"file-a","version":-1}]}`, `{"elements":[{"id":"a","fileId":"file-a","version":9007199254740991}]}`, `{"elements":[{"fileId":"file-a","version":1}]}`} {
		if _, _, _, err := removeStorageWhiteboardElements(json.RawMessage(scene), "file-a", time.Now()); !errors.Is(err, ErrWhiteboardInvalid) {
			t.Fatalf("invalid scene accepted: %s: %v", scene, err)
		}
	}
}

func TestStorageWorkRemovalFiltersEveryAttachmentSurface(t *testing.T) {
	for _, file := range []string{"task_attachment_download_repository.go", "task_attachment_preview_repository.go", "task_work_repository.go", "task_attachment_upload_repository.go", "task_repository.go", "offline_v5_snapshot_enrichment.go"} {
		if !strings.Contains(readRepositorySource(t, file), "storage_removed_at IS NULL") {
			t.Fatalf("%s lost hidden-removal filtering", file)
		}
	}
	for _, file := range []string{"task_trash_repository.go", "whiteboard_gc_repository.go"} {
		source := readRepositorySource(t, file)
		if !strings.Contains(source, "storage_removed_references") || !strings.Contains(source, "state IN ('removed','purging')") {
			t.Fatalf("%s can collect recoverable media", file)
		}
	}
}

func TestStorageWhiteboardRecoveryKeepsUnpublishedDraftPrivate(t *testing.T) {
	owner, other, board, link, asset := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	snapshot := storageWhiteboardRemovalSnapshot{LinkID: link, BoardID: board, AssetID: asset, UploadedBy: &owner}
	backup, _ := json.Marshal(snapshot)
	if err := AuthorizeWhiteboardStorageRemovalRecovery(owner, link, board, backup); err != nil {
		t.Fatalf("draft owner denied: %v", err)
	}
	if err := AuthorizeWhiteboardStorageRemovalRecovery(other, link, board, backup); !errors.Is(err, ErrWhiteboardForbidden) {
		t.Fatalf("another board member could read unpublished draft: %v", err)
	}
	committed := time.Now()
	snapshot.CommittedAt = &committed
	backup, _ = json.Marshal(snapshot)
	if err := AuthorizeWhiteboardStorageRemovalRecovery(other, link, board, backup); err != nil {
		t.Fatalf("committed image cannot be recovered by authorized editor: %v", err)
	}
	if err := AuthorizeWhiteboardStorageRemovalRecovery(owner, uuid.New(), board, backup); !errors.Is(err, ErrWhiteboardInvalid) {
		t.Fatalf("different source identity accepted: %v", err)
	}
}
