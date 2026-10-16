package repository

import (
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/naperu/clarin/internal/domain"
)

func offlineV5AttachmentContentHash(value string) string {
	return strings.TrimPrefix(value, domain.MediaAssetHashTaskAttachmentPrefix)
}

func offlineV5AttachmentCanPrepare(accountPrefix, objectKey, contentHash, contentType string, size int64) bool {
	hash, err := hex.DecodeString(offlineV5AttachmentContentHash(contentHash))
	if err != nil || len(hash) != 32 || size < 1 || size > 50*1024*1024 || !strings.HasPrefix(objectKey, accountPrefix+"/") {
		return false
	}
	switch strings.ToLower(contentType) {
	case "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "application/octet-stream", "application/zip",
		"application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		"application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation":
		return true
	}
	return false
}

func offlineV5PreparedAttachmentBytes(payload json.RawMessage) (int64, error) {
	var value struct {
		Attachments []struct {
			Available bool  `json:"available_offline"`
			Size      int64 `json:"size_bytes"`
		} `json:"attachments"`
	}
	if err := json.Unmarshal(payload, &value); err != nil {
		return 0, err
	}
	var total int64
	for _, item := range value.Attachments {
		if !item.Available {
			continue
		}
		if item.Size < 1 || item.Size > 50*1024*1024 || total > recordSafeInt64Max-item.Size {
			return 0, ErrOfflineV4QuotaExceeded
		}
		total += item.Size
	}
	return total, nil
}
