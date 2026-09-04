package database

import (
	"strings"
	"testing"
)

func TestNormalizedRoleNameMigrationFailsClosedBeforeCreatingIndex(t *testing.T) {
	t.Parallel()
	migrations := normalizedRoleNameMigrations()
	if len(migrations) != 2 {
		t.Fatalf("migration count = %d, want 2", len(migrations))
	}
	check := migrations[0]
	if !strings.Contains(check, "LOWER(BTRIM(name))") || !strings.Contains(check, "HAVING COUNT(*) > 1") ||
		!strings.Contains(check, "RAISE EXCEPTION") || strings.Contains(strings.ToUpper(check), "DELETE FROM ROLES") {
		t.Fatalf("duplicate preflight must stop without merging roles: %s", check)
	}
	index := migrations[1]
	if !strings.Contains(index, "CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_name_normalized") ||
		!strings.Contains(index, "LOWER(BTRIM(name))") {
		t.Fatalf("unexpected normalized unique index: %s", index)
	}
}
