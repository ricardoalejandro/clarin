package repository

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestOfflineV5AttachmentPreparationRequiresAccountAndIntegrity(t *testing.T) {
	hash := strings.Repeat("ab", 32)
	storedHash := domain.MediaAssetHashTaskAttachmentPrefix + hash
	if offlineV5AttachmentContentHash(storedHash) != hash || !offlineV5AttachmentCanPrepare("account", "account/tasks/file", storedHash, "text/plain", 4) {
		t.Fatal("canonical task-prefixed media hash must emit the raw verified digest")
	}
	if !offlineV5AttachmentCanPrepare("account", "account/tasks/file", hash, "application/pdf", 100) {
		t.Fatal("valid account attachment rejected")
	}
	for _, value := range []struct {
		key, hash, kind string
		size            int64
	}{
		{"foreign/tasks/file", hash, "application/pdf", 100}, {"account/tasks/file", "missing", "application/pdf", 100},
		{"account/tasks/file", hash, "text/html", 100}, {"account/tasks/file", hash, "image/svg+xml", 100},
		{"account/tasks/file", hash, "application/pdf", 0}, {"account/tasks/file", hash, "application/pdf", 51 * 1024 * 1024},
	} {
		if offlineV5AttachmentCanPrepare("account", value.key, value.hash, value.kind, value.size) {
			t.Fatal("unsafe or unbounded attachment accepted")
		}
	}
}

func TestOfflineV5PreparedAttachmentQuotaIncludesOnlyVerifiedFiles(t *testing.T) {
	total, err := offlineV5PreparedAttachmentBytes(json.RawMessage(`{"attachments":[{"available_offline":true,"size_bytes":12},{"available_offline":false,"size_bytes":900000000},{"available_offline":true,"size_bytes":18}]}`))
	if err != nil || total != 30 {
		t.Fatalf("quota = %d, %v", total, err)
	}
	if _, err := offlineV5PreparedAttachmentBytes(json.RawMessage(`{"attachments":[{"available_offline":true,"size_bytes":-1}]}`)); err == nil {
		t.Fatal("invalid signed size accepted")
	}
}
