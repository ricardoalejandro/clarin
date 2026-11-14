package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type taskContainerListLifecycleFacts struct {
	ID       uuid.UUID
	FolderID *uuid.UUID
	Retained bool
	Facts    domain.TaskContainerLifecycleConstraints
}

// applyContainerLifecycleFacts keeps the badges actor-scoped while lifecycle
// capabilities reflect the entire affected tree, including hidden subtasks,
// individually archived lists and calendar events. The internal facts never
// change public badge counts or disclose hidden descendant identifiers.
func (r *TaskWorkRepository) applyContainerLifecycleFacts(ctx context.Context, accountID, actorID uuid.UUID, folders []*domain.TaskFolder, lists []*domain.TaskList) error {
	folderIDs, listIDs := make([]uuid.UUID, 0, len(folders)), make([]uuid.UUID, 0, len(lists))
	for _, folder := range folders {
		folderIDs = append(folderIDs, folder.ID)
	}
	for _, list := range lists {
		listIDs = append(listIDs, list.ID)
	}
	if len(folderIDs)+len(listIDs) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT list_item.id,list_item.folder_id,list_item.deleted_at IS NULL,
		(`+taskActorListAccessRankSQL("list_item", "$4")+`)<4,
		EXISTS(SELECT 1 FROM tasks task WHERE task.account_id=list_item.account_id AND task.list_id=list_item.id AND task.deleted_at IS NULL),
		EXISTS(SELECT 1 FROM tasks task LEFT JOIN task_statuses status ON status.account_id=task.account_id AND status.id=task.status_id
			WHERE task.account_id=list_item.account_id AND task.list_id=list_item.id AND task.deleted_at IS NULL AND `+taskOpenCategorySQL("task", "status")+`),
		EXISTS(SELECT 1 FROM work_events event_item WHERE event_item.account_id=list_item.account_id AND event_item.list_id=list_item.id AND event_item.deleted_at IS NULL)
		FROM task_lists list_item WHERE list_item.account_id=$1 AND (list_item.id=ANY($2::uuid[]) OR list_item.folder_id=ANY($3::uuid[]))
		ORDER BY list_item.id`, accountID, listIDs, folderIDs, actorID)
	if err != nil {
		return err
	}
	facts := make([]taskContainerListLifecycleFacts, 0)
	allListIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var item taskContainerListLifecycleFacts
		if err := rows.Scan(&item.ID, &item.FolderID, &item.Retained, &item.Facts.RestrictedDescendants,
			&item.Facts.HasRetainedTasks, &item.Facts.HasOpenTasks, &item.Facts.HasRetainedWorkEvents); err != nil {
			rows.Close()
			return err
		}
		facts, allListIDs = append(facts, item), append(allListIDs, item.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	future, err := r.containerFutureWorkEventLists(ctx, accountID, allListIDs, time.Now())
	if err != nil {
		return err
	}
	for index := range facts {
		facts[index].Facts.HasFutureWorkEvents = future[facts[index].ID]
	}
	applyTaskContainerLifecycleFacts(folders, lists, facts)
	return nil
}

func applyTaskContainerLifecycleFacts(folders []*domain.TaskFolder, lists []*domain.TaskList, facts []taskContainerListLifecycleFacts) {
	byList, byFolder := make(map[uuid.UUID]domain.TaskContainerLifecycleConstraints), make(map[uuid.UUID]domain.TaskContainerLifecycleConstraints)
	for _, item := range facts {
		listFacts := item.Facts
		// A list's own access is already represented by its capability level.
		listFacts.RestrictedDescendants = false
		byList[item.ID] = listFacts
		if item.FolderID != nil {
			combined := byFolder[*item.FolderID]
			combined.HasRetainedTasks = combined.HasRetainedTasks || item.Facts.HasRetainedTasks
			combined.HasRetainedWorkEvents = combined.HasRetainedWorkEvents || item.Facts.HasRetainedWorkEvents
			if item.Retained {
				combined.HasOpenTasks = combined.HasOpenTasks || item.Facts.HasOpenTasks
				combined.HasFutureWorkEvents = combined.HasFutureWorkEvents || item.Facts.HasFutureWorkEvents
				combined.RestrictedDescendants = combined.RestrictedDescendants || item.Facts.RestrictedDescendants
			}
			byFolder[*item.FolderID] = combined
		}
	}
	for _, list := range lists {
		value := byList[list.ID]
		list.LifecycleConstraints = &value
		list.SetLifecycle()
	}
	for _, folder := range folders {
		value := byFolder[folder.ID]
		folder.LifecycleConstraints = &value
		folder.SetLifecycle()
	}
}

func (r *TaskWorkRepository) containerFutureWorkEventLists(ctx context.Context, accountID uuid.UUID, listIDs []uuid.UUID, now time.Time) (map[uuid.UUID]bool, error) {
	events, overrides, err := containerScheduledWorkEventsWith(ctx, r.db, accountID, listIDs, false)
	if err != nil {
		return nil, err
	}
	return futureWorkEventLists(events, overrides, now)
}

// futureSharedWorkEventIDsWith batches the same recurrence/exception truth used
// by Archive so removal previews never issue one database read per event.
func futureSharedWorkEventIDsWith(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, listIDs []uuid.UUID, now time.Time) ([]uuid.UUID, error) {
	events, overrides, err := containerScheduledWorkEventsWith(ctx, q, accountID, listIDs, true)
	if err != nil {
		return nil, err
	}
	ids := make([]uuid.UUID, 0)
	for _, event := range events {
		future, err := workEventHasFutureOccurrence(event, overrides[event.ID], now)
		if err != nil {
			return nil, err
		}
		if future {
			ids = append(ids, event.ID)
		}
	}
	return ids, nil
}

func containerScheduledWorkEventsWith(ctx context.Context, q taskAccessQuerier, accountID uuid.UUID, listIDs []uuid.UUID, sharedOnly bool) ([]*domain.WorkEvent, map[uuid.UUID]map[string]*workEventOccurrenceOverride, error) {
	if len(listIDs) == 0 {
		return nil, nil, nil
	}
	rows, err := q.Query(ctx, `SELECT event_item.id,event_item.list_id,event_item.is_all_day,event_item.start_at,event_item.end_at,TO_CHAR(event_item.start_date,'YYYY-MM-DD'),
		TO_CHAR(event_item.end_date_exclusive,'YYYY-MM-DD'),event_item.timezone,event_item.recurrence_rule FROM work_events event_item
		WHERE event_item.account_id=$1 AND event_item.list_id=ANY($2::uuid[]) AND event_item.deleted_at IS NULL AND event_item.status='scheduled'
		  AND (NOT $3::boolean OR EXISTS(SELECT 1 FROM work_event_attendees attendee WHERE attendee.account_id=event_item.account_id
			AND attendee.event_id=event_item.id AND attendee.user_id<>event_item.organizer_id)) ORDER BY event_item.id`, accountID, listIDs, sharedOnly)
	if err != nil {
		return nil, nil, err
	}
	events, ids := make([]*domain.WorkEvent, 0), make([]uuid.UUID, 0)
	for rows.Next() {
		event := &domain.WorkEvent{AccountID: accountID, Status: domain.WorkEventStatusScheduled}
		if err := rows.Scan(&event.ID, &event.ListID, &event.IsAllDay, &event.StartAt, &event.EndAt, &event.StartDate,
			&event.EndDateExclusive, &event.Timezone, &event.RecurrenceRule); err != nil {
			rows.Close()
			return nil, nil, err
		}
		events, ids = append(events, event), append(ids, event.ID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()
	overrides, err := loadWorkEventOverrides(ctx, q, accountID, ids)
	if err != nil {
		return nil, nil, err
	}
	return events, overrides, nil
}

func futureWorkEventLists(events []*domain.WorkEvent, overrides map[uuid.UUID]map[string]*workEventOccurrenceOverride, now time.Time) (map[uuid.UUID]bool, error) {
	result := make(map[uuid.UUID]bool)
	for _, event := range events {
		if result[event.ListID] {
			continue
		}
		future, err := workEventHasFutureOccurrence(event, overrides[event.ID], now)
		if err != nil {
			return nil, err
		}
		if future {
			result[event.ListID] = true
		}
	}
	return result, nil
}

func workEventHasFutureOccurrence(event *domain.WorkEvent, overrides map[string]*workEventOccurrenceOverride, now time.Time) (bool, error) {
	occurrences, err := expandAllWorkEventOccurrences(event)
	if err != nil {
		return false, err
	}
	for _, occurrence := range occurrences {
		if override := overrides[occurrence.OccurrenceKey]; override != nil {
			occurrence = applyWorkEventOverride(occurrence, override)
			if occurrence == nil {
				continue
			}
		}
		end, err := workEventOccurrenceEnd(occurrence)
		if err != nil {
			return false, err
		}
		if end.After(now) {
			return true, nil
		}
	}
	return false, nil
}
