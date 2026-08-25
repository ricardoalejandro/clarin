package repository

import (
	"strings"
	"testing"
)

func TestDecideTaskDescriptionUpdate(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                            string
		current, requested              string
		currentVersion, expectedVersion int64
		want                            taskDescriptionDecision
	}{
		{name: "write matching version", current: "antes", requested: "después", currentVersion: 7, expectedVersion: 7, want: taskDescriptionWrite},
		{name: "conflict changed content", current: "remoto", requested: "local", currentVersion: 8, expectedVersion: 7, want: taskDescriptionConflict},
		{name: "idempotent retry", current: "guardado", requested: "guardado", currentVersion: 8, expectedVersion: 7, want: taskDescriptionNoop},
		{name: "empty content idempotent", current: "", requested: "", currentVersion: 3, expectedVersion: 1, want: taskDescriptionNoop},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := decideTaskDescriptionUpdate(test.current, test.currentVersion, test.requested, test.expectedVersion); got != test.want {
				t.Fatalf("decision=%v, want %v", got, test.want)
			}
		})
	}
}

func TestTaskDescriptionMutationIsAtomicScopedAndAuthorized(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_description_repository.go")
	for _, invariant := range []string{
		"WHERE task.account_id=$1 AND task.id=$2 AND task.deleted_at IS NULL AND root.deleted_at IS NULL",
		"FOR UPDATE OF root,task",
		"resolveTaskAccessWith(ctx, tx, accountID, actorID, taskID)",
		"TaskAccessAllows(accessContext.Access, domain.TaskAccessEdit)",
		"SET description=$4,updated_at=NOW(),version=COALESCE(version,1)+1",
		"COALESCE(version,1)=$3",
		"'description_updated'",
		"tx.Commit(ctx)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("description mutation lost invariant %q", invariant)
		}
	}
	if strings.Count(source, "'description_updated'") != 1 {
		t.Fatalf("description mutation must write exactly one activity statement")
	}
	if strings.Contains(source, "hierarchy_counts") {
		t.Fatalf("description mutation unexpectedly coupled itself to hierarchy counts")
	}
}
