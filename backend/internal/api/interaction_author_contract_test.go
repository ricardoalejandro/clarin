package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestCRMInteractionQueriesPreserveAuthorSourceAndAccountIsolation(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "server.go"))
	if err != nil {
		t.Fatalf("read server.go: %v", err)
	}
	source := string(raw)
	authorFallback := "COALESCE(NULLIF(BTRIM(u.display_name), ''), NULLIF(BTRIM(u.username), ''), NULLIF(BTRIM(u.email), ''))"

	if got := strings.Count(source, authorFallback); got < 3 {
		t.Fatalf("CRM endpoint author fallback appears %d times, want at least 3", got)
	}
	for _, invariant := range []string{
		"COALESCE(i.source_label, '') AS source_label",
		"i.account_id = $2 AND i.lead_id = ANY($1)",
		"JOIN leads l ON l.id = i.lead_id AND l.account_id = $2",
		"directParticipantInteractionWhere()",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("CRM interaction endpoint contract lost %q", invariant)
		}
	}
}
