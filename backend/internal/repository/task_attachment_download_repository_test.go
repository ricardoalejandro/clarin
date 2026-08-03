package repository

import (
	"testing"

	"github.com/google/uuid"
)

func TestTaskAttachmentDownloadURLsAreTaskScoped(t *testing.T) {
	taskID, attachmentID := uuid.New(), uuid.New()
	if got, want := taskAttachmentDownloadURL(taskID, attachmentID), "/api/tasks/"+taskID.String()+"/attachments/"+attachmentID.String()+"/download"; got != want {
		t.Fatalf("original URL=%q, want %q", got, want)
	}
	if got, want := taskAttachmentPreviewDownloadURL(taskID, attachmentID), "/api/tasks/"+taskID.String()+"/attachments/"+attachmentID.String()+"/preview/download"; got != want {
		t.Fatalf("preview URL=%q, want %q", got, want)
	}
}
