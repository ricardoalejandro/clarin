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
