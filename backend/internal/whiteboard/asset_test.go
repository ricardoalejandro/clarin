package whiteboard

import (
	"encoding/base64"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestNormalizeAssetAndPrivateObjectKey(t *testing.T) {
	// 1x1 transparent PNG.
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	asset, err := NormalizeAsset("image/png", data)
	if err != nil {
		t.Fatal(err)
	}
	accountID, boardID := uuid.New(), uuid.New()
	key, err := AssetObjectKey(accountID, boardID, "file_123", asset)
	if err != nil {
		t.Fatal(err)
	}
	if !storage.IsPrivateObjectKey(key) || !strings.HasPrefix(key, accountID.String()+"/_private/whiteboards/"+boardID.String()+"/") {
		t.Fatalf("asset key is not account-private: %s", key)
	}
}

func TestLibraryAssetObjectKeyUsesDedicatedPrivateNamespace(t *testing.T) {
	data, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	asset, err := NormalizeAsset("image/png", data)
	if err != nil {
		t.Fatal(err)
	}
	accountID, libraryID := uuid.New(), uuid.New()
	key, err := LibraryAssetObjectKey(accountID, libraryID, "library_file", asset)
	if err != nil {
		t.Fatal(err)
	}
	expectedPrefix := accountID.String() + "/_private/whiteboards/libraries/" + libraryID.String() + "/"
	if !storage.IsAccountWhiteboardObjectKey(accountID, key) || !strings.HasPrefix(key, expectedPrefix) {
		t.Fatalf("library asset escaped its private namespace: %s", key)
	}
	if _, err := LibraryAssetObjectKey(accountID, libraryID, "../escape", asset); err == nil {
		t.Fatal("unsafe library file ID was accepted")
	}
}

func TestNormalizeAssetRejectsSVGAndTypeMismatch(t *testing.T) {
	if _, err := NormalizeAsset("image/svg+xml", []byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`)); err == nil {
		t.Fatal("executable SVG asset was accepted")
	}
	pngHeader := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	if _, err := NormalizeAsset("image/jpeg", pngHeader); err == nil {
		t.Fatal("claimed type mismatch was accepted")
	}
	if _, err := NormalizeAsset("image/png", pngHeader); err == nil {
		t.Fatal("corrupt raster payload was accepted from its signature alone")
	}
}

func TestNormalizeAssetRejectsOversizedDimensions(t *testing.T) {
	t.Parallel()
	// Minimal VP8X header declaring 16,385 x 1 pixels.
	data := []byte{
		'R', 'I', 'F', 'F', 22, 0, 0, 0, 'W', 'E', 'B', 'P',
		'V', 'P', '8', 'X', 10, 0, 0, 0,
		0, 0, 0, 0, 0x00, 0x40, 0x00, 0, 0, 0,
	}
	if _, err := NormalizeAsset("image/webp", data); err == nil {
		t.Fatal("oversized raster dimensions were accepted")
	}
}
