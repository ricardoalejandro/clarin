package repository

import (
	"strings"
	"testing"
)

func TestCrossEnvironmentMoveAllocatesOnlyRootDestinationOrder(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_environment_move_repository.go")
	for _, invariant := range []string{
		"ORDER BY id FOR UPDATE",
		"SELECT COALESCE(MAX(sort_order),0)+1024 FROM tasks",
		"list_id=$2 AND parent_task_id IS NULL AND deleted_at IS NULL",
		"sort_order=CASE WHEN id=$8 THEN $9 ELSE sort_order END",
		"actorID, taskID, destinationSortOrder",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("cross-environment move lost durable order invariant %q", invariant)
		}
	}
	if strings.Index(source, "ORDER BY id FOR UPDATE") > strings.Index(source, "SELECT COALESCE(MAX(sort_order),0)+1024 FROM tasks") {
		t.Fatal("destination position is allocated before list serialization")
	}
	if strings.Contains(source, "sort_order=CASE WHEN id=$2") {
		t.Fatal("cross-environment move compares each row with its own WHERE id and would overwrite child order")
	}
}

func TestCrossEnvironmentMoveRequiresParticipantEnvironmentVisibility(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "task_environment_move_repository.go")
	for _, invariant := range []string{
		"resolveEnvironmentAccessWith(ctx, tx, accountID, participantID, lists[destinationListID].environmentID)",
		"environmentAccess == nil || !environmentAccess.CanView",
		"resolveContainerAccessWith(ctx, tx, accountID, participantID, destinationListID, domain.TaskAccessTargetList)",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("cross-environment participant access lost invariant %q", invariant)
		}
	}
}
