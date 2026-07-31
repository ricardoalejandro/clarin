package repository

import "testing"

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
