package repository

import (
	"context"
	"encoding/json"
	"testing"
)

func TestTaskEmptyPageCanonicalArray(t *testing.T) {
	f := newTaskIntegrityFixture(t)
	repo := &TaskRepository{db: f.pool}
	ctx := context.Background()
	task := f.task("Synthetic empty-page regression")
	if err := repo.Create(ctx, task); err != nil {
		t.Fatal(err)
	}
	filters := map[string]string{"environment_id": f.environment.String(), "list_id": f.list.String()}
	tasks, total, next, err := repo.GetByAccountForActorCursor(ctx, f.account, f.actor, filters, 50, nil)
	if err != nil || len(tasks) != 1 || total != 1 || next != nil {
		t.Fatalf("populated page: len=%d total=%d next=%v error=%v", len(tasks), total, next, err)
	}
	// A filter can legitimately produce no results while the list has other work.
	filters["search"] = "no-such-synthetic-title"
	empty, total, next, err := repo.GetByAccountForActorCursor(ctx, f.account, f.actor, filters, 50, nil)
	if err != nil || empty == nil || len(empty) != 0 || total != 0 || next != nil {
		t.Fatalf("empty cursor page must be []: %#v total=%d next=%v error=%v", empty, total, next, err)
	}
	wire, err := json.Marshal(map[string]any{"tasks": empty, "total": total})
	if err != nil || string(wire) != "{\"tasks\":[],\"total\":0}" {
		t.Fatalf("empty wire contract: %s %v", wire, err)
	}
	legacy, total, err := repo.GetByAccountForActor(ctx, f.account, f.actor, filters, 50, 0)
	if err != nil || legacy == nil || total != 0 {
		t.Fatalf("legacy page must also be []: %#v %v", legacy, err)
	}
	delete(filters, "search")
	// After a loaded cursor, removing the last task must produce an iterable page
	// even while total still includes tasks before that cursor.
	tail, total, next, err := repo.GetByAccountForActorCursor(ctx, f.account, f.actor, filters, 50, TaskCursorFromTask(task))
	if err != nil || tail == nil || len(tail) != 0 || total != 1 || next != nil {
		t.Fatalf("empty cursor tail: %#v total=%d next=%v error=%v", tail, total, next, err)
	}
}
