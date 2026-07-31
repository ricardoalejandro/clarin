package repository

import (
	"errors"
	"testing"
)

func TestClassifyTaskAttachmentPreview(t *testing.T) {
	tests := []struct {
		name, contentType, kind, status string
	}{
		{"photo.png", "image/png", "image", "ready"},
		{"report.pdf", "application/octet-stream", "pdf", "ready"},
		{"notes.txt", "", "text", "ready"},
		{"proposal.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "word_pdf", "pending"},
		{"archive.zip", "application/zip", "unsupported", "unsupported"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			kind, status := classifyTaskAttachmentPreview(test.name, test.contentType)
			if kind != test.kind || status != test.status {
				t.Fatalf("got %s/%s, want %s/%s", kind, status, test.kind, test.status)
			}
		})
	}
}

func TestShouldEnsureTaskAttachmentPreviewJobDoesNotRequeueActiveOrBackoffJobs(t *testing.T) {
	if !shouldEnsureTaskAttachmentPreviewJob("word_pdf", "pending") {
		t.Fatal("a pending Word preview must ensure its durable job exists")
	}
	for _, status := range []string{"processing", "ready", "failed"} {
		if shouldEnsureTaskAttachmentPreviewJob("word_pdf", status) {
			t.Fatalf("reading a %s Word preview must not requeue it", status)
		}
	}
	if shouldEnsureTaskAttachmentPreviewJob("pdf", "pending") {
		t.Fatal("direct PDFs never use the conversion queue")
	}
}

func TestTaskAttachmentPreviewRetryTransition(t *testing.T) {
	tests := []struct {
		kind, status string
		requeue      bool
		invalid      bool
	}{
		{kind: "word_pdf", status: "failed", requeue: true},
		{kind: "word_pdf", status: "pending"},
		{kind: "word_pdf", status: "processing"},
		{kind: "word_pdf", status: "ready"},
		{kind: "pdf", status: "failed", invalid: true},
		{kind: "word_pdf", status: "unsupported", invalid: true},
	}
	for _, test := range tests {
		t.Run(test.kind+"/"+test.status, func(t *testing.T) {
			requeue, err := taskAttachmentPreviewRetryTransition(test.kind, test.status)
			if requeue != test.requeue {
				t.Fatalf("got requeue=%v, want %v", requeue, test.requeue)
			}
			if errors.Is(err, ErrTaskAttachmentPreviewRetryInvalid) != test.invalid {
				t.Fatalf("got err=%v, invalid=%v", err, test.invalid)
			}
		})
	}
}
