package service

import (
	"context"
	"log"
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
	if err := s.repos.Task.Create(ctx, task); err != nil {
		return err
	}

	// Create reminder if requested (only if task has a due date)
	if task.DueAt != nil && task.ReminderMinutes != nil && *task.ReminderMinutes > 0 {
		reminderAt := task.DueAt.Add(-time.Duration(*task.ReminderMinutes) * time.Minute)
		if reminderAt.After(time.Now()) {
			rem := &domain.TaskReminder{
				TaskID:     task.ID,
				AccountID:  task.AccountID,
				AssignedTo: task.AssignedTo,
				ReminderAt: reminderAt,
			}
			if err := s.repos.Task.CreateReminder(ctx, rem); err != nil {
				log.Printf("[TASK] Warning: failed to create reminder for task %s: %v", task.ID, err)
			}
		}
	}

	// Broadcast
	if s.hub != nil {
		s.hub.BroadcastToAccount(task.AccountID, ws.EventTaskUpdate, map[string]interface{}{
			"action": "created",
			"task":   task,
		})
	}

	return nil
}

func (s *TaskService) Update(ctx context.Context, task *domain.Task) error {
	if err := s.repos.Task.Update(ctx, task); err != nil {
		return err
	}

	// Recreate reminder if reminder_minutes changed (only if task has a due date)
	_ = s.repos.Task.DeleteRemindersByTask(ctx, task.ID)
	if task.DueAt != nil && task.ReminderMinutes != nil && *task.ReminderMinutes > 0 {
		reminderAt := task.DueAt.Add(-time.Duration(*task.ReminderMinutes) * time.Minute)
		if reminderAt.After(time.Now()) {
			rem := &domain.TaskReminder{
				TaskID:     task.ID,
				AccountID:  task.AccountID,
				AssignedTo: task.AssignedTo,
				ReminderAt: reminderAt,
			}
			_ = s.repos.Task.CreateReminder(ctx, rem)
		}
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(task.AccountID, ws.EventTaskUpdate, map[string]interface{}{
			"action": "updated",
			"task":   task,
		})
	}

	return nil
}

func (s *TaskService) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_ = s.repos.Task.DeleteRemindersByTask(ctx, id)
	if err := s.repos.Task.Delete(ctx, id, accountID); err != nil {
		return err
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "deleted",
			"task_id": id.String(),
		})
	}

	return nil
}

func (s *TaskService) Complete(ctx context.Context, id, accountID, completedBy uuid.UUID) error {
	if err := s.repos.Task.MarkCompleted(ctx, id, accountID, completedBy); err != nil {
		return err
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "completed",
			"task_id": id.String(),
		})
	}

	return nil
}

func (s *TaskService) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Task, error) {
	return s.repos.Task.GetByID(ctx, id, accountID)
}

func (s *TaskService) GetByAccount(ctx context.Context, accountID uuid.UUID, filters map[string]string, limit, offset int) ([]*domain.Task, int, error) {
	return s.repos.Task.GetByAccount(ctx, accountID, filters, limit, offset)
}

func (s *TaskService) GetCalendarRange(ctx context.Context, accountID uuid.UUID, from, to time.Time, assignedTo *uuid.UUID) ([]*domain.Task, error) {
	return s.repos.Task.GetCalendarRange(ctx, accountID, from, to, assignedTo)
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
			s.hub.BroadcastToAccount(t.AccountID, ws.EventTaskOverdue, map[string]interface{}{
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
			s.hub.BroadcastToAccount(rem.AccountID, ws.EventTaskReminder, map[string]interface{}{
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
