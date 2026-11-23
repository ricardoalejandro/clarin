package repository

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestActorVisibleCountsRecomputePreviouslyStaleLifecycleCapabilities(t *testing.T) {
	t.Parallel()
	list := &domain.TaskList{TaskCount: 7, OpenTaskCount: 7}
	list.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessFull, false, "direct_list"))
	list.SetLifecycle()
	applyActorTaskListCounts(list, actorTaskListCounts{Total: 2, Done: 2})
	if !list.Capabilities.CanArchive || list.Capabilities.CanTrash || list.Permissions != list.Capabilities {
		t.Fatalf("canonical aliases retained capabilities from pre-projection counts: %#v", list)
	}
	applyActorTaskListCounts(list, actorTaskListCounts{})
	if !list.Capabilities.CanTrash || list.TaskCount != 0 || list.OpenTaskCount != 0 {
		t.Fatalf("empty actor projection did not clear stale counts: %#v", list)
	}
}

func TestFolderLifecycleIncludesArchivedAndHiddenChildrenWithoutChangingBadges(t *testing.T) {
	t.Parallel()
	folderID, archivedListID, hiddenListID := uuid.New(), uuid.New(), uuid.New()
	folder := &domain.TaskFolder{ID: folderID}
	folder.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessFull, false, "folder"))
	archivedAt := time.Now()
	archived := &domain.TaskList{ID: archivedListID, FolderID: &folderID, ArchivedAt: &archivedAt}
	archived.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessFull, false, "list"))
	applyTaskContainerLifecycleFacts([]*domain.TaskFolder{folder}, []*domain.TaskList{archived}, []taskContainerListLifecycleFacts{
		{ID: archivedListID, FolderID: &folderID, Retained: true, Facts: domain.TaskContainerLifecycleConstraints{HasRetainedTasks: true}},
		{ID: hiddenListID, FolderID: &folderID, Retained: true, Facts: domain.TaskContainerLifecycleConstraints{HasRetainedTasks: true, HasOpenTasks: true, RestrictedDescendants: true}},
	})
	if folder.Capabilities.CanArchive || folder.Capabilities.CanTrash || folder.Capabilities.CanDelete {
		t.Fatalf("hidden retained descendant falsely advertised lifecycle eligibility: %#v", folder.Capabilities)
	}
	if folder.TaskCount != 0 || folder.OpenTaskCount != 0 || len(folder.Lists) != 0 {
		t.Fatalf("private descendants changed public badges or children: %#v", folder)
	}
	if archived.Capabilities.CanTrash || !archived.Capabilities.CanRestore {
		t.Fatalf("archived list lost its own lifecycle: %#v", archived.Capabilities)
	}
}

func TestFolderArchiveIgnoresDeletedChildrenButTrashStillRequiresAnEmptyTree(t *testing.T) {
	t.Parallel()
	folderID := uuid.New()
	folder := &domain.TaskFolder{ID: folderID}
	folder.SetEffectiveAccess(buildTaskEffectiveAccess(domain.TaskAccessFull, false, "folder"))
	applyTaskContainerLifecycleFacts([]*domain.TaskFolder{folder}, nil, []taskContainerListLifecycleFacts{
		{ID: uuid.New(), FolderID: &folderID, Retained: false, Facts: domain.TaskContainerLifecycleConstraints{
			HasRetainedTasks: true, HasOpenTasks: true, HasRetainedWorkEvents: true, HasFutureWorkEvents: true, RestrictedDescendants: true,
		}},
	})
	if !folder.Capabilities.CanArchive || folder.Capabilities.CanTrash {
		t.Fatalf("deleted-list facts did not preserve distinct Archive and empty-tree Trash rules: %#v", folder.Capabilities)
	}
}

func TestFutureWorkEventListsUsesRecurrenceAndCancelledOverridesAtExactEndBoundary(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 23, 15, 0, 0, 0, time.UTC)
	start, end := now.Add(-25*time.Hour), now.Add(-24*time.Hour)
	listID, eventID := uuid.New(), uuid.New()
	event := &domain.WorkEvent{ID: eventID, ListID: listID, StartAt: &start, EndAt: &end, Timezone: "UTC", RecurrenceRule: "FREQ=DAILY;COUNT=3"}
	occurrences, err := expandAllWorkEventOccurrences(event)
	if err != nil || len(occurrences) != 3 {
		t.Fatalf("expand fixture: %d %v", len(occurrences), err)
	}
	overrides := map[uuid.UUID]map[string]*workEventOccurrenceOverride{eventID: {
		occurrences[2].OccurrenceKey: {EventID: eventID, OccurrenceKey: occurrences[2].OccurrenceKey, Cancelled: true},
	}}
	future, err := futureWorkEventLists([]*domain.WorkEvent{event}, overrides, now)
	if err != nil || future[listID] {
		t.Fatalf("cancelled final occurrence or exact-end occurrence blocked Archive: %v %v", future, err)
	}
	future, err = futureWorkEventLists([]*domain.WorkEvent{event}, nil, now)
	if err != nil || !future[listID] {
		t.Fatalf("future recurring occurrence was ignored: %v %v", future, err)
	}
}

func TestFutureWorkEventListsHonorsMovedAndAllDayOccurrences(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 10, 23, 15, 0, 0, 0, time.UTC)
	start, end := now.Add(-2*time.Hour), now.Add(-time.Hour)
	event := &domain.WorkEvent{ID: uuid.New(), ListID: uuid.New(), StartAt: &start, EndAt: &end, Timezone: "UTC"}
	occurrences, err := expandAllWorkEventOccurrences(event)
	if err != nil || len(occurrences) != 1 {
		t.Fatal("invalid fixture", err)
	}
	movedStart, movedEnd := now.Add(time.Hour), now.Add(2*time.Hour)
	overrides := map[uuid.UUID]map[string]*workEventOccurrenceOverride{event.ID: {
		occurrences[0].OccurrenceKey: {StartAt: &movedStart, EndAt: &movedEnd},
	}}
	dayStart, dayEnd := "2026-10-23", "2026-10-24"
	allDay := &domain.WorkEvent{ID: uuid.New(), ListID: uuid.New(), IsAllDay: true, StartDate: &dayStart, EndDateExclusive: &dayEnd, Timezone: "America/Lima"}
	future, err := futureWorkEventLists([]*domain.WorkEvent{event, allDay}, overrides, now)
	if err != nil || !future[event.ListID] || !future[allDay.ListID] {
		t.Fatalf("override or calendar-date end was ignored: %v %v", future, err)
	}
}
