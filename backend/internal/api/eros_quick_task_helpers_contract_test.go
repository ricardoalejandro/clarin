package api

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestQuickFollowupPriorityExcludesDeletedTasks(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve Eros quick-task source path")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "eros_quick_task_helpers.go"))
	if err != nil {
		t.Fatalf("read Eros quick-task source: %v", err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"repository.TaskActorCanViewSQL(\"t\", \"task_list\", \"$2\")",
		"WHERE t.account_id=l.account_id AND t.deleted_at IS NULL",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("quick follow-up priority lost task visibility invariant %q", invariant)
		}
	}
}
