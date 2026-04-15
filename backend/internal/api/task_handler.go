package api

import (
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
)

// handleCreateTask creates a new task
func (s *Server) handleCreateTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Title           string     `json:"title"`
		Description     string     `json:"description"`
		Type            string     `json:"type"`
		DueAt           string     `json:"due_at"`
		DueEndAt        *string    `json:"due_end_at"`
		Priority        string     `json:"priority"`
		AssignedTo      string     `json:"assigned_to"`
		LeadID          *string    `json:"lead_id"`
		EventID         *string    `json:"event_id"`
		ProgramID       *string    `json:"program_id"`
		ContactID       *string    `json:"contact_id"`
		ListID          *string    `json:"list_id"`
		RecurrenceRule  string     `json:"recurrence_rule"`
		ReminderMinutes *int       `json:"reminder_minutes"`
		Notes           string     `json:"notes"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.Title == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Title is required"})
	}

	var dueAt *time.Time
	if req.DueAt != "" {
		t, err := time.Parse(time.RFC3339, req.DueAt)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid due_at format, use RFC3339"})
		}
		dueAt = &t
	}

	assignedTo := userID
	if req.AssignedTo != "" {
		parsed, err := uuid.Parse(req.AssignedTo)
		if err == nil {
			assignedTo = parsed
		}
	}

	task := &domain.Task{
		AccountID:      accountID,
		CreatedBy:      userID,
		AssignedTo:     assignedTo,
		Title:          req.Title,
		Description:    req.Description,
		Type:           req.Type,
		DueAt:          dueAt,
		Priority:       req.Priority,
		Status:         domain.TaskStatusPending,
		RecurrenceRule: req.RecurrenceRule,
		ReminderMinutes: req.ReminderMinutes,
		Notes:          req.Notes,
	}

	if req.Type == "" {
		task.Type = domain.TaskTypeReminder
	}
	if req.Priority == "" {
		task.Priority = domain.TaskPriorityMedium
	}

	if req.DueEndAt != nil && *req.DueEndAt != "" {
		t, err := time.Parse(time.RFC3339, *req.DueEndAt)
		if err == nil {
			task.DueEndAt = &t
		}
	}

	if req.LeadID != nil && *req.LeadID != "" {
		id, _ := uuid.Parse(*req.LeadID)
		task.LeadID = &id
	}
	if req.EventID != nil && *req.EventID != "" {
		id, _ := uuid.Parse(*req.EventID)
		task.EventID = &id
	}
	if req.ProgramID != nil && *req.ProgramID != "" {
		id, _ := uuid.Parse(*req.ProgramID)
		task.ProgramID = &id
	}
	if req.ContactID != nil && *req.ContactID != "" {
		id, _ := uuid.Parse(*req.ContactID)
		task.ContactID = &id
	}
	if req.ListID != nil && *req.ListID != "" {
		id, _ := uuid.Parse(*req.ListID)
		task.ListID = &id
	}

	// Auto-link contact_id from lead if not explicitly set
	if task.LeadID != nil && task.ContactID == nil {
		if lead, err := s.services.Lead.GetByID(c.Context(), *task.LeadID); err == nil && lead != nil && lead.AccountID == accountID && lead.ContactID != nil {
			task.ContactID = lead.ContactID
		}
	}
	// Auto-link lead if task created directly on a contact
	if task.ContactID != nil && task.LeadID == nil {
		if lead, err := s.repos.Lead.GetByContactID(c.Context(), *task.ContactID); err == nil && lead != nil {
			task.LeadID = &lead.ID
		}
	}

	if err := s.services.Task.Create(c.Context(), task); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create task"})
	}

	// Auto-create observation (interaction) when task is linked to a lead or contact
	if task.LeadID != nil || task.ContactID != nil {
		typeLabels := map[string]string{
			domain.TaskTypeCall:     "una llamada",
			domain.TaskTypeWhatsApp: "un mensaje de WhatsApp",
			domain.TaskTypeMeeting:  "una reunión",
			domain.TaskTypeReminder: "un recordatorio",
		}
		label := typeLabels[task.Type]
		if label == "" {
			label = "una tarea"
		}
		dateStr := "sin fecha definida"
		if task.DueAt != nil {
			dueLocal := *task.DueAt
			if loc, err := time.LoadLocation("America/Lima"); err == nil {
				dueLocal = task.DueAt.In(loc)
			}
			dateStr = fmt.Sprintf("para el %s a las %s", dueLocal.Format("02/01/2006"), dueLocal.Format("15:04"))
		}
		obsText := fmt.Sprintf("📋 Se agendó %s %s\n%s", label, dateStr, task.Title)
		if task.Description != "" {
			obsText += fmt.Sprintf("\nDetalle: %s", task.Description)
		}
		interaction := &domain.Interaction{
			AccountID: accountID,
			Type:      domain.InteractionTypeNote,
			Notes:     &obsText,
			LeadID:    task.LeadID,
			ContactID: task.ContactID,
			CreatedBy: &userID,
		}
		if err := s.services.Interaction.LogInteraction(c.Context(), interaction); err != nil {
			log.Printf("[TASK] Failed to auto-create observation for task %s: %v", task.ID, err)
		} else {
			if task.LeadID != nil {
				s.invalidateLeadDetailCache(*task.LeadID)
			}
			if s.hub != nil {
				leadIDStr := ""
				if task.LeadID != nil {
					leadIDStr = task.LeadID.String()
				}
				s.hub.BroadcastToAccount(accountID, ws.EventInteractionUpdate, map[string]interface{}{
					"action":  "created",
					"lead_id": leadIDStr,
				})
			}
		}
	}

	// Re-read to get joined names
	full, err := s.services.Task.GetByID(c.Context(), task.ID, accountID)
	if err != nil {
		return c.JSON(fiber.Map{"success": true, "task": task})
	}

	s.invalidateTasksCache(accountID)
	return c.JSON(fiber.Map{"success": true, "task": full})
}

// handleGetTasks lists tasks with filters
func (s *Server) handleGetTasks(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	limit, _ := strconv.Atoi(c.Query("limit", "50"))
	offset, _ := strconv.Atoi(c.Query("offset", "0"))
	if limit > 200 {
		limit = 200
	}

	filters := map[string]string{}
	for _, key := range []string{"status", "type", "assigned_to", "lead_id", "event_id", "program_id", "contact_id", "list_id", "starred", "from", "to", "search"} {
		if v := c.Query(key); v != "" {
			filters[key] = v
		}
	}

	// Redis cache for default load (no filters) — 30s TTL
	isDefaultTasksLoad := len(filters) == 0
	tasksCacheKey := ""
	if isDefaultTasksLoad && s.cache != nil {
		tasksCacheKey = fmt.Sprintf("tasks:%s:%d:%d", accountID.String(), limit, offset)
		if cached, err := s.cache.Get(c.Context(), tasksCacheKey); err == nil && cached != nil {
			c.Set("Content-Type", "application/json")
			return c.Send(cached)
		}
	}

	tasks, total, err := s.services.Task.GetByAccount(c.Context(), accountID, filters, limit, offset)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch tasks"})
	}

	result := fiber.Map{
		"success": true,
		"tasks":   tasks,
		"total":   total,
		"limit":   limit,
		"offset":  offset,
	}

	if tasksCacheKey != "" && s.cache != nil {
		if data, err := json.Marshal(result); err == nil {
			_ = s.cache.Set(c.Context(), tasksCacheKey, data, 30*time.Second)
		}
	}

	return c.JSON(result)
}

// handleGetTask returns a single task
func (s *Server) handleGetTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	task, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}

	return c.JSON(fiber.Map{"success": true, "task": task})
}

// handleUpdateTask updates a task
func (s *Server) handleUpdateTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	existing, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}

	var req struct {
		Title           *string `json:"title"`
		Description     *string `json:"description"`
		Type            *string `json:"type"`
		DueAt           *string `json:"due_at"`
		DueEndAt        *string `json:"due_end_at"`
		Priority        *string `json:"priority"`
		Status          *string `json:"status"`
		AssignedTo      *string `json:"assigned_to"`
		LeadID          *string `json:"lead_id"`
		EventID         *string `json:"event_id"`
		ProgramID       *string `json:"program_id"`
		ContactID       *string `json:"contact_id"`
		ListID          *string `json:"list_id"`
		RecurrenceRule  *string `json:"recurrence_rule"`
		ReminderMinutes *int    `json:"reminder_minutes"`
		Notes           *string `json:"notes"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if req.Title != nil {
		existing.Title = *req.Title
	}
	if req.Description != nil {
		existing.Description = *req.Description
	}
	if req.Type != nil {
		existing.Type = *req.Type
	}
	if req.DueAt != nil {
		if *req.DueAt == "" {
			existing.DueAt = nil
		} else {
			t, err := time.Parse(time.RFC3339, *req.DueAt)
			if err == nil {
				existing.DueAt = &t
			}
		}
	}
	if req.DueEndAt != nil {
		if *req.DueEndAt == "" {
			existing.DueEndAt = nil
		} else {
			t, err := time.Parse(time.RFC3339, *req.DueEndAt)
			if err == nil {
				existing.DueEndAt = &t
			}
		}
	}
	if req.Priority != nil {
		existing.Priority = *req.Priority
	}
	if req.Status != nil {
		existing.Status = *req.Status
	}
	if req.AssignedTo != nil {
		id, err := uuid.Parse(*req.AssignedTo)
		if err == nil {
			existing.AssignedTo = id
		}
	}
	if req.RecurrenceRule != nil {
		existing.RecurrenceRule = *req.RecurrenceRule
	}
	if req.ReminderMinutes != nil {
		existing.ReminderMinutes = req.ReminderMinutes
	}
	if req.Notes != nil {
		existing.Notes = *req.Notes
	}

	// Handle nullable FKs
	if req.LeadID != nil {
		if *req.LeadID == "" {
			existing.LeadID = nil
		} else {
			id, _ := uuid.Parse(*req.LeadID)
			existing.LeadID = &id
		}
	}
	if req.EventID != nil {
		if *req.EventID == "" {
			existing.EventID = nil
		} else {
			id, _ := uuid.Parse(*req.EventID)
			existing.EventID = &id
		}
	}
	if req.ProgramID != nil {
		if *req.ProgramID == "" {
			existing.ProgramID = nil
		} else {
			id, _ := uuid.Parse(*req.ProgramID)
			existing.ProgramID = &id
		}
	}
	if req.ContactID != nil {
		if *req.ContactID == "" {
			existing.ContactID = nil
		} else {
			id, _ := uuid.Parse(*req.ContactID)
			existing.ContactID = &id
		}
	}
	if req.ListID != nil {
		if *req.ListID == "" {
			existing.ListID = nil
		} else {
			id, _ := uuid.Parse(*req.ListID)
			existing.ListID = &id
		}
	}

	// Auto-link contact_id from lead if not explicitly set
	if existing.LeadID != nil && existing.ContactID == nil {
		if lead, err := s.services.Lead.GetByID(c.Context(), *existing.LeadID); err == nil && lead != nil && lead.AccountID == accountID && lead.ContactID != nil {
			existing.ContactID = lead.ContactID
		}
	}
	if existing.ContactID != nil && existing.LeadID == nil {
		if lead, err := s.repos.Lead.GetByContactID(c.Context(), *existing.ContactID); err == nil && lead != nil {
			existing.LeadID = &lead.ID
		}
	}

	if err := s.services.Task.Update(c.Context(), existing); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update task"})
	}

	full, err := s.services.Task.GetByID(c.Context(), existing.ID, accountID)
	if err != nil {
		s.invalidateTasksCache(accountID)
		return c.JSON(fiber.Map{"success": true, "task": existing})
	}

	s.invalidateTasksCache(accountID)
	return c.JSON(fiber.Map{"success": true, "task": full})
}

// handleDeleteTask deletes a task
func (s *Server) handleDeleteTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	if err := s.services.Task.Delete(c.Context(), taskID, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to delete task"})
	}

	s.invalidateTasksCache(accountID)
	return c.JSON(fiber.Map{"success": true})
}

// handleCompleteTask marks a task as completed
func (s *Server) handleCompleteTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	if err := s.services.Task.Complete(c.Context(), taskID, accountID, userID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to complete task"})
	}

	s.invalidateTasksCache(accountID)
	return c.JSON(fiber.Map{"success": true})
}

// handleGetTasksCalendar returns tasks for a date range (calendar view)
func (s *Server) handleGetTasksCalendar(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	fromStr := c.Query("from")
	toStr := c.Query("to")
	if fromStr == "" || toStr == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "from and to are required"})
	}

	from, err := time.Parse(time.RFC3339, fromStr)
	if err != nil {
		from, err = time.Parse("2006-01-02", fromStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid from date"})
		}
	}

	to, err := time.Parse(time.RFC3339, toStr)
	if err != nil {
		to, err = time.Parse("2006-01-02", toStr)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid to date"})
		}
		// End of day
		to = to.Add(24*time.Hour - time.Second)
	}

	var assignedTo *uuid.UUID
	if v := c.Query("assigned_to"); v != "" {
		id, err := uuid.Parse(v)
		if err == nil {
			assignedTo = &id
		}
	}

	tasks, err := s.services.Task.GetCalendarRange(c.Context(), accountID, from, to, assignedTo)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch calendar tasks"})
	}

	return c.JSON(fiber.Map{"success": true, "tasks": tasks})
}

// handleGetTaskStats returns task counts by status
func (s *Server) handleGetTaskStats(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	// Allow querying stats for another user (admin feature)
	if v := c.Query("assigned_to"); v != "" {
		id, err := uuid.Parse(v)
		if err == nil {
			userID = id
		}
	}

	stats, err := s.services.Task.GetStats(c.Context(), accountID, userID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch stats"})
	}

	return c.JSON(fiber.Map{"success": true, "stats": stats})
}

// ─── Subtask handlers ──────────────────────────────────

func (s *Server) handleGetSubtasks(c *fiber.Ctx) error {
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	subs, err := s.repos.Task.GetSubtasksByTask(c.Context(), taskID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch subtasks"})
	}

	return c.JSON(fiber.Map{"success": true, "subtasks": subs})
}

func (s *Server) handleCreateSubtask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	var req struct {
		Title string `json:"title"`
	}
	if err := c.BodyParser(&req); err != nil || req.Title == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Title is required"})
	}

	sub := &domain.Subtask{
		TaskID:    taskID,
		AccountID: accountID,
		Title:     req.Title,
	}

	if err := s.repos.Task.CreateSubtask(c.Context(), sub); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create subtask"})
	}

	// Broadcast task update so subtask counts refresh
	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "subtask_created",
			"task_id": taskID.String(),
		})
	}

	return c.JSON(fiber.Map{"success": true, "subtask": sub})
}

func (s *Server) handleUpdateSubtask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	subID, err := uuid.Parse(c.Params("subId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid subtask ID"})
	}

	var req struct {
		Title     *string `json:"title"`
		Completed *bool   `json:"completed"`
		SortOrder *int    `json:"sort_order"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	// We need current state — build a minimal subtask
	sub := &domain.Subtask{
		ID:        subID,
		AccountID: accountID,
	}

	if req.Title != nil {
		sub.Title = *req.Title
	}
	if req.Completed != nil {
		sub.Completed = *req.Completed
		if *req.Completed {
			now := time.Now()
			sub.CompletedAt = &now
		}
	}
	if req.SortOrder != nil {
		sub.SortOrder = *req.SortOrder
	}

	if err := s.repos.Task.UpdateSubtask(c.Context(), sub); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update subtask"})
	}

	return c.JSON(fiber.Map{"success": true, "subtask": sub})
}

func (s *Server) handleDeleteSubtask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	subID, err := uuid.Parse(c.Params("subId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid subtask ID"})
	}

	if err := s.repos.Task.DeleteSubtask(c.Context(), subID, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to delete subtask"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "subtask_deleted",
			"task_id": c.Params("id"),
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleToggleSubtask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	subID, err := uuid.Parse(c.Params("subId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid subtask ID"})
	}

	sub, err := s.repos.Task.ToggleSubtask(c.Context(), subID, accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to toggle subtask"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "subtask_toggled",
			"task_id": sub.TaskID.String(),
		})
	}

	return c.JSON(fiber.Map{"success": true, "subtask": sub})
}

// ─── Task List handlers ──────────────────────────────────

func (s *Server) handleGetTaskLists(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	lists, err := s.repos.Task.GetListsByAccount(c.Context(), accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch task lists"})
	}

	return c.JSON(fiber.Map{"success": true, "lists": lists})
}

func (s *Server) handleCreateTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Name  string `json:"name"`
		Color string `json:"color"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}

	list := &domain.TaskList{
		AccountID: accountID,
		Name:      req.Name,
		Color:     req.Color,
		CreatedBy: userID,
	}

	if err := s.repos.Task.CreateList(c.Context(), list); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create task list"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action": "list_created",
		})
	}

	return c.JSON(fiber.Map{"success": true, "list": list})
}

func (s *Server) handleUpdateTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid list ID"})
	}

	var req struct {
		Name      *string `json:"name"`
		Color     *string `json:"color"`
		SortOrder *int    `json:"sort_order"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if err := s.repos.Task.UpdateList(c.Context(), listID, accountID, req.Name, req.Color, req.SortOrder); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update task list"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action": "list_updated",
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid list ID"})
	}

	if err := s.repos.Task.DeleteList(c.Context(), listID, accountID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to delete task list"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccount(accountID, ws.EventTaskUpdate, map[string]interface{}{
			"action": "list_deleted",
		})
	}

	return c.JSON(fiber.Map{"success": true})
}

// handleToggleStar toggles the starred status of a task
func (s *Server) handleToggleStar(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	starred, err := s.repos.Task.ToggleStar(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to toggle star"})
	}

	return c.JSON(fiber.Map{"success": true, "starred": starred})
}

func (s *Server) handleReorderLists(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		ListIDs []string `json:"list_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if len(req.ListIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "list_ids required"})
	}

	uuids := make([]uuid.UUID, 0, len(req.ListIDs))
	for _, id := range req.ListIDs {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid list ID: " + id})
		}
		uuids = append(uuids, parsed)
	}

	if err := s.repos.Task.ReorderLists(c.Context(), accountID, uuids); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to reorder lists"})
	}

	return c.JSON(fiber.Map{"success": true})
}

// handleReorderTasks reorders tasks by their IDs
func (s *Server) handleReorderTasks(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)

	var req struct {
		TaskIDs []string `json:"task_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}

	if len(req.TaskIDs) == 0 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "task_ids required"})
	}

	uuids := make([]uuid.UUID, 0, len(req.TaskIDs))
	for _, id := range req.TaskIDs {
		parsed, err := uuid.Parse(id)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID: " + id})
		}
		uuids = append(uuids, parsed)
	}

	if err := s.repos.Task.ReorderTasks(c.Context(), accountID, uuids); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to reorder tasks"})
	}

	return c.JSON(fiber.Map{"success": true})
}
