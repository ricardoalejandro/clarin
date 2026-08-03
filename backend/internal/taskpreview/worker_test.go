package taskpreview

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/storage"
)

func TestPreviewObjectKeyUsesPrivateTaskNamespace(t *testing.T) {
	accountID, attachmentID := uuid.New(), uuid.New()
	key := previewObjectKey(accountID, attachmentID, "content-hash")
	want := accountID.String() + "/_private/tasks/previews/" + attachmentID.String() + "/content-hash.pdf"
	if key != want || !storage.IsProtectedTaskObjectKey(key) {
		t.Fatalf("preview key=%q, want protected %q", key, want)
	}
}
