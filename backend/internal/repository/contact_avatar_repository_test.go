package repository

import (
	"strings"
	"testing"
)

func TestContactAvatarUpdateSQLPinsReusedSourceParameterType(t *testing.T) {
	const typedSource = "$4::VARCHAR(20)"
	if occurrences := strings.Count(contactAvatarUpdateSQL, typedSource); occurrences != 4 {
		t.Fatalf("typed avatar source occurrences=%d, want 4", occurrences)
	}
	if strings.Contains(contactAvatarUpdateSQL, "avatar_source=$4,") ||
		strings.Contains(contactAvatarUpdateSQL, "WHEN $4='whatsapp'") {
		t.Fatal("avatar source parameter is reused without an explicit PostgreSQL type")
	}
}
