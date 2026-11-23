package database

import (
	"strings"
	"testing"
)

func TestUtilitiesMigrationKeepsPersonalScopeAndDurableCleanup(t *testing.T) {
	all := strings.Join(utilityMigrations(), "\n")
	for _, required := range []string{"utility_documents", "utility_content", "utility_changes", "utility_operations", "utility_vault", "utility_workspace", "utility_objects", "utility_content_jobs", "utility_search_chunks", "FOREIGN KEY(account_id,owner_id,document_id)", "62914560", "wrapped_key BYTEA", "CREATE EXTENSION IF NOT EXISTS pg_trgm"} {
		if !strings.Contains(all, required) {
			t.Fatalf("missing invariant %s", required)
		}
	}
	for _, spec := range storageReferenceGuardSpecs {
		if spec.table == "utility_vault" && spec.fields != "object_key" {
			t.Fatal("vault secrets participate in inventory payload")
		}
	}
}
