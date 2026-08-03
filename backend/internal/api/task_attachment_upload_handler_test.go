package api

import (
	"bytes"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/storage"
)

func TestTaskAttachmentObjectKeyUsesPrivateAccountNamespace(t *testing.T) {
	accountID := uuid.New()
	key := taskAttachmentObjectKey(accountID, "content-hash", "object-id", ".png")
	want := accountID.String() + "/_private/tasks/attachments/content-hash-object-id.png"
	if key != want || !storage.IsProtectedTaskObjectKey(key) {
		t.Fatalf("task attachment key=%q, want protected %q", key, want)
	}
}

func TestTaskAttachmentHashNamespaceIsFeatureIsolated(t *testing.T) {
	raw := "abc123"
	contentHash := domain.MediaAssetHashTaskAttachmentPrefix + raw
	if contentHash != "task:abc123" {
		t.Fatalf("task content hash=%q", contentHash)
	}
	accountID := uuid.New()
	if !storage.IsProtectedTaskObjectKey(taskAttachmentObjectKey(accountID, contentHash, "object", ".png")) {
		t.Fatal("task namespaced hash did not produce a protected object")
	}
}

func TestNormalizeTaskAttachment(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)
	tests := []struct {
		name     string
		filename string
		claimed  string
		data     []byte
		wantType string
		wantExt  string
		wantErr  bool
	}{
		{name: "detects png", filename: "captura.png", claimed: "image/png", data: png, wantType: "image/png", wantExt: ".png"},
		{name: "keeps text", filename: "notas.txt", claimed: "text/plain", data: []byte("observación válida"), wantType: "text/plain", wantExt: ".txt"},
		{name: "rejects fake image", filename: "falsa.png", claimed: "image/png", data: []byte("no es una imagen"), wantErr: true},
		{name: "rejects empty", filename: "vacío.txt", claimed: "text/plain", data: nil, wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := normalizeTaskAttachment(tt.filename, tt.claimed, tt.data)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %#v", got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.ContentType != tt.wantType || got.Extension != tt.wantExt {
				t.Fatalf("normalized=%#v", got)
			}
		})
	}
}

func TestTaskAttachmentUploadScopeKeepsCommentAndTaskCapabilitiesSeparate(t *testing.T) {
	t.Parallel()
	commentScope, commentRequired, err := taskAttachmentUploadScope("comment")
	if err != nil || commentScope != "comment_draft" || commentRequired != domain.TaskAccessComment {
		t.Fatalf("comment upload scope=%q required=%q err=%v", commentScope, commentRequired, err)
	}
	if repository.TaskAccessAllows(&domain.TaskEffectiveAccess{Level: domain.TaskAccessView}, commentRequired) {
		t.Fatal("view access unexpectedly allowed a comment attachment draft")
	}
	if !repository.TaskAccessAllows(&domain.TaskEffectiveAccess{Level: domain.TaskAccessComment}, commentRequired) {
		t.Fatal("comment access did not allow a comment attachment draft")
	}
	taskScope, taskRequired, err := taskAttachmentUploadScope("task")
	if err != nil || taskScope != "task" || taskRequired != domain.TaskAccessEdit {
		t.Fatalf("task upload scope=%q required=%q err=%v", taskScope, taskRequired, err)
	}
	if repository.TaskAccessAllows(&domain.TaskEffectiveAccess{Level: domain.TaskAccessComment}, taskRequired) {
		t.Fatal("comment access unexpectedly allowed an ordinary task attachment")
	}
	if _, _, err := taskAttachmentUploadScope("public"); err == nil {
		t.Fatal("unknown attachment context was accepted")
	}
}
