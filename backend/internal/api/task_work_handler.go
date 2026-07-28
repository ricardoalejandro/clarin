package api

import (
	"errors"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

func taskWorkError(c *fiber.Ctx, err error) error {
	switch {
	case errors.Is(err, repository.ErrTaskWorkNotFound):
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Recurso de tareas no encontrado"})
	case errors.Is(err, repository.ErrTaskDependencyCycle):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La dependencia crearía un ciclo", "code": "dependency_cycle"})
	case errors.Is(err, repository.ErrTaskStatusInUse):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El estado tiene tareas; selecciona un estado de reemplazo", "code": "status_replacement_required"})
	case errors.Is(err, repository.ErrTaskWorkflowInvalid):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El flujo debe conservar al menos un estado inicial y uno completado", "code": "workflow_invariant"})
	case errors.Is(err, repository.ErrTaskVersionConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La tarea cambió en otra sesión; recarga antes de guardar", "code": "version_conflict"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo completar la operación"})
	}
}

func (s *Server) broadcastTaskWork(accountID uuid.UUID, action string, payload fiber.Map) {
	if s.hub == nil {
		return
	}
	payload["action"] = action
	s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, payload)
}

func (s *Server) handleGetTaskHierarchy(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folders, rootLists, err := s.repos.TaskWork.ListFolders(c.Context(), accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "folders": folders, "root_lists": rootLists})
}

func (s *Server) handleCreateTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		Name        string  `json:"name"`
		Description string  `json:"description"`
		Color       string  `json:"color"`
		WorkflowID  *string `json:"workflow_id"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
	}
	folder := &domain.TaskFolder{AccountID: accountID, CreatedBy: userID, Name: strings.TrimSpace(req.Name), Description: strings.TrimSpace(req.Description), Color: req.Color}
	if req.WorkflowID != nil && *req.WorkflowID != "" {
		id, err := uuid.Parse(*req.WorkflowID)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		folder.WorkflowID = &id
	}
	if err := s.repos.TaskWork.CreateFolder(c.Context(), folder); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "folder_created", fiber.Map{"folder": folder})
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "folder": folder})
}

func (s *Server) handleUpdateTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	var req struct {
		Name, Description, Color *string
		WorkflowID               *string `json:"workflow_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	var workflowID *uuid.UUID
	if req.WorkflowID != nil {
		id, parseErr := uuid.Parse(*req.WorkflowID)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		workflowID = &id
	}
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
		}
		req.Name = &trimmed
	}
	if err := s.repos.TaskWork.UpdateFolder(c.Context(), accountID, folderID, req.Name, req.Description, req.Color, workflowID); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "folder_updated", fiber.Map{"folder_id": folderID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleArchiveTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	if err := s.repos.TaskWork.ArchiveFolder(c.Context(), accountID, folderID); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "folder_archived", fiber.Map{"folder_id": folderID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleUpdateTaskListStructure(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	var req struct {
		FolderID          *string `json:"folder_id"`
		WorkflowID        *string `json:"workflow_id"`
		WorkflowInherited *bool   `json:"workflow_inherited"`
		Description       *string `json:"description"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	var folderID, workflowID *uuid.UUID
	if req.FolderID != nil && *req.FolderID != "" {
		id, e := uuid.Parse(*req.FolderID)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
		}
		folderID = &id
	}
	if req.WorkflowID != nil && *req.WorkflowID != "" {
		id, e := uuid.Parse(*req.WorkflowID)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		workflowID = &id
	}
	inherited := req.WorkflowInherited
	if req.FolderID != nil && inherited == nil {
		value := folderID != nil
		inherited = &value
	}
	if err := s.repos.TaskWork.UpdateListLocation(c.Context(), accountID, listID, folderID, req.FolderID != nil, workflowID, inherited, req.Description); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "list_updated", fiber.Map{"list_id": listID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetTaskWorkflows(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	items, err := s.repos.TaskWork.ListWorkflows(c.Context(), accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "workflows": items})
}

func defaultWorkflowStatuses() []*domain.TaskStatus {
	return []*domain.TaskStatus{{Name: "Por hacer", Color: "#64748b", Category: domain.TaskStatusCategoryNotStarted, IsDefault: true}, {Name: "En curso", Color: "#3b82f6", Category: domain.TaskStatusCategoryActive}, {Name: "Completada", Color: "#10b981", Category: domain.TaskStatusCategoryDone}, {Name: "Cancelada", Color: "#ef4444", Category: domain.TaskStatusCategoryCancelled}}
}

func (s *Server) handleCreateTaskWorkflow(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		Name     string `json:"name"`
		Statuses []struct {
			Name, Color, Category string
			IsDefault             bool `json:"is_default"`
		} `json:"statuses"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
	}
	statuses := defaultWorkflowStatuses()
	if len(req.Statuses) > 0 {
		statuses = []*domain.TaskStatus{}
		seenNames := map[string]bool{}
		hasOpen, hasDone, hasDefault := false, false, false
		for _, raw := range req.Statuses {
			if !validTaskStatusCategory(raw.Category) || strings.TrimSpace(raw.Name) == "" {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
			}
			key := strings.ToLower(strings.TrimSpace(raw.Name))
			if seenNames[key] {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Los nombres de estado no pueden repetirse"})
			}
			seenNames[key] = true
			hasOpen = hasOpen || raw.Category == domain.TaskStatusCategoryNotStarted
			hasDone = hasDone || raw.Category == domain.TaskStatusCategoryDone
			if raw.IsDefault {
				if raw.Category != domain.TaskStatusCategoryNotStarted {
					return c.Status(400).JSON(fiber.Map{"success": false, "error": "El estado inicial predeterminado debe pertenecer a la categoría Inicial"})
				}
				if hasDefault {
					return c.Status(400).JSON(fiber.Map{"success": false, "error": "Sólo puede existir un estado inicial"})
				}
				hasDefault = true
			}
			color := raw.Color
			if color == "" {
				color = "#64748b"
			}
			statuses = append(statuses, &domain.TaskStatus{Name: strings.TrimSpace(raw.Name), Color: color, Category: raw.Category, IsDefault: raw.IsDefault})
		}
		if !hasOpen || !hasDone {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El flujo necesita al menos un estado inicial y uno completado"})
		}
		if !hasDefault {
			for _, status := range statuses {
				if status.Category == domain.TaskStatusCategoryNotStarted {
					status.IsDefault = true
					break
				}
			}
		}
	}
	workflow := &domain.TaskWorkflow{AccountID: accountID, Name: strings.TrimSpace(req.Name), CreatedBy: &userID}
	if err := s.repos.TaskWork.CreateWorkflow(c.Context(), workflow, statuses); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "workflow_created", fiber.Map{"workflow": workflow})
	return c.Status(201).JSON(fiber.Map{"success": true, "workflow": workflow})
}

func validTaskStatusCategory(category string) bool {
	switch category {
	case domain.TaskStatusCategoryNotStarted, domain.TaskStatusCategoryActive, domain.TaskStatusCategoryDone, domain.TaskStatusCategoryCancelled:
		return true
	}
	return false
}

func (s *Server) handleCreateTaskStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	workflowID, err := uuid.Parse(c.Params("workflowId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
	}
	var req struct {
		Name, Color, Category string
		IsDefault             bool `json:"is_default"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" || !validTaskStatusCategory(req.Category) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	if req.IsDefault && req.Category != domain.TaskStatusCategoryNotStarted {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El estado predeterminado debe ser inicial"})
	}
	if req.Color == "" {
		req.Color = "#64748b"
	}
	status := &domain.TaskStatus{AccountID: accountID, WorkflowID: workflowID, Name: strings.TrimSpace(req.Name), Color: req.Color, Category: req.Category, IsDefault: req.IsDefault}
	if err := s.repos.TaskWork.CreateStatus(c.Context(), status); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "status_created", fiber.Map{"status": status})
	return c.Status(201).JSON(fiber.Map{"success": true, "status": status})
}

func (s *Server) handleUpdateTaskStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("statusId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	var req struct {
		Name, Color, Category *string
		SortOrder             *int `json:"sort_order"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if req.Category != nil && !validTaskStatusCategory(*req.Category) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Categoría inválida"})
	}
	if err := s.repos.TaskWork.UpdateStatus(c.Context(), accountID, statusID, req.Name, req.Color, req.Category, req.SortOrder); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "status_updated", fiber.Map{"status_id": statusID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleDeleteTaskStatus(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	statusID, err := uuid.Parse(c.Params("statusId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
	}
	var replacementID *uuid.UUID
	if raw := c.Query("replacement_status_id"); raw != "" {
		id, e := uuid.Parse(raw)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Reemplazo inválido"})
		}
		replacementID = &id
	}
	if err := s.repos.TaskWork.DeleteStatus(c.Context(), accountID, statusID, replacementID); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(accountID, "status_deleted", fiber.Map{"status_id": statusID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleSetTaskCollaborators(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		UserIDs []string `json:"user_ids"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	ids := []uuid.UUID{}
	seen := map[uuid.UUID]bool{}
	for _, raw := range req.UserIDs {
		id, e := uuid.Parse(raw)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Colaborador inválido"})
		}
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if err := s.repos.TaskWork.SetCollaborators(c.Context(), accountID, taskID, actorID, ids); err != nil {
		return taskWorkError(c, err)
	}
	items, err := s.repos.TaskWork.ListCollaborators(c.Context(), accountID, taskID)
	if err != nil {
		return taskWorkError(c, err)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &actorID, "collaborators_updated", fiber.Map{"count": len(ids)})
	s.broadcastTaskWork(accountID, "collaborators_updated", fiber.Map{"task_id": taskID, "collaborators": items})
	return c.JSON(fiber.Map{"success": true, "collaborators": items})
}

func (s *Server) handleGetTaskChildren(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	valid, e := s.repos.TaskWork.TaskBelongsToAccount(c.Context(), accountID, taskID)
	if e != nil || !valid {
		if e != nil {
			return taskWorkError(c, e)
		}
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Tarea no encontrada"})
	}
	items, e := s.repos.TaskWork.ListChildTasks(c.Context(), accountID, taskID)
	if e != nil {
		return taskWorkError(c, e)
	}
	return c.JSON(fiber.Map{"success": true, "tasks": items})
}

func (s *Server) handleCreateTaskChild(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	parentID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	parent, err := s.services.Task.GetByID(c.Context(), parentID, accountID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "Tarea no encontrada"})
	}
	if parent.ParentTaskID != nil {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "Sólo se permite un nivel de subtareas"})
	}
	var req struct {
		Title       string  `json:"title"`
		Description string  `json:"description"`
		AssignedTo  *string `json:"assigned_to"`
		StatusID    *string `json:"status_id"`
		Priority    string  `json:"priority"`
		StartAt     *string `json:"start_at"`
		DueAt       *string `json:"due_at"`
		IsAllDay    bool    `json:"is_all_day"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Title) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El título es obligatorio"})
	}
	assigned := parent.AssignedTo
	if req.AssignedTo != nil && *req.AssignedTo != "" {
		id, e := uuid.Parse(*req.AssignedTo)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Responsable inválido"})
		}
		ok, e := s.repos.TaskWork.UserBelongsToAccount(c.Context(), accountID, id)
		if e != nil || !ok {
			return c.Status(422).JSON(fiber.Map{"success": false, "error": "El responsable no pertenece a la cuenta"})
		}
		assigned = id
	}
	var requestedStatus *uuid.UUID
	if req.StatusID != nil && *req.StatusID != "" {
		id, e := uuid.Parse(*req.StatusID)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
		}
		requestedStatus = &id
	}
	status, e := s.repos.TaskWork.ResolveStatus(c.Context(), accountID, parent.ListID, requestedStatus, domain.TaskStatusCategoryNotStarted)
	if e != nil {
		return taskWorkError(c, e)
	}
	child := &domain.Task{AccountID: accountID, CreatedBy: userID, AssignedTo: assigned, Title: strings.TrimSpace(req.Title), Description: req.Description, Type: domain.TaskTypeReminder, Priority: req.Priority, Status: domain.TaskStatusPending, StatusID: &status.ID, ListID: parent.ListID, ParentTaskID: &parentID, IsAllDay: req.IsAllDay}
	if child.Priority == "" {
		child.Priority = domain.TaskPriorityMedium
	}
	if !validTaskPriority(child.Priority) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Prioridad inválida"})
	}
	if req.StartAt != nil {
		if strings.TrimSpace(*req.StartAt) != "" {
			parsed, parseErr := time.Parse(time.RFC3339, *req.StartAt)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha de inicio inválida"})
			}
			child.StartAt = &parsed
		}
	}
	if req.DueAt != nil {
		if strings.TrimSpace(*req.DueAt) != "" {
			parsed, parseErr := time.Parse(time.RFC3339, *req.DueAt)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha final inválida"})
			}
			child.DueAt = &parsed
		}
	}
	if child.StartAt != nil && child.DueAt != nil && child.DueAt.Before(*child.StartAt) {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "La fecha final no puede ser anterior al inicio"})
	}
	if err := s.services.Task.Create(c.Context(), child); err != nil {
		return taskWorkError(c, err)
	}
	full, loadErr := s.services.Task.GetByID(c.Context(), child.ID, accountID)
	if loadErr != nil {
		return taskWorkError(c, loadErr)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, parentID, &userID, "subtask_created", fiber.Map{"subtask_id": child.ID})
	s.broadcastTaskWork(accountID, "subtask_created", fiber.Map{"task_id": parentID, "subtask": full})
	return c.Status(201).JSON(fiber.Map{"success": true, "task": full})
}

func (s *Server) handleGetTaskComments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	items, err := s.repos.TaskWork.ListComments(c.Context(), accountID, taskID, 100, 0)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "comments": items})
}
func (s *Server) handleCreateTaskComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		Body string `json:"body"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El comentario está vacío"})
	}
	comment := &domain.TaskComment{AccountID: accountID, TaskID: taskID, AuthorID: userID, Body: strings.TrimSpace(req.Body)}
	if err := s.repos.TaskWork.CreateComment(c.Context(), comment); err != nil {
		return taskWorkError(c, err)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "comment_created", fiber.Map{"comment_id": comment.ID})
	s.broadcastTaskWork(accountID, "comment_created", fiber.Map{"task_id": taskID, "comment_id": comment.ID})
	return c.Status(201).JSON(fiber.Map{"success": true, "comment": comment})
}
func (s *Server) handleUpdateTaskComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	commentID, err := uuid.Parse(c.Params("commentId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Comentario inválido"})
	}
	var req struct {
		Body string `json:"body"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El comentario está vacío"})
	}
	if err := s.repos.TaskWork.UpdateComment(c.Context(), accountID, taskID, commentID, userID, strings.TrimSpace(req.Body), s.isAccountAdmin(c, accountID, userID)); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}
func (s *Server) handleDeleteTaskComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	commentID, err := uuid.Parse(c.Params("commentId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Comentario inválido"})
	}
	if err := s.repos.TaskWork.DeleteComment(c.Context(), accountID, taskID, commentID, userID, s.isAccountAdmin(c, accountID, userID)); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetTaskActivity(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	items, err := s.repos.TaskWork.ListActivity(c.Context(), accountID, taskID, 100)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "activity": items})
}

func (s *Server) handleGetTaskAttachments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	items, err := s.repos.TaskWork.ListAttachments(c.Context(), accountID, taskID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "attachments": items})
}
func (s *Server) handleAddTaskAttachment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		MediaAssetID string `json:"media_asset_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	assetID, err := uuid.Parse(req.MediaAssetID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Archivo inválido"})
	}
	item, err := s.repos.TaskWork.AddAttachment(c.Context(), accountID, taskID, assetID, userID)
	if err != nil {
		return taskWorkError(c, err)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "attachment_added", fiber.Map{"attachment_id": item.ID})
	s.broadcastTaskWork(accountID, "attachment_added", fiber.Map{"task_id": taskID, "attachment": item})
	return c.Status(201).JSON(fiber.Map{"success": true, "attachment": item})
}
func (s *Server) handleDeleteTaskAttachment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	attachmentID, err := uuid.Parse(c.Params("attachmentId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Archivo inválido"})
	}
	if err := s.repos.TaskWork.DeleteAttachment(c.Context(), accountID, taskID, attachmentID); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleGetTaskDependencies(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	items, err := s.repos.TaskWork.ListDependencies(c.Context(), accountID, taskID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "dependencies": items})
}
func (s *Server) handleAddTaskDependency(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	successorID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		PredecessorTaskID string `json:"predecessor_task_id"`
		LagMinutes        int    `json:"lag_minutes"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	predecessorID, err := uuid.Parse(req.PredecessorTaskID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Predecesora inválida"})
	}
	dep := &domain.TaskDependency{AccountID: accountID, PredecessorTaskID: predecessorID, SuccessorTaskID: successorID, DependencyType: "finish_to_start", LagMinutes: req.LagMinutes, CreatedBy: &userID}
	if err := s.repos.TaskWork.AddDependency(c.Context(), dep); err != nil {
		return taskWorkError(c, err)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, successorID, &userID, "dependency_added", fiber.Map{"predecessor_task_id": predecessorID})
	s.broadcastTaskWork(accountID, "dependency_added", fiber.Map{"task_id": successorID, "dependency": dep})
	return c.Status(201).JSON(fiber.Map{"success": true, "dependency": dep})
}
func (s *Server) handleDeleteTaskDependency(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	dependencyID, err := uuid.Parse(c.Params("dependencyId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Dependencia inválida"})
	}
	if err := s.repos.TaskWork.DeleteDependency(c.Context(), accountID, taskID, dependencyID); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleRestoreTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	if err := s.repos.TaskWork.RestoreTask(c.Context(), accountID, taskID); err != nil {
		return taskWorkError(c, err)
	}
	if task, err := s.services.Task.GetByID(c.Context(), taskID, accountID); err == nil {
		s.services.Task.RebuildReminder(c.Context(), task)
	}
	if children, err := s.repos.TaskWork.ListChildTasks(c.Context(), accountID, taskID); err == nil {
		for _, child := range children {
			s.services.Task.RebuildReminder(c.Context(), child)
		}
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "restored", fiber.Map{})
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "restored", fiber.Map{"task_id": taskID})
	return c.JSON(fiber.Map{"success": true})
}

func parseTaskScope(c *fiber.Ctx) (*uuid.UUID, *uuid.UUID, error) {
	var folderID, listID *uuid.UUID
	if raw := c.Query("folder_id"); raw != "" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return nil, nil, err
		}
		folderID = &id
	}
	if raw := c.Query("list_id"); raw != "" && raw != "none" {
		id, err := uuid.Parse(raw)
		if err != nil {
			return nil, nil, err
		}
		listID = &id
	}
	return folderID, listID, nil
}
func (s *Server) handleGetTaskWorkSummary(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folderID, listID, err := parseTaskScope(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Ámbito inválido"})
	}
	summary, err := s.repos.TaskWork.Summary(c.Context(), accountID, folderID, listID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "summary": summary})
}

func (s *Server) handleGetTaskGantt(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folderID, listID, err := parseTaskScope(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Ámbito inválido"})
	}
	filters := map[string]string{"include_subtasks": "true"}
	if folderID != nil {
		filters["folder_id"] = folderID.String()
	}
	if listID != nil {
		filters["list_id"] = listID.String()
	}
	tasks, _, err := s.services.Task.GetByAccount(c.Context(), accountID, filters, 2000, 0)
	if err != nil {
		return taskWorkError(c, err)
	}
	ids := make([]uuid.UUID, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	deps, err := s.repos.TaskWork.GanttDependencies(c.Context(), accountID, ids)
	if err != nil {
		return taskWorkError(c, err)
	}
	critical, slack := computeCriticalPath(tasks, deps)
	return c.JSON(fiber.Map{"success": true, "tasks": tasks, "dependencies": deps, "critical_task_ids": critical, "slack_minutes": slack})
}

func taskDurationMinutes(task *domain.Task) float64 {
	if task.StartAt != nil && task.DueAt != nil && task.DueAt.After(*task.StartAt) {
		return task.DueAt.Sub(*task.StartAt).Minutes()
	}
	return 24 * 60
}
func computeCriticalPath(tasks []*domain.Task, deps []*domain.TaskDependency) ([]string, map[string]int) {
	type graphEdge struct {
		to  uuid.UUID
		lag float64
	}
	byID := map[uuid.UUID]*domain.Task{}
	indegree := map[uuid.UUID]int{}
	out := map[uuid.UUID][]graphEdge{}
	for _, task := range tasks {
		byID[task.ID] = task
		indegree[task.ID] = 0
	}
	for _, dep := range deps {
		if byID[dep.PredecessorTaskID] != nil && byID[dep.SuccessorTaskID] != nil {
			out[dep.PredecessorTaskID] = append(out[dep.PredecessorTaskID], graphEdge{to: dep.SuccessorTaskID, lag: float64(dep.LagMinutes)})
			indegree[dep.SuccessorTaskID]++
		}
	}
	queue := []uuid.UUID{}
	for id, degree := range indegree {
		if degree == 0 {
			queue = append(queue, id)
		}
	}
	sort.Slice(queue, func(i, j int) bool { return queue[i].String() < queue[j].String() })
	topo := []uuid.UUID{}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		topo = append(topo, id)
		for _, edge := range out[id] {
			indegree[edge.to]--
			if indegree[edge.to] == 0 {
				queue = append(queue, edge.to)
			}
		}
	}
	earliest := map[uuid.UUID]float64{}
	parent := map[uuid.UUID]uuid.UUID{}
	project := float64(0)
	end := uuid.Nil
	for _, id := range topo {
		finish := earliest[id] + taskDurationMinutes(byID[id])
		if finish > project {
			project = finish
			end = id
		}
		for _, edge := range out[id] {
			candidate := finish + edge.lag
			if candidate > earliest[edge.to] {
				earliest[edge.to] = candidate
				parent[edge.to] = id
			}
		}
	}
	downstream := map[uuid.UUID]float64{}
	for i := len(topo) - 1; i >= 0; i-- {
		id := topo[i]
		best := float64(0)
		for _, edge := range out[id] {
			best = math.Max(best, edge.lag+downstream[edge.to])
		}
		downstream[id] = taskDurationMinutes(byID[id]) + best
	}
	slack := map[string]int{}
	for _, id := range topo {
		value := math.Max(0, project-earliest[id]-downstream[id])
		slack[id.String()] = int(math.Round(value))
	}
	critical := []string{}
	for end != uuid.Nil {
		critical = append(critical, end.String())
		previous, ok := parent[end]
		if !ok {
			break
		}
		end = previous
	}
	for i, j := 0, len(critical)-1; i < j; i, j = i+1, j-1 {
		critical[i], critical[j] = critical[j], critical[i]
	}
	return critical, slack
}
