package repository

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestBuildTaskHierarchyCountsUsesListsAsCanonicalTotal(t *testing.T) {
	rootID, folderID, childID := uuid.New(), uuid.New(), uuid.New()
	root := &domain.TaskList{ID: rootID, TaskCount: 4, OpenTaskCount: 2, CompletedTaskCount: 1, CancelledTaskCount: 1}
	child := &domain.TaskList{ID: childID, FolderID: &folderID, TaskCount: 3, OpenTaskCount: 1, CompletedTaskCount: 2}
	folder := &domain.TaskFolder{ID: folderID, TaskCount: 3, OpenTaskCount: 1, CompletedTaskCount: 2, Lists: []*domain.TaskList{child}}

	snapshot := buildTaskHierarchyCounts([]*domain.TaskFolder{folder}, []*domain.TaskList{root})
	if snapshot.TaskCount != 7 || snapshot.OpenTaskCount != 3 || snapshot.CompletedTaskCount != 3 || snapshot.CancelledTaskCount != 1 {
		t.Fatalf("unexpected global hierarchy counts: %#v", snapshot)
	}
	if len(snapshot.Lists) != 2 || snapshot.Lists[0].ID != rootID || snapshot.Lists[1].ID != childID {
		t.Fatalf("canonical list snapshots were lost or reordered: %#v", snapshot.Lists)
	}
	if len(snapshot.Folders) != 1 || snapshot.Folders[0].ID != folderID || snapshot.Folders[0].OpenTaskCount != 1 {
		t.Fatalf("canonical folder snapshot was lost: %#v", snapshot.Folders)
	}
}

func TestFolderHierarchyCountsComeOnlyFromTopLevelListCounts(t *testing.T) {
	folderID := uuid.New()
	// The list aggregate is the production boundary that excludes child tasks.
	// Deliberately inflate the folder's legacy value as if one child task had
	// leaked into a separate aggregate; the canonical builder must ignore it.
	list := &domain.TaskList{ID: uuid.New(), FolderID: &folderID, TaskCount: 2, OpenTaskCount: 1, CompletedTaskCount: 1}
	folder := &domain.TaskFolder{ID: folderID, TaskCount: 3, OpenTaskCount: 2, CompletedTaskCount: 1, Lists: []*domain.TaskList{list}}

	snapshot := buildTaskHierarchyCounts([]*domain.TaskFolder{folder}, nil)
	if len(snapshot.Folders) != 1 {
		t.Fatalf("expected one folder snapshot, got %#v", snapshot.Folders)
	}
	got := snapshot.Folders[0]
	if got.TaskCount != 2 || got.OpenTaskCount != 1 || got.CompletedTaskCount != 1 || got.CancelledTaskCount != 0 {
		t.Fatalf("subtask-inflated folder counts escaped canonical list totals: %#v", got)
	}
	if snapshot.TaskCount != 2 || snapshot.OpenTaskCount != 1 {
		t.Fatalf("global counts diverged from canonical top-level lists: %#v", snapshot)
	}
}

func TestNormalizeTaskBulkMoveRequestPreservesRelativeOrderAndVersions(t *testing.T) {
	first, second, destination := uuid.New(), uuid.New(), uuid.New()
	ids, versions, err := normalizeTaskBulkMoveRequest([]TaskBulkMoveItem{
		{ID: second, Version: 7},
		{ID: first, Version: 3},
	}, &destination, nil, domain.TaskStatusCategoryActive)
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
			if _, _, err := normalizeTaskBulkMoveRequest(test.items, test.destination, nil, test.category); !errors.Is(err, ErrTaskBulkMoveInvalid) {
				t.Fatalf("unsafe bulk move accepted: %v", err)
			}
		})
	}
}

func TestNormalizeTaskBulkMoveRequestAllowsAnchorOnlyReorderAndRejectsSelectedAnchor(t *testing.T) {
	taskID := uuid.New()
	anchorID := uuid.New()
	if _, _, err := normalizeTaskBulkMoveRequest([]TaskBulkMoveItem{{ID: taskID, Version: 2}}, nil, &anchorID, ""); err != nil {
		t.Fatalf("expected anchor-only reorder to be valid, got %v", err)
	}
	if _, _, err := normalizeTaskBulkMoveRequest([]TaskBulkMoveItem{{ID: taskID, Version: 2}}, nil, &taskID, ""); !errors.Is(err, ErrTaskBulkMoveInvalid) {
		t.Fatalf("expected selected anchor rejection, got %v", err)
	}
}
