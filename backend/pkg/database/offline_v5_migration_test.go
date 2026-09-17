package database

import (
	"os"
	"strings"
	"testing"
)

func TestOfflineV5MigrationIsAdditiveAccountScopedAndInRuntimePath(t *testing.T) {
	runtimeSource, err := os.ReadFile("database.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(runtimeSource), "migrateOfflineV5(ctx, db)") {
		t.Fatal("offline v5 migration is not in Migrate runtime path")
	}
	source, err := os.ReadFile("offline_v5_migration.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, invariant := range []string{
		"offline_v5_grant_policies", "offline_v5_manifests", "offline_v5_manifest_roots",
		"offline_v5_manifest_dependencies", "offline_v5_manifest_capabilities", "offline_v5_receipts",
		"FOREIGN KEY(grant_id,account_id)", "FOREIGN KEY(manifest_id,grant_id,account_id)",
		"FOREIGN KEY(selection_id,grant_id,account_id)", "expires_at<=issued_at+INTERVAL '24 hours'",
		"fk_offline_v5_capability_root", "FOREIGN KEY(manifest_id,selection_id)",
		"PRIMARY KEY(grant_id,operation_id)", "intent_hash CHAR(64) NOT NULL", "ALTER COLUMN intent_hash SET NOT NULL", "ON DELETE CASCADE",
	} {
		if !strings.Contains(text, invariant) {
			t.Fatalf("offline v5 migration lost invariant %q", invariant)
		}
	}
	for _, destructive := range []string{"DROP TABLE", "TRUNCATE ", "DELETE FROM offline_v4", "ALTER TABLE offline_v4_grants DROP"} {
		if strings.Contains(text, destructive) {
			t.Fatalf("offline v5 migration is not additive: %q", destructive)
		}
	}
}
