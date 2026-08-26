package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestTaskLocationViewMigrationKeepsContextAndIsolationInvariants(t *testing.T) {
	t.Parallel()
	source := strings.Join(taskLocationViewMigrations(), "\n")
	for _, invariant := range []string{
		"CREATE TABLE IF NOT EXISTS task_location_views",
		"CHECK ((folder_id IS NULL) <> (list_id IS NULL))",
		"CHECK (view_type IN ('whiteboard'))",
		"FOREIGN KEY(account_id,environment_id) REFERENCES task_environments(account_id,id) ON DELETE RESTRICT",
		"FOREIGN KEY(account_id,environment_id,folder_id) REFERENCES task_folders(account_id,environment_id,id) ON DELETE RESTRICT",
		"FOREIGN KEY(account_id,environment_id,list_id) REFERENCES task_lists(account_id,environment_id,id) ON DELETE RESTRICT",
		"CREATE TABLE IF NOT EXISTS task_location_whiteboard_views",
		"UNIQUE(account_id,whiteboard_id)",
		"FOREIGN KEY(account_id,task_view_id) REFERENCES task_location_views(account_id,id) ON DELETE RESTRICT",
		"FOREIGN KEY(account_id,whiteboard_id) REFERENCES whiteboards(account_id,id) ON DELETE RESTRICT",
		"CREATE TABLE IF NOT EXISTS task_location_view_operations",
		"actor_id UUID NOT NULL",
		"ALTER COLUMN actor_id SET NOT NULL",
		"UNIQUE(account_id,actor_id,operation_id)",
		"FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE",
		"request_payload_hash CHAR(64) NOT NULL",
		"access_revision BIGINT NOT NULL DEFAULT 1",
		"idx_task_location_views_folder_order",
		"idx_task_location_views_list_order",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("task location view migration lost invariant %q", invariant)
		}
	}
	for _, forbidden := range []string{
		"REFERENCES task_folders(id)",
		"REFERENCES task_lists(id)",
		"REFERENCES whiteboards(id)",
		"REFERENCES task_folders(account_id,environment_id,id) ON DELETE CASCADE",
		"REFERENCES task_lists(account_id,environment_id,id) ON DELETE CASCADE",
		"REFERENCES whiteboards(account_id,id) ON DELETE CASCADE",
		"ON DELETE SET NULL (actor_id)",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("task location view migration retained unsafe relationship %q", forbidden)
		}
	}

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration test source")
	}
	databaseRaw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "database.go"))
	if err != nil {
		t.Fatal(err)
	}
	databaseSource := string(databaseRaw)
	whiteboardIndex := strings.Index(databaseSource, "migrateWhiteboards(ctx, db)")
	locationIndex := strings.Index(databaseSource, "migrateTaskLocationViews(ctx, db)")
	if whiteboardIndex < 0 || locationIndex < 0 || locationIndex < whiteboardIndex {
		t.Fatal("task location views must migrate after canonical whiteboards")
	}
}
