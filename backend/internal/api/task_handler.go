package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

func validTaskType(value string) bool {
	switch value {
	case domain.TaskTypeCall, domain.TaskTypeWhatsApp, domain.TaskTypeMeeting, domain.TaskTypeReminder:
		return true
	}
	return false
}

func validTaskPriority(value string) bool {
	switch value {
	case domain.TaskPriorityLow, domain.TaskPriorityMedium, domain.TaskPriorityHigh, domain.TaskPriorityUrgent:
		return true
	}
	return false
}

func validTaskRecurrenceRule(value string) bool {
	switch value {
	case "", "daily", "weekdays", "weekly", "monthly":
		return true
	default:
		return false
	}
}

func legacyTaskStatus(category string) string {
	switch category {
	case domain.TaskStatusCategoryDone:
		return domain.TaskStatusCompleted
	case domain.TaskStatusCategoryCancelled:
		return domain.TaskStatusCancelled
	default:
		return domain.TaskStatusPending
	}
}

func (s *Server) taskReferenceBelongsToAccount(c *fiber.Ctx, accountID, id uuid.UUID, kind string) (bool, error) {
	var table string
	switch kind {
	case "lead":
		table = "leads"
	case "event":
		table = "events"
	case "program":
		table = "programs"
	case "contact":
		table = "contacts"
	case "list":
		table = "task_lists"
	default:
		return false, fmt.Errorf("unsupported task reference")
	}
	var valid bool
	err := s.repos.DB().QueryRow(c.Context(), fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE account_id=$1 AND id=$2)`, table), accountID, id).Scan(&valid)
	return valid, err
}

func (s *Server) validateTaskProgramMutation(c *fiber.Ctx, accountID, programID uuid.UUID) (bool, error) {
	var belongs bool
	if err := s.repos.DB().QueryRow(c.Context(), `
		SELECT EXISTS(SELECT 1 FROM programs WHERE account_id=$1 AND id=$2)
	`, accountID, programID).Scan(&belongs); err != nil {
		return true, c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el programa"})
	}
	if !belongs {
		return true, c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "El programa no pertenece a esta cuenta"})
	}
	return s.rejectMigratedProgramMutation(c, accountID, programID)
}

// handleCreateTask creates a new task
func (s *Server) handleCreateTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)

	var req struct {
		Title           string   `json:"title"`
		Description     string   `json:"description"`
		Type            string   `json:"type"`
		DueAt           string   `json:"due_at"`
		StartAt         string   `json:"start_at"`
		DueEndAt        *string  `json:"due_end_at"`
		IsAllDay        bool     `json:"is_all_day"`
		Priority        string   `json:"priority"`
		StatusID        *string  `json:"status_id"`
		AssignedTo      string   `json:"assigned_to"`
		LeadID          *string  `json:"lead_id"`
		EventID         *string  `json:"event_id"`
		ProgramID       *string  `json:"program_id"`
		ContactID       *string  `json:"contact_id"`
		ListID          *string  `json:"list_id"`
		ParentTaskID    *string  `json:"parent_task_id"`
		Progress        int      `json:"progress"`
		IsMilestone     bool     `json:"is_milestone"`
		CollaboratorIDs []string `json:"collaborator_ids"`
		RecurrenceRule  string   `json:"recurrence_rule"`
		ReminderMinutes *int     `json:"reminder_minutes"`
		Notes           string   `json:"notes"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	req.Title = strings.TrimSpace(req.Title)
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
	var startAt *time.Time
	if req.StartAt != "" {
		t, err := time.Parse(time.RFC3339, req.StartAt)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid start_at format, use RFC3339"})
		}
		startAt = &t
	}
	if startAt != nil && dueAt != nil && dueAt.Before(*startAt) {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "La fecha final no puede ser anterior al inicio"})
	}

	assignedTo := userID
	if req.AssignedTo != "" {
		parsed, err := uuid.Parse(req.AssignedTo)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Responsable inválido"})
		}
		valid, validationErr := s.repos.TaskWork.UserBelongsToAccount(c.Context(), accountID, parsed)
		if validationErr != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "No se pudo validar el responsable"})
		}
		if !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El responsable no pertenece a esta cuenta"})
		}
		assignedTo = parsed
	}

	task := &domain.Task{
		AccountID:       accountID,
		CreatedBy:       userID,
		AssignedTo:      assignedTo,
		Title:           req.Title,
		Description:     req.Description,
		Type:            req.Type,
		StartAt:         startAt,
		DueAt:           dueAt,
		IsAllDay:        req.IsAllDay,
		Priority:        req.Priority,
		Status:          domain.TaskStatusPending,
		RecurrenceRule:  req.RecurrenceRule,
		ReminderMinutes: req.ReminderMinutes,
		Notes:           req.Notes,
		Progress:        req.Progress,
		IsMilestone:     req.IsMilestone,
	}

	if req.Type == "" {
		task.Type = domain.TaskTypeReminder
	}
	if req.Priority == "" {
		task.Priority = domain.TaskPriorityMedium
	}
	if !validTaskType(task.Type) || !validTaskPriority(task.Priority) || task.Progress < 0 || task.Progress > 100 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tipo, prioridad o progreso inválido"})
	}
	if !validTaskRecurrenceRule(task.RecurrenceRule) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Recurrencia inválida"})
	}

	if req.DueEndAt != nil && *req.DueEndAt != "" {
		t, err := time.Parse(time.RFC3339, *req.DueEndAt)
		if err == nil {
			task.DueEndAt = &t
		}
	}

	if req.LeadID != nil && *req.LeadID != "" {
		id, parseErr := uuid.Parse(*req.LeadID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lead inválido"})
		}
		valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "lead")
		if validationErr != nil || !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El lead no pertenece a esta cuenta"})
		}
		task.LeadID = &id
	}
	if req.EventID != nil && *req.EventID != "" {
		id, parseErr := uuid.Parse(*req.EventID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Evento inválido"})
		}
		valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "event")
		if validationErr != nil || !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El evento no pertenece a esta cuenta"})
		}
		task.EventID = &id
	}
	if req.ProgramID != nil && *req.ProgramID != "" {
		id, err := uuid.Parse(*req.ProgramID)
		if err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
		}
		task.ProgramID = &id
	}
	if req.ContactID != nil && *req.ContactID != "" {
		id, parseErr := uuid.Parse(*req.ContactID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Contacto inválido"})
		}
		valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "contact")
		if validationErr != nil || !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El contacto no pertenece a esta cuenta"})
		}
		task.ContactID = &id
	}
	if req.ListID != nil && *req.ListID != "" {
		id, parseErr := uuid.Parse(*req.ListID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
		}
		valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "list")
		if validationErr != nil || !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "La lista no pertenece a esta cuenta"})
		}
		task.ListID = &id
	}
	if req.ParentTaskID != nil && *req.ParentTaskID != "" {
		id, parseErr := uuid.Parse(*req.ParentTaskID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea padre inválida"})
		}
		parent, parentErr := s.services.Task.GetByID(c.Context(), id, accountID)
		if parentErr != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "Tarea padre no encontrada"})
		}
		if parent.ParentTaskID != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "Sólo se permite un nivel de subtareas"})
		}
		task.ParentTaskID = &id
		if task.ListID == nil {
			task.ListID = parent.ListID
		}
	}
	var requestedStatusID *uuid.UUID
	if req.StatusID != nil && *req.StatusID != "" {
		id, parseErr := uuid.Parse(*req.StatusID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
		}
		requestedStatusID = &id
	}
	resolvedStatus, resolveErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, task.ListID, requestedStatusID, domain.TaskStatusCategoryNotStarted)
	if resolveErr != nil {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "El estado no pertenece al flujo de la lista"})
	}
	task.StatusID = &resolvedStatus.ID
	task.Status = legacyTaskStatus(resolvedStatus.Category)

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
	if task.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *task.ProgramID); handled {
			return guardErr
		}
	}

	collaboratorIDs := make([]uuid.UUID, 0, len(req.CollaboratorIDs))
	if len(req.CollaboratorIDs) > 0 {
		seenCollaborators := make(map[uuid.UUID]struct{}, len(req.CollaboratorIDs))
		for _, raw := range req.CollaboratorIDs {
			id, parseErr := uuid.Parse(raw)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Colaborador inválido"})
			}
			if _, exists := seenCollaborators[id]; exists {
				continue
			}
			seenCollaborators[id] = struct{}{}
			if id == assignedTo {
				continue
			}
			valid, validationErr := s.repos.TaskWork.UserBelongsToAccount(c.Context(), accountID, id)
			if validationErr != nil || !valid {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "Uno de los colaboradores no pertenece a la cuenta"})
			}
			collaboratorIDs = append(collaboratorIDs, id)
		}
	}
	if err := s.services.Task.Create(c.Context(), task); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create task"})
	}
	if len(collaboratorIDs) > 0 {
		if err := s.repos.TaskWork.SetCollaborators(c.Context(), accountID, task.ID, userID, collaboratorIDs); err != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "Uno de los colaboradores no pertenece a la cuenta"})
		}
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, task.ID, &userID, "created", fiber.Map{"status_id": task.StatusID})

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
				s.invalidateLeadDetailCache(accountID, *task.LeadID)
			}
			if s.hub != nil {
				leadIDStr := ""
				if task.LeadID != nil {
					leadIDStr = task.LeadID.String()
				}
				s.hub.BroadcastToAccountWithPermission(accountID, domain.PermLeads, ws.EventInteractionUpdate, map[string]interface{}{
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
	for _, key := range []string{"status", "type", "assigned_to", "lead_id", "event_id", "program_id", "contact_id", "list_id", "folder_id", "parent_task_id", "include_subtasks", "starred", "from", "to", "search", "deleted"} {
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
	task.Collaborators, _ = s.repos.TaskWork.ListCollaborators(c.Context(), accountID, taskID)

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
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
	}
	wasDone := existing.Status == domain.TaskStatusCompleted || (existing.StatusDetail != nil && existing.StatusDetail.Category == domain.TaskStatusCategoryDone)

	var req struct {
		Title           *string `json:"title"`
		Description     *string `json:"description"`
		Type            *string `json:"type"`
		StartAt         *string `json:"start_at"`
		DueAt           *string `json:"due_at"`
		DueEndAt        *string `json:"due_end_at"`
		IsAllDay        *bool   `json:"is_all_day"`
		Priority        *string `json:"priority"`
		Status          *string `json:"status"`
		StatusID        *string `json:"status_id"`
		AssignedTo      *string `json:"assigned_to"`
		LeadID          *string `json:"lead_id"`
		EventID         *string `json:"event_id"`
		ProgramID       *string `json:"program_id"`
		ContactID       *string `json:"contact_id"`
		ListID          *string `json:"list_id"`
		ParentTaskID    *string `json:"parent_task_id"`
		Progress        *int    `json:"progress"`
		IsMilestone     *bool   `json:"is_milestone"`
		Version         *int64  `json:"version"`
		RecurrenceRule  *string `json:"recurrence_rule"`
		ReminderMinutes *int    `json:"reminder_minutes"`
		Notes           *string `json:"notes"`
	}

	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Version != nil && *req.Version != existing.Version {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La tarea cambió en otra sesión", "code": "version_conflict", "current_version": existing.Version})
	}

	if req.Title != nil {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El título es obligatorio"})
		}
		existing.Title = title
	}
	if req.Description != nil {
		existing.Description = *req.Description
	}
	if req.Type != nil {
		if !validTaskType(*req.Type) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tipo inválido"})
		}
		existing.Type = *req.Type
	}
	if req.StartAt != nil {
		if *req.StartAt == "" {
			existing.StartAt = nil
		} else {
			t, parseErr := time.Parse(time.RFC3339, *req.StartAt)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha de inicio inválida"})
			}
			existing.StartAt = &t
		}
	}
	if req.DueAt != nil {
		if *req.DueAt == "" {
			existing.DueAt = nil
		} else {
			t, err := time.Parse(time.RFC3339, *req.DueAt)
			if err != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha límite inválida"})
			}
			existing.DueAt = &t
		}
	}
	if existing.StartAt != nil && existing.DueAt != nil && existing.DueAt.Before(*existing.StartAt) {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "La fecha final no puede ser anterior al inicio"})
	}
	if req.IsAllDay != nil {
		existing.IsAllDay = *req.IsAllDay
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
		if !validTaskPriority(*req.Priority) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Prioridad inválida"})
		}
		existing.Priority = *req.Priority
	}
	if req.Status != nil {
		if *req.Status != domain.TaskStatusPending && *req.Status != domain.TaskStatusCompleted && *req.Status != domain.TaskStatusCancelled && *req.Status != domain.TaskStatusOverdue {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
		}
		existing.Status = *req.Status
	}
	if req.AssignedTo != nil {
		id, err := uuid.Parse(*req.AssignedTo)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Responsable inválido"})
		}
		valid, validationErr := s.repos.TaskWork.UserBelongsToAccount(c.Context(), accountID, id)
		if validationErr != nil || !valid {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El responsable no pertenece a esta cuenta"})
		}
		existing.AssignedTo = id
	}
	if req.Progress != nil {
		if *req.Progress < 0 || *req.Progress > 100 {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Progreso inválido"})
		}
		existing.Progress = *req.Progress
	}
	if req.IsMilestone != nil {
		existing.IsMilestone = *req.IsMilestone
	}
	if req.RecurrenceRule != nil {
		if !validTaskRecurrenceRule(*req.RecurrenceRule) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Recurrencia inválida"})
		}
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
			id, parseErr := uuid.Parse(*req.LeadID)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lead inválido"})
			}
			valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "lead")
			if validationErr != nil || !valid {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "El lead no pertenece a esta cuenta"})
			}
			existing.LeadID = &id
		}
	}
	if req.EventID != nil {
		if *req.EventID == "" {
			existing.EventID = nil
		} else {
			id, parseErr := uuid.Parse(*req.EventID)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Evento inválido"})
			}
			valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "event")
			if validationErr != nil || !valid {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "El evento no pertenece a esta cuenta"})
			}
			existing.EventID = &id
		}
	}
	if req.ProgramID != nil {
		if *req.ProgramID == "" {
			existing.ProgramID = nil
		} else {
			id, err := uuid.Parse(*req.ProgramID)
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Invalid program ID"})
			}
			existing.ProgramID = &id
		}
	}
	if req.ContactID != nil {
		if *req.ContactID == "" {
			existing.ContactID = nil
		} else {
			id, parseErr := uuid.Parse(*req.ContactID)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Contacto inválido"})
			}
			valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "contact")
			if validationErr != nil || !valid {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "El contacto no pertenece a esta cuenta"})
			}
			existing.ContactID = &id
		}
	}
	if req.ListID != nil {
		if *req.ListID == "" {
			existing.ListID = nil
		} else {
			id, parseErr := uuid.Parse(*req.ListID)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
			}
			valid, validationErr := s.taskReferenceBelongsToAccount(c, accountID, id, "list")
			if validationErr != nil || !valid {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "La lista no pertenece a esta cuenta"})
			}
			existing.ListID = &id
		}
	}
	if req.ParentTaskID != nil {
		if *req.ParentTaskID == "" {
			existing.ParentTaskID = nil
		} else {
			id, parseErr := uuid.Parse(*req.ParentTaskID)
			if parseErr != nil || id == taskID {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea padre inválida"})
			}
			parent, parentErr := s.services.Task.GetByID(c.Context(), id, accountID)
			if parentErr != nil || parent.ParentTaskID != nil {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "Sólo se permite un nivel de subtareas"})
			}
			existing.ParentTaskID = &id
		}
	}
	if req.StatusID != nil {
		var requested *uuid.UUID
		if *req.StatusID != "" {
			id, parseErr := uuid.Parse(*req.StatusID)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
			}
			requested = &id
		}
		status, resolveErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, existing.ListID, requested, domain.TaskStatusCategoryNotStarted)
		if resolveErr != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El estado no pertenece al flujo de la lista"})
		}
		existing.StatusID = &status.ID
		existing.Status = legacyTaskStatus(status.Category)
		if status.Category == domain.TaskStatusCategoryDone {
			now := time.Now()
			existing.CompletedAt = &now
			uid := c.Locals("user_id").(uuid.UUID)
			existing.CompletedBy = &uid
			existing.Progress = 100
		} else {
			existing.CompletedAt = nil
			existing.CompletedBy = nil
			if wasDone && existing.Progress == 100 && req.Progress == nil {
				existing.Progress = 0
			}
		}
	} else if req.Status != nil {
		category := domain.TaskStatusCategoryNotStarted
		if *req.Status == domain.TaskStatusCompleted {
			category = domain.TaskStatusCategoryDone
		} else if *req.Status == domain.TaskStatusCancelled {
			category = domain.TaskStatusCategoryCancelled
		}
		status, resolveErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, existing.ListID, nil, category)
		if resolveErr != nil {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "No se pudo mapear el estado al flujo"})
		}
		existing.StatusID = &status.ID
		existing.Status = legacyTaskStatus(status.Category)
		if category == domain.TaskStatusCategoryDone {
			now := time.Now()
			existing.CompletedAt = &now
			uid := c.Locals("user_id").(uuid.UUID)
			existing.CompletedBy = &uid
			existing.Progress = 100
		} else {
			existing.CompletedAt = nil
			existing.CompletedBy = nil
			if wasDone && existing.Progress == 100 && req.Progress == nil {
				existing.Progress = 0
			}
		}
	} else if req.ListID != nil && existing.StatusDetail != nil {
		if _, resolveErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, existing.ListID, existing.StatusID, existing.StatusDetail.Category); resolveErr != nil {
			mapped, mapErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, existing.ListID, nil, existing.StatusDetail.Category)
			if mapErr != nil {
				return c.Status(422).JSON(fiber.Map{"success": false, "error": "No se pudo mapear el estado al flujo de destino"})
			}
			existing.StatusID = &mapped.ID
			existing.Status = legacyTaskStatus(mapped.Category)
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
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
	}
	if req.StatusID == nil && req.Status == nil && existing.StatusDetail != nil {
		existing.Status = legacyTaskStatus(existing.StatusDetail.Category)
	}

	if err := s.services.Task.Update(c.Context(), existing); err != nil {
		if errors.Is(err, repository.ErrTaskVersionConflict) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La tarea cambió en otra sesión", "code": "version_conflict"})
		}
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update task"})
	}
	actorID := c.Locals("user_id").(uuid.UUID)
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, existing.ID, &actorID, "updated", fiber.Map{"version": existing.Version})

	full, err := s.services.Task.GetByID(c.Context(), existing.ID, accountID)
	if err != nil {
		s.invalidateTasksCache(accountID)
		return c.JSON(fiber.Map{"success": true, "task": existing})
	}
	if !wasDone && full.StatusDetail != nil && full.StatusDetail.Category == domain.TaskStatusCategoryDone {
		s.services.Task.EnsureNextOccurrence(c.Context(), full)
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
	existing, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
	}

	userID := c.Locals("user_id").(uuid.UUID)
	if err := s.repos.TaskWork.SoftDeleteTask(c.Context(), accountID, taskID, userID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to delete task"})
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "archived", fiber.Map{})

	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "deleted", fiber.Map{"task_id": taskID})
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
	existing, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
	}

	if err := s.services.Task.Complete(c.Context(), taskID, accountID, userID); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to complete task"})
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "completed", fiber.Map{})

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
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}

	valid, validationErr := s.repos.TaskWork.TaskBelongsToAccount(c.Context(), accountID, taskID)
	if validationErr != nil || !valid {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}
	children, err := s.repos.TaskWork.ListChildTasks(c.Context(), accountID, taskID)
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to fetch subtasks"})
	}

	subs := make([]*domain.Subtask, 0, len(children))
	for _, child := range children {
		subs = append(subs, legacySubtaskFromTask(child))
	}
	return c.JSON(fiber.Map{"success": true, "subtasks": subs})
}

func legacySubtaskFromTask(task *domain.Task) *domain.Subtask {
	if task == nil || task.ParentTaskID == nil {
		return nil
	}
	completed := task.Status == domain.TaskStatusCompleted || (task.StatusDetail != nil && task.StatusDetail.Category == domain.TaskStatusCategoryDone)
	return &domain.Subtask{ID: task.ID, TaskID: *task.ParentTaskID, AccountID: task.AccountID, Title: task.Title, Completed: completed, CompletedAt: task.CompletedAt, SortOrder: task.SortOrder, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}
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
	parent, parentErr := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if parentErr != nil || parent.ParentTaskID != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Task not found"})
	}
	status, statusErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, parent.ListID, nil, domain.TaskStatusCategoryNotStarted)
	if statusErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to resolve task status"})
	}
	child := &domain.Task{AccountID: accountID, CreatedBy: c.Locals("user_id").(uuid.UUID), AssignedTo: parent.AssignedTo, Title: strings.TrimSpace(req.Title), Type: domain.TaskTypeReminder, Priority: domain.TaskPriorityMedium, Status: domain.TaskStatusPending, StatusID: &status.ID, ListID: parent.ListID, ParentTaskID: &taskID}
	if err := s.services.Task.Create(c.Context(), child); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create subtask"})
	}
	full, loadFullErr := s.services.Task.GetByID(c.Context(), child.ID, accountID)
	if loadFullErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subtask"})
	}
	sub := legacySubtaskFromTask(full)

	// Broadcast task update so subtask counts refresh
	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
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

	parentID, parentErr := uuid.Parse(c.Params("id"))
	if parentErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid task ID"})
	}
	child, loadErr := s.services.Task.GetByID(c.Context(), subID, accountID)
	if loadErr != nil || child.ParentTaskID == nil || *child.ParentTaskID != parentID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Subtask not found"})
	}
	if req.Title != nil {
		title := strings.TrimSpace(*req.Title)
		if title == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Title is required"})
		}
		child.Title = title
	}
	if req.Completed != nil {
		category := domain.TaskStatusCategoryNotStarted
		if *req.Completed {
			category = domain.TaskStatusCategoryDone
		}
		status, statusErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, child.ListID, nil, category)
		if statusErr != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to resolve task status"})
		}
		child.StatusID = &status.ID
		child.Status = legacyTaskStatus(category)
		if *req.Completed {
			now := time.Now()
			child.CompletedAt = &now
			uid := c.Locals("user_id").(uuid.UUID)
			child.CompletedBy = &uid
			child.Progress = 100
		} else {
			child.CompletedAt = nil
			child.CompletedBy = nil
			child.Progress = 0
		}
	}
	if req.SortOrder != nil {
		child.SortOrder = *req.SortOrder
	}

	if err := s.services.Task.Update(c.Context(), child); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to update subtask"})
	}
	full, loadFullErr := s.services.Task.GetByID(c.Context(), child.ID, accountID)
	if loadFullErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subtask"})
	}
	sub := legacySubtaskFromTask(full)
	return c.JSON(fiber.Map{"success": true, "subtask": sub})
}

func (s *Server) handleDeleteSubtask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	subID, err := uuid.Parse(c.Params("subId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid subtask ID"})
	}

	parentID, parentErr := uuid.Parse(c.Params("id"))
	child, loadErr := s.services.Task.GetByID(c.Context(), subID, accountID)
	if parentErr != nil || loadErr != nil || child.ParentTaskID == nil || *child.ParentTaskID != parentID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Subtask not found"})
	}
	if err := s.repos.TaskWork.SoftDeleteTask(c.Context(), accountID, subID, c.Locals("user_id").(uuid.UUID)); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to delete subtask"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
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

	parentID, parentErr := uuid.Parse(c.Params("id"))
	child, loadErr := s.services.Task.GetByID(c.Context(), subID, accountID)
	if parentErr != nil || loadErr != nil || child.ParentTaskID == nil || *child.ParentTaskID != parentID {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Subtask not found"})
	}
	completed := child.StatusDetail != nil && child.StatusDetail.Category == domain.TaskStatusCategoryDone
	category := domain.TaskStatusCategoryDone
	if completed {
		category = domain.TaskStatusCategoryNotStarted
	}
	status, statusErr := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, child.ListID, nil, category)
	if statusErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to resolve task status"})
	}
	child.StatusID = &status.ID
	child.Status = legacyTaskStatus(category)
	if category == domain.TaskStatusCategoryDone {
		now := time.Now()
		child.CompletedAt = &now
		uid := c.Locals("user_id").(uuid.UUID)
		child.CompletedBy = &uid
		child.Progress = 100
	} else {
		child.CompletedAt = nil
		child.CompletedBy = nil
		child.Progress = 0
	}
	if err := s.services.Task.Update(c.Context(), child); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to toggle subtask"})
	}
	full, loadFullErr := s.services.Task.GetByID(c.Context(), child.ID, accountID)
	if loadFullErr != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to load subtask"})
	}
	sub := legacySubtaskFromTask(full)

	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
			"action":  "subtask_toggled",
			"task_id": parentID.String(),
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
		Name        string  `json:"name"`
		Color       string  `json:"color"`
		Description string  `json:"description"`
		FolderID    *string `json:"folder_id"`
		WorkflowID  *string `json:"workflow_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Invalid request"})
	}
	if req.Name == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Name is required"})
	}

	list := &domain.TaskList{
		AccountID:   accountID,
		Name:        strings.TrimSpace(req.Name),
		Description: strings.TrimSpace(req.Description),
		Color:       req.Color,
		CreatedBy:   userID,
	}
	if req.FolderID != nil && *req.FolderID != "" {
		id, parseErr := uuid.Parse(*req.FolderID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
		}
		list.FolderID = &id
		list.WorkflowInherited = true
	}
	if req.WorkflowID != nil && *req.WorkflowID != "" {
		id, parseErr := uuid.Parse(*req.WorkflowID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		list.WorkflowID = &id
		list.WorkflowInherited = false
	}

	if err := s.repos.Task.CreateList(c.Context(), list); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to create task list"})
	}

	if s.hub != nil {
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
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
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
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
		s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, map[string]interface{}{
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
	var migratedEventID *uuid.UUID
	err := s.repos.DB().QueryRow(c.Context(), `
		SELECT retirement.event_id
		FROM tasks task
		JOIN program_event_retirements retirement
		  ON retirement.account_id=task.account_id AND retirement.program_id=task.program_id
		WHERE task.account_id=$1 AND task.id=ANY($2::uuid[]) AND retirement.status='migrated'
		LIMIT 1
	`, accountID, uuids).Scan(&migratedEventID)
	if err == nil {
		return c.Status(fiber.StatusConflict).JSON(migratedProgramConflictPayload(migratedEventID))
	}
	if err != nil && err != pgx.ErrNoRows {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar las tareas"})
	}

	if err := s.repos.Task.ReorderTasks(c.Context(), accountID, uuids); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "Failed to reorder tasks"})
	}

	return c.JSON(fiber.Map{"success": true})
}
