package repository

import (
	"reflect"
	"testing"
)

func TestOrderAccountPurgeTablesDeletesChildrenBeforeParents(t *testing.T) {
	t.Parallel()
	tables := []string{"task_lists", "task_location_views", "task_location_whiteboard_views", "whiteboards"}
	dependencies := []accountPurgeTableDependency{
		{Child: "task_location_whiteboard_views", Parent: "task_location_views"},
		{Child: "task_location_whiteboard_views", Parent: "whiteboards"},
		{Child: "task_location_views", Parent: "task_lists"},
		// Duplicate catalog edges and self-FKs must not distort the order.
		{Child: "task_location_views", Parent: "task_lists"},
		{Child: "whiteboards", Parent: "whiteboards"},
	}

	got, err := orderAccountPurgeTables(tables, dependencies)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"task_location_whiteboard_views", "task_location_views", "task_lists", "whiteboards"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("purge order=%v, want %v", got, want)
	}
}

func TestOrderAccountPurgeTablesRejectsCrossTableCycle(t *testing.T) {
	t.Parallel()
	_, err := orderAccountPurgeTables([]string{"left", "right"}, []accountPurgeTableDependency{
		{Child: "left", Parent: "right"},
		{Child: "right", Parent: "left"},
	})
	if err == nil {
		t.Fatal("dependency cycle must fail closed")
	}
}
