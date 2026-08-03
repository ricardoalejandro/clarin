package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestIntersectTaskViewerSetsRequiresAccessToEveryEndpoint(t *testing.T) {
	shared := uuid.New()
	onlyEnvironmentA := uuid.New()
	onlyEnvironmentB := uuid.New()

	got := intersectTaskViewerSets([][]uuid.UUID{
		{onlyEnvironmentA, shared, shared},
		{shared, onlyEnvironmentB},
	})
	if len(got) != 1 || got[0] != shared {
		t.Fatalf("common viewers = %v, want only %s", got, shared)
	}

	if got := intersectTaskViewerSets([][]uuid.UUID{{onlyEnvironmentA}, {onlyEnvironmentB}}); len(got) != 0 {
		t.Fatalf("cross-environment private endpoints leaked to viewers: %v", got)
	}
}

func TestIntersectTaskViewerSetsHandlesEmptyPayload(t *testing.T) {
	if got := intersectTaskViewerSets(nil); len(got) != 0 {
		t.Fatalf("empty viewer sets = %v", got)
	}
	if got := intersectTaskViewerSets([][]uuid.UUID{{uuid.New()}, {}}); len(got) != 0 {
		t.Fatalf("endpoint without viewers must suppress broadcast: %v", got)
	}
}

func TestRealtimePayloadDoesNotLeakActorHierarchyToDirectTaskShare(t *testing.T) {
	privateListID := uuid.New()
	sharedTask := &domain.Task{ID: uuid.New(), BreadcrumbsVisible: false}
	actorCounts := &domain.TaskHierarchyCounts{
		TaskCount: 7,
		Lists:     []domain.TaskListCountSnapshot{{ID: privateListID, TaskCount: 7}},
	}
	original := map[string]any{
		"task":             sharedTask,
		"operation_id":     uuid.NewString(),
		"hierarchy_counts": actorCounts,
	}

	realtime := taskRealtimePayload(original)
	if _, leaked := realtime["hierarchy_counts"]; leaked {
		t.Fatalf("direct-share event leaked private hierarchy IDs/counts: %#v", realtime)
	}
	if _, leaked := realtime["task"]; leaked {
		t.Fatalf("direct-share event leaked canonical task breadcrumbs: %#v", realtime)
	}
	if realtime["task_id"] != sharedTask.ID || realtime["operation_id"] != original["operation_id"] {
		t.Fatalf("minimal authorized mutation was lost: %#v", realtime)
	}
	if original["hierarchy_counts"] != actorCounts {
		t.Fatal("sanitizing WebSocket payload mutated the actor-specific HTTP response")
	}
}

func TestEnvironmentMoveRealtimePayloadDoesNotExposeDestinationBreadcrumb(t *testing.T) {
	taskID, environmentID, listID := uuid.New(), uuid.New(), uuid.New()
	canonicalForActor := &domain.Task{ID: taskID, EnvironmentID: &environmentID, ListID: &listID, ListName: "Lista privada"}
	realtime := taskRealtimePayload(map[string]any{
		"task": canonicalForActor, "version": int64(8), "operation_id": uuid.New(),
	})
	if _, leaked := realtime["task"]; leaked {
		t.Fatalf("environment move leaked destination breadcrumb: %#v", realtime)
	}
	if realtime["task_id"] != taskID || realtime["version"] != int64(8) {
		t.Fatalf("environment move lost its minimal reconciliation identity: %#v", realtime)
	}
}
