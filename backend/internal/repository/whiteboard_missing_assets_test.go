package repository

import (
	"errors"
	"fmt"
	"testing"
)

func TestRequireWhiteboardSceneAssets(t *testing.T) {
	linked := map[string]bool{"already-uploaded": true}
	if err := requireWhiteboardSceneAssets([]string{"already-uploaded"}, func(id string) bool { return linked[id] }); err != nil {
		t.Fatal(err)
	}
	err := requireWhiteboardSceneAssets([]string{"already-uploaded", "new-image"}, func(id string) bool { return linked[id] })
	var missing *WhiteboardMissingAssetsError
	if !errors.As(err, &missing) || !errors.Is(err, ErrWhiteboardInvalid) || len(missing.FileIDs) != 1 || missing.FileIDs[0] != "new-image" {
		t.Fatalf("expected exact missing file IDs, got %#v", err)
	}
	// The error's log-safe message contains no client file identifiers.
	if missing.Error() != "whiteboard scene assets are missing" {
		t.Fatalf("unexpected error message: %s", missing.Error())
	}
}

func TestRequireWhiteboardSceneAssetsBoundsResponse(t *testing.T) {
	ids := make([]string, 1000)
	for index := range ids {
		ids[index] = fmt.Sprintf("file-%d", index)
	}
	err := requireWhiteboardSceneAssets(ids, func(string) bool { return false })
	var missing *WhiteboardMissingAssetsError
	if !errors.As(err, &missing) || len(missing.FileIDs) != 200 {
		t.Fatalf("expected bounded rejection, got %#v", err)
	}
}
