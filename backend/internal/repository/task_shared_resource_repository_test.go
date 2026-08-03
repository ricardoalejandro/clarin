package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSharedResourceHubIsEnvironmentScopedAndDirectOnly(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "task_shared_resource_repository.go"))
	if err != nil {
		t.Fatalf("read shared hub source: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"folder.environment_id=$3",
		"list_item.environment_id=$3",
		"task_folder_access_grants direct_grant",
		"task_list_access_grants direct_grant",
		"task_access_grants direct_grant",
		"direct_grant.user_id=$2",
		"(resource_type,LOWER(name),id)",
		"LIMIT $7",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("shared resource query lost invariant %q", invariant)
		}
	}
}
