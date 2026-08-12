package repository

import (
	"strings"
	"testing"
)

func TestHistoricalArchiveAllowsOnlyDoneAndCancelledTasks(t *testing.T) {
	t.Parallel()
	predicate := taskOpenCategorySQL("task", "status")
	for _, invariant := range []string{
		"WHEN 'completed' THEN 'done'",
		"WHEN 'cancelled' THEN 'cancelled'",
		"NOT IN ('done','cancelled')",
	} {
		if !strings.Contains(predicate, invariant) {
			t.Fatalf("historical Archive open-task predicate lost %q: %s", invariant, predicate)
		}
	}
}

func TestArchiveAndTrashUseIndependentContainerState(t *testing.T) {
	t.Parallel()
	archiveSource := readRepositorySource(t, "task_archive_repository.go")
	for _, invariant := range []string{
		"SET archived_at=NOW(),archived_with_folder=FALSE",
		"SET archived_at=NOW(),archived_with_folder=TRUE",
		"taskOpenCategorySQL(\"task\", \"status\")",
	} {
		if !strings.Contains(archiveSource, invariant) {
			t.Fatalf("historical Archive lost invariant %q", invariant)
		}
	}
	environmentSource := readRepositorySource(t, "task_environment_repository.go")
	if !strings.Contains(environmentSource, "UPDATE task_environments SET archived_at=NOW()") {
		t.Fatal("Entorno historical Archive no longer uses archived_at")
	}

	trashSource := readRepositorySource(t, "task_trash_repository.go")
	for _, invariant := range []string{
		"SET deleted_at=NOW(),deleted_by=$3",
		"task.deleted_at IS NULL",
		"SET deleted_at=NULL,deleted_by=NULL",
		"UPDATE task_environments SET deleted_at=NOW(),deleted_by=$3",
	} {
		if !strings.Contains(trashSource, invariant) {
			t.Fatalf("Trash lost independent lifecycle invariant %q", invariant)
		}
	}
	if strings.Contains(trashSource, "SET archived_at=NULL,deleted_at=NULL") {
		t.Fatal("Trash restore must preserve prior historical Archive state")
	}
}
