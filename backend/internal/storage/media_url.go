package storage

import (
	"net/url"
	"strings"

	"github.com/google/uuid"
)

// OrdinaryObjectKeyFromURL recognizes only the configured S3 origins/bucket.
// Matching a bucket substring in an unrelated URL must never make it trusted.
func (s *Storage) OrdinaryObjectKeyFromURL(raw string) (string, bool) {
	candidate, err := url.Parse(raw)
	if err != nil || candidate.User != nil || !candidate.IsAbs() || candidate.Opaque != "" {
		return "", false
	}
	for _, rawBase := range []string{s.publicURL, s.internalURL} {
		base, err := url.Parse(rawBase)
		if err != nil || !base.IsAbs() || !strings.EqualFold(base.Scheme, candidate.Scheme) || !strings.EqualFold(base.Host, candidate.Host) {
			continue
		}
		prefix := strings.TrimRight(base.Path, "/") + "/" + s.bucket + "/"
		if strings.HasPrefix(candidate.Path, prefix) {
			return strings.TrimPrefix(candidate.Path, prefix), true
		}
	}
	return "", false
}

// CanonicalMediaURL upgrades legacy S3 URLs without changing persisted data.
// Protected resources keep their dedicated authorized endpoints.
func (s *Storage) CanonicalMediaURL(raw string) string {
	key, stored := s.OrdinaryObjectKeyFromURL(raw)
	if !stored || IsProtectedMediaObjectKey(key) || strings.ContainsAny(key, "\\\x00\r\n") {
		return raw
	}
	parts := strings.Split(key, "/")
	if len(parts) < 2 {
		return raw
	}
	accountID, err := uuid.Parse(parts[0])
	if err != nil || accountID == uuid.Nil || parts[0] != accountID.String() {
		return raw
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return raw
		}
	}
	return "/api/media/file/" + strings.ReplaceAll(url.PathEscape(key), "%2F", "/")
}
