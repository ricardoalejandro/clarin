package database

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestWhiteboardMigrationKeepsIsolationRevisionAndGuestInvariants(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve migration source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_migration.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"permissions=array_append(COALESCE(permissions,'{}'::text[]),'whiteboards')",
		"FOREIGN KEY(account_id,parent_id) REFERENCES whiteboard_folders(account_id,id) ON DELETE RESTRICT",
		"FOREIGN KEY(account_id,user_id) REFERENCES user_accounts(account_id,user_id) ON DELETE CASCADE",
		"access_level IN ('view','edit','manage')",
		"CREATE TABLE IF NOT EXISTS whiteboard_operations",
		"CREATE TABLE IF NOT EXISTS whiteboard_activity",
		"idx_whiteboard_operations_technical_retention",
		"idx_whiteboard_activity_technical_retention",
		"FOREIGN KEY(account_id,board_id) REFERENCES whiteboards(account_id,id) ON DELETE CASCADE",
		"UNIQUE(account_id,board_id,operation_id)",
		"snapshot_object_key TEXT NOT NULL",
		"snapshot_content_hash CHAR(64) NOT NULL",
		"revision_kind VARCHAR(20) NOT NULL DEFAULT 'automatic'",
		"whiteboard_revisions_expiry_check",
		"CREATE TABLE IF NOT EXISTS whiteboard_revision_assets",
		"REFERENCES whiteboard_revisions(account_id,board_id,id) ON DELETE CASCADE",
		"FOREIGN KEY(account_id,snapshot_object_key) REFERENCES storage_objects(account_id,object_key)",
		"password_hash TEXT",
		"allow_export BOOLEAN NOT NULL DEFAULT FALSE",
		"CREATE TABLE IF NOT EXISTS whiteboard_guest_sessions",
		"FOREIGN KEY(account_id,board_id,share_link_id)",
		"REFERENCES whiteboard_share_links(account_id,board_id,id)",
		"FOREIGN KEY(account_id,board_id,guest_session_id)",
		"REFERENCES whiteboard_guest_sessions(account_id,board_id,id)",
		"CREATE TABLE IF NOT EXISTS whiteboard_assets",
		"ALTER TABLE whiteboard_assets ADD COLUMN IF NOT EXISTS library_id UUID",
		"ALTER TABLE whiteboard_assets ALTER COLUMN board_id DROP NOT NULL",
		"whiteboard_assets_owner_check",
		"FOREIGN KEY(account_id,library_id) REFERENCES whiteboard_libraries(account_id,id) ON DELETE CASCADE",
		"uq_whiteboard_assets_library_file",
		"whiteboard_assets_draft_lifecycle_check",
		"ALTER TABLE whiteboard_libraries VALIDATE CONSTRAINT whiteboard_libraries_description_length_check",
		"whiteboard_trash_retention_days INT NOT NULL DEFAULT 30",
		"whiteboard_assets_guest_board_check",
		"FOREIGN KEY(account_id,media_asset_id) REFERENCES media_assets(account_id,id) ON DELETE RESTRICT",
		"FOREIGN KEY(account_id,uploaded_by) REFERENCES user_accounts(account_id,user_id)",
		"FOREIGN KEY(account_id,created_by) REFERENCES user_accounts(account_id,user_id)",
		"FOREIGN KEY(account_id,actor_id) REFERENCES user_accounts(account_id,user_id)",
		"FOREIGN KEY(account_id,object_key) REFERENCES storage_objects(account_id,object_key)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("whiteboard migration lost invariant %q", invariant)
		}
	}
	for _, forbidden := range []string{
		"guest_session_id UUID REFERENCES whiteboard_guest_sessions(id)",
		"created_by UUID REFERENCES users(id)",
		"updated_by UUID REFERENCES users(id)",
		"actor_id UUID REFERENCES users(id)",
		"uploaded_by UUID REFERENCES users(id)",
	} {
		if strings.Contains(source, forbidden) {
			t.Fatalf("whiteboard migration retained global relationship %q", forbidden)
		}
	}
	databaseRaw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "database.go"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(databaseRaw), "migrateWhiteboards(ctx, db)") {
		t.Fatal("whiteboard migration is not wired into Migrate")
	}
}
