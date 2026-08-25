package repository

import (
	"strings"
	"testing"
)

func TestProgramUpdateIsAccountScopedAtomicAndOptimistic(t *testing.T) {
	required := []string{
		"health_view_columns = $18",
		"WHERE id = $19 AND account_id = $20",
		"updated_at = $21::timestamptz",
		"RETURNING updated_at",
	}
	for _, fragment := range required {
		if !strings.Contains(updateProgramQuery, fragment) {
			t.Fatalf("program update query is missing %q", fragment)
		}
	}
	if strings.Contains(updateProgramQuery, ";") {
		t.Fatal("program update must remain one atomic SQL statement")
	}
}
