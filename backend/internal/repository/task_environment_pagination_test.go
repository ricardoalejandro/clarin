package repository

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func readTaskEnvironmentPaginationSource(t *testing.T, name string) string {
	t.Helper()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve task environment pagination source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(raw)
}

func TestTaskStructureCursorCarriesCompleteKeyset(t *testing.T) {
	t.Parallel()
	id := uuid.New()
	cursor := &TaskStructurePageCursor{SortOrder: -1024, ID: id}
	sortOrder, cursorID := taskStructureCursorValues(cursor)
	if sortOrder == nil || cursorID == nil || *sortOrder != -1024 || *cursorID != id {
		t.Fatalf("cursor values changed: sort=%v id=%v", sortOrder, cursorID)
	}
	if sortOrder, cursorID := taskStructureCursorValues(nil); sortOrder != nil || cursorID != nil {
		t.Fatalf("nil cursor emitted a partial boundary: sort=%v id=%v", sortOrder, cursorID)
	}
}

func TestTaskStructureQueriesDoNotLookupCursorRows(t *testing.T) {
	t.Parallel()
	environmentSource := readTaskEnvironmentPaginationSource(t, "task_environment_repository.go")
	childrenSource := readTaskEnvironmentPaginationSource(t, "task_environment_children_repository.go")
	for _, forbidden := range []string{"SELECT cursor_environment.sort_order", "SELECT cursor_item.sort_order"} {
		if strings.Contains(environmentSource, forbidden) || strings.Contains(childrenSource, forbidden) {
			t.Fatalf("structure pagination still depends on a mutable cursor row: %q", forbidden)
		}
	}
	for _, invariant := range []string{
		"(environment.sort_order,environment.id) > ($5,$6)",
		"TaskStructurePageCursor{SortOrder: boundary.SortOrder, ID: boundary.ID}",
	} {
		if !strings.Contains(environmentSource, invariant) {
			t.Fatalf("environment keyset lost invariant %q", invariant)
		}
	}
	for _, invariant := range []string{
		"(folder.sort_order,folder.id) > ($5,$6)",
		"(list_item.sort_order,list_item.id) > ($7,$8)",
	} {
		if !strings.Contains(childrenSource, invariant) {
			t.Fatalf("hierarchy keyset lost invariant %q", invariant)
		}
	}
}
