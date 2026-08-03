package repository

import (
	"testing"

	"github.com/google/uuid"
)

func TestTaskListOrderRequiresCompleteSiblingScope(t *testing.T) {
	t.Parallel()
	first, second, third := uuid.New(), uuid.New(), uuid.New()
	available := map[uuid.UUID]struct{}{first: {}, second: {}, third: {}}
	if !taskListOrderIsComplete([]uuid.UUID{third, first, second}, available) {
		t.Fatal("complete reordered sibling collection was rejected")
	}
	for name, requested := range map[string][]uuid.UUID{
		"partial":   {first, second},
		"duplicate": {first, second, second},
		"foreign":   {first, second, uuid.New()},
	} {
		requested := requested
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if taskListOrderIsComplete(requested, available) {
				t.Fatalf("invalid order %v was accepted", requested)
			}
		})
	}
}

func TestTaskListOrderRejectsCrossEnvironmentContainerAndDefault(t *testing.T) {
	t.Parallel()
	environmentID, otherEnvironmentID := uuid.New(), uuid.New()
	folderID, otherFolderID := uuid.New(), uuid.New()
	if !taskListOrderScopeMatches(environmentID, &folderID, environmentID, &folderID, false) {
		t.Fatal("same environment and folder was rejected")
	}
	if taskListOrderScopeMatches(environmentID, &folderID, otherEnvironmentID, &folderID, false) {
		t.Fatal("cross-environment reorder was accepted")
	}
	if taskListOrderScopeMatches(environmentID, &folderID, environmentID, &otherFolderID, false) {
		t.Fatal("cross-container reorder was accepted")
	}
	if taskListOrderScopeMatches(environmentID, nil, environmentID, nil, true) {
		t.Fatal("default list was accepted as a reorderable root sibling")
	}
}
