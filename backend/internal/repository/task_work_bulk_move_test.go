package repository

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNormalizeTaskBulkMoveRequestPreservesRelativeOrderAndVersions(t *testing.T) {
	first, second, destination := uuid.New(), uuid.New(), uuid.New()
	ids, versions, err := normalizeTaskBulkMoveRequest([]TaskBulkMoveItem{
		{ID: second, Version: 7},
		{ID: first, Version: 3},
	}, &destination, domain.TaskStatusCategoryActive)
	if err != nil {
		t.Fatalf("valid bulk move rejected: %v", err)
	}
	if len(ids) != 2 || ids[0] != second || ids[1] != first {
		t.Fatalf("selection order changed: %v", ids)
	}
	if versions[second] != 7 || versions[first] != 3 {
		t.Fatalf("optimistic versions changed: %v", versions)
	}
}

func TestNormalizeTaskBulkMoveRequestRejectsPartialOrAmbiguousWork(t *testing.T) {
	id, destination := uuid.New(), uuid.New()
	cases := []struct {
		name        string
		items       []TaskBulkMoveItem
		destination *uuid.UUID
		category    string
	}{
		{name: "empty", destination: &destination},
		{name: "no destination", items: []TaskBulkMoveItem{{ID: id, Version: 1}}},
		{name: "duplicate", items: []TaskBulkMoveItem{{ID: id, Version: 1}, {ID: id, Version: 1}}, destination: &destination},
		{name: "missing id", items: []TaskBulkMoveItem{{Version: 1}}, destination: &destination},
		{name: "missing version", items: []TaskBulkMoveItem{{ID: id}}, destination: &destination},
		{name: "unknown category", items: []TaskBulkMoveItem{{ID: id, Version: 1}}, category: "waiting_for_magic"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := normalizeTaskBulkMoveRequest(test.items, test.destination, test.category); !errors.Is(err, ErrTaskBulkMoveInvalid) {
				t.Fatalf("unsafe bulk move accepted: %v", err)
			}
		})
	}
}
