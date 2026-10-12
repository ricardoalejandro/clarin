package api

import (
	"bytes"
	"encoding/json"
)

// Older empty list cache entries used JSON null. Preserve the array contract
// during a rolling deployment, and bypass malformed cache entries.
func canonicalProgramListCache(cached []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(cached)
	if bytes.Equal(trimmed, []byte("null")) {
		return []byte("[]"), true
	}
	if len(trimmed) > 0 && trimmed[0] == '[' && json.Valid(trimmed) {
		return cached, true
	}
	return nil, false
}
