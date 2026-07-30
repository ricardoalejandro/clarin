package service

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

type TaskService struct {
	repos *repository.Repositories
	hub   *ws.Hub
}

func NewTaskService(repos *repository.Repositories, hub *ws.Hub) *TaskService {
	return &TaskService{repos: repos, hub: hub}
}

func (s *TaskService) Create(ctx context.Context, task *domain.Task) error {
	operationID := task.MutationOperationID
	if err := s.repos.Task.Create(ctx, task); err != nil {
		return err
	}
	canonical := task
	if loaded, err := s.GetByID(ctx, task.ID, task.AccountID); err == nil {
		canonical = loaded
		*task = *loaded
	}

	s.RebuildReminder(ctx, canonical)

	// Broadcast
	if s.hub != nil {
		payload := taskCreatedEventPayload(canonical, operationID)
		if canonical.ParentTaskID != nil {
			payload = map[string]interface{}{
				"action":  "subtask_created",
				"task_id": canonical.ParentTaskID.String(),
				"subtask": canonical,
			}
			if operationID != nil {
				payload["operation_id"] = operationID.String()
			}
		}
		s.hub.BroadcastToAccountWithPermission(canonical.AccountID, domain.PermTasks, ws.EventTaskUpdate, payload)
	}
	if canonical.ParentTaskID != nil {
		s.NotifySubtasksUpdated(ctx, canonical.AccountID, *canonical.ParentTaskID)
	}

	return nil
}

func taskCreatedEventPayload(task *domain.Task, operationID *uuid.UUID) map[string]interface{} {
	payload := map[string]interface{}{"action": "created", "task": task}
	if operationID != nil {
		payload["operation_id"] = operationID.String()
	}
	return payload
}

func (s *TaskService) Update(ctx context.Context, task *domain.Task) error {
	operationID := task.MutationOperationID
	previous, _ := s.GetByID(ctx, task.ID, task.AccountID)
	if err := s.repos.Task.Update(ctx, task); err != nil {
		return err
	}
	canonical := task
	if loaded, err := s.GetByID(ctx, task.ID, task.AccountID); err == nil {
		loaded.MutationOperationID = operationID
		canonical = loaded
		*task = *loaded
	}

	if previous == nil || taskReminderScheduleChanged(previous, canonical) {
		s.RebuildReminder(ctx, canonical)
	}

	if s.hub != nil {
		structureChanged := previous != nil && (!taskNullableUUIDEqual(previous.ListID, canonical.ListID) || !taskNullableUUIDEqual(previous.ParentTaskID, canonical.ParentTaskID))
		payload := map[string]interface{}{
			"action":            "updated",
			"task":              canonical,
			"structure_changed": structureChanged,
		}
		if canonical.MutationOperationID != nil {
			payload["operation_id"] = canonical.MutationOperationID.String()
		}
		s.hub.BroadcastToAccountWithPermission(canonical.AccountID, domain.PermTasks, ws.EventTaskUpdate, payload)
		if previous != nil && previous.ParentTaskID == nil && !taskNullableUUIDEqual(previous.ListID, canonical.ListID) {
			subtaskPayload := map[string]interface{}{
				"action":  "subtasks_updated",
				"task_id": canonical.ID.String(),
			}
			if canonical.MutationOperationID != nil {
				subtaskPayload["operation_id"] = canonical.MutationOperationID.String()
			}
			s.hub.BroadcastToAccountWithPermission(canonical.AccountID, domain.PermTasks, ws.EventTaskUpdate, subtaskPayload)
		}
	}
	if canonical.ParentTaskID != nil {
		s.NotifySubtasksUpdated(ctx, canonical.AccountID, *canonical.ParentTaskID)
	}

	return nil
}

func taskNullableUUIDEqual(left, right *uuid.UUID) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func (s *TaskService) RebuildReminder(ctx context.Context, task *domain.Task) {
	if task == nil {
		return
	}
	if err := s.repos.Task.SyncReminder(ctx, task.ID); err != nil {
		log.Printf("[TASK] Warning: failed to synchronize reminder for task %s: %v", task.ID, err)
	}
}

func taskReminderScheduleChanged(before, after *domain.Task) bool {
	if before == nil || after == nil || before.AssignedTo != after.AssignedTo {
		return true
	}
	if taskCanScheduleReminder(before) != taskCanScheduleReminder(after) {
		return true
	}
	if (before.DueAt == nil) != (after.DueAt == nil) || (before.ReminderMinutes == nil) != (after.ReminderMinutes == nil) {
		return true
	}
	if before.DueAt != nil && !before.DueAt.Equal(*after.DueAt) {
		return true
	}
	return before.ReminderMinutes != nil && *before.ReminderMinutes != *after.ReminderMinutes
}

func taskCanScheduleReminder(task *domain.Task) bool {
	if task == nil {
		return false
	}
	if task.StatusDetail != nil {
		return task.StatusDetail.Category != domain.TaskStatusCategoryDone && task.StatusDetail.Category != domain.TaskStatusCategoryCancelled
	}
	return task.Status != domain.TaskStatusCompleted && task.Status != domain.TaskStatusCancelled
}

func (s *TaskService) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_ = s.repos.Task.DeleteRemindersByTask(ctx, id)
	if err := s.repos.Task.Delete(ctx, id, accountID); err != nil {
		return err
	}

	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "deleted",
			"task_id": id.String(),
		})
	}

	return nil
}

func (s *TaskService) Complete(ctx context.Context, id, accountID, completedBy uuid.UUID) error {
	task, loadErr := s.GetByID(ctx, id, accountID)
	if err := s.repos.Task.MarkCompleted(ctx, id, accountID, completedBy); err != nil {
		return err
	}
	if loadErr == nil {
		s.EnsureNextOccurrence(ctx, task)
	}

	canonical, canonicalErr := s.GetByID(ctx, id, accountID)
	if canonicalErr != nil {
		return canonicalErr
	}
	s.RebuildReminder(ctx, canonical)
	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
			"action": "completed",
			"task":   canonical,
		})
	}
	if canonical.ParentTaskID != nil {
		s.NotifySubtasksUpdated(ctx, canonical.AccountID, *canonical.ParentTaskID)
	}

	return nil
}

// NotifySubtasksUpdated broadcasts the canonical parent after a child mutation.
// Consumers can update counters immediately without treating the child as a
// top-level task or issuing an account-wide refresh.
func (s *TaskService) NotifySubtasksUpdated(ctx context.Context, accountID, parentID uuid.UUID) {
	if s.hub == nil {
		return
	}
	parent, err := s.GetByID(ctx, parentID, accountID)
	if err != nil {
		return
	}
	s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, taskSubtasksUpdatedPayload(parent))
}

func taskSubtasksUpdatedPayload(parent *domain.Task) map[string]interface{} {
	return map[string]interface{}{
		"action":  "subtasks_updated",
		"task_id": parent.ID.String(),
		"task":    parent,
	}
}

// EnsureNextOccurrence creates exactly one following occurrence for supported
// recurrence rules. Completion remains successful if recurrence generation
// cannot run; the error is logged and a later completion retry is idempotent.
func (s *TaskService) EnsureNextOccurrence(ctx context.Context, task *domain.Task) {
	if task == nil || task.DueAt == nil || strings.TrimSpace(task.RecurrenceRule) == "" {
		return
	}
	nextDue, supported := nextRecurringDue(*task.DueAt, task.RecurrenceRule)
	if !supported {
		return
	}
	rootID := task.ID
	if task.RecurrenceParentID != nil {
		rootID = *task.RecurrenceParentID
	}
	exists, err := s.repos.Task.RecurringOccurrenceExists(ctx, task.AccountID, rootID, nextDue)
	if err != nil || exists {
		return
	}
	status, err := s.repos.TaskWork.ResolveStatus(ctx, task.AccountID, task.ListID, nil, domain.TaskStatusCategoryNotStarted)
	if err != nil {
		log.Printf("[TASK] Failed to resolve recurring status for %s: %v", task.ID, err)
		return
	}
	clone := *task
	clone.ID = uuid.Nil
	clone.Status = domain.TaskStatusPending
	clone.StatusID = &status.ID
	clone.StatusDetail = status
	clone.Progress = 0
	clone.CompletedAt = nil
	clone.CompletedBy = nil
	clone.DeletedAt = nil
	clone.DeletedBy = nil
	clone.Version = 1
	clone.RecurrenceParentID = &rootID
	clone.DueAt = &nextDue
	if task.StartAt != nil {
		delta := nextDue.Sub(*task.DueAt)
		nextStart := task.StartAt.Add(delta)
		clone.StartAt = &nextStart
	}
	clone.Collaborators = nil
	clone.CollaboratorIDs = nil
	clone.CollaboratorsSet = true
	clone.CollaboratorsActor = &task.CreatedBy
	if collaborators, err := s.repos.TaskWork.ListCollaborators(ctx, task.AccountID, task.ID); err == nil {
		for _, collaborator := range collaborators {
			clone.CollaboratorIDs = append(clone.CollaboratorIDs, collaborator.UserID)
		}
	}
	clone.SubtaskCount = 0
	clone.SubtaskDone = 0
	clone.CommentCount = 0
	clone.AttachmentCount = 0
	if err := s.Create(ctx, &clone); err != nil {
		log.Printf("[TASK] Failed to create recurring occurrence for %s: %v", task.ID, err)
		return
	}
}

func nextRecurringDue(due time.Time, rule string) (time.Time, bool) {
	nextDue := due
	switch strings.ToLower(strings.TrimSpace(rule)) {
	case "daily":
		nextDue = nextDue.AddDate(0, 0, 1)
	case "weekdays":
		for {
			nextDue = nextDue.AddDate(0, 0, 1)
			if nextDue.Weekday() != time.Saturday && nextDue.Weekday() != time.Sunday {
				break
			}
		}
	case "weekly":
		nextDue = nextDue.AddDate(0, 0, 7)
	case "monthly":
		nextDue = nextDue.AddDate(0, 1, 0)
	default:
		return due, false
	}
	return nextDue, true
}

func (s *TaskService) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Task, error) {
	task, err := s.repos.Task.GetByID(ctx, id, accountID)
	if err != nil {
		return nil, err
	}
	collaborators, err := s.repos.TaskWork.ListCollaborators(ctx, accountID, id)
	if err != nil {
		return nil, err
	}
	task.Collaborators = collaborators
	return task, nil
}

func (s *TaskService) GetByAccount(ctx context.Context, accountID uuid.UUID, filters map[string]string, limit, offset int) ([]*domain.Task, int, error) {
	tasks, total, err := s.repos.Task.GetByAccount(ctx, accountID, filters, limit, offset)
	if err != nil || len(tasks) == 0 {
		return tasks, total, err
	}
	if err := s.hydrateCollaborators(ctx, accountID, tasks); err != nil {
		return nil, 0, err
	}
	return tasks, total, nil
}

func (s *TaskService) GetCalendarRange(ctx context.Context, accountID uuid.UUID, from, to time.Time, assignedTo *uuid.UUID) ([]*domain.Task, error) {
	tasks, err := s.repos.Task.GetCalendarRange(ctx, accountID, from, to, assignedTo)
	if err != nil || len(tasks) == 0 {
		return tasks, err
	}
	if err := s.hydrateCollaborators(ctx, accountID, tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}

func (s *TaskService) hydrateCollaborators(ctx context.Context, accountID uuid.UUID, tasks []*domain.Task) error {
	ids := make([]uuid.UUID, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	byTask, err := s.repos.TaskWork.ListCollaboratorsByTaskIDs(ctx, accountID, ids)
	if err != nil {
		return err
	}
	assignTaskCollaborators(tasks, byTask)
	return nil
}

func assignTaskCollaborators(tasks []*domain.Task, byTask map[uuid.UUID][]*domain.TaskCollaborator) {
	for _, task := range tasks {
		items := byTask[task.ID]
		if items == nil {
			items = []*domain.TaskCollaborator{}
		}
		task.Collaborators = items
	}
}

func (s *TaskService) GetStats(ctx context.Context, accountID, assignedTo uuid.UUID) (map[string]int, error) {
	return s.repos.Task.GetStats(ctx, accountID, assignedTo)
}

// ProcessOverdueTasks marks overdue tasks and broadcasts notifications
func (s *TaskService) ProcessOverdueTasks(ctx context.Context) {
	tasks, err := s.repos.Task.MarkOverdue(ctx)
	if err != nil {
		log.Printf("[TASK] Error marking overdue tasks: %v", err)
		return
	}
	for _, t := range tasks {
		if s.hub != nil {
			targets := s.taskNotificationTargets(ctx, t.AccountID, t.ID, t.AssignedTo)
			s.hub.BroadcastToAccountUsersWithPermission(t.AccountID, targets, domain.PermTasks, ws.EventTaskOverdue, map[string]interface{}{
				"task_id":     t.ID.String(),
				"title":       t.Title,
				"type":        t.Type,
				"assigned_to": t.AssignedTo.String(),
			})
		}
	}
	if len(tasks) > 0 {
		log.Printf("[TASK] Marked %d tasks as overdue", len(tasks))
	}
}

// ProcessReminders delivers pending reminders via WebSocket
func (s *TaskService) ProcessReminders(ctx context.Context) {
	reminders, err := s.repos.Task.GetPendingReminders(ctx)
	if err != nil {
		log.Printf("[TASK] Error fetching pending reminders: %v", err)
		return
	}
	for _, rem := range reminders {
		title, taskType, dueAt, err := s.repos.Task.GetTaskForReminder(ctx, rem.TaskID)
		if err != nil {
			log.Printf("[TASK] Error fetching task %s for reminder: %v", rem.TaskID, err)
			continue
		}

		if s.hub != nil {
			targets := s.taskNotificationTargets(ctx, rem.AccountID, rem.TaskID, rem.AssignedTo)
			s.hub.BroadcastToAccountUsersWithPermission(rem.AccountID, targets, domain.PermTasks, ws.EventTaskReminder, map[string]interface{}{
				"task_id":     rem.TaskID.String(),
				"title":       title,
				"type":        taskType,
				"due_at":      dueAt,
				"assigned_to": rem.AssignedTo.String(),
				"reminder_at": rem.ReminderAt,
			})
		}

		if err := s.repos.Task.MarkReminderDelivered(ctx, rem.ID); err != nil {
			log.Printf("[TASK] Error marking reminder %s as delivered: %v", rem.ID, err)
		}
	}
}

func (s *TaskService) taskNotificationTargets(ctx context.Context, accountID, taskID, assignedTo uuid.UUID) []uuid.UUID {
	targets := []uuid.UUID{assignedTo}
	seen := map[uuid.UUID]bool{assignedTo: true}
	collaborators, err := s.repos.TaskWork.ListCollaborators(ctx, accountID, taskID)
	if err != nil {
		return targets
	}
	for _, collaborator := range collaborators {
		if !seen[collaborator.UserID] {
			seen[collaborator.UserID] = true
			targets = append(targets, collaborator.UserID)
		}
	}
	return targets
}
