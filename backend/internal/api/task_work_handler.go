package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

type taskSavedViewRequest struct {
	Name               *string          `json:"name"`
	ScopeType          *string          `json:"scope_type"`
	ScopeID            *string          `json:"scope_id"`
	ViewMode           *string          `json:"view_mode"`
	Filters            *json.RawMessage `json:"filters"`
	CollapsedStatusIDs *[]string        `json:"collapsed_status_ids"`
	IsDefault          *bool            `json:"is_default"`
}

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
	case errors.Is(err, repository.ErrTaskOrderInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "El orden debe contener todas las tareas activas de una sola lista", "code": "invalid_task_order"})
	case errors.Is(err, repository.ErrTaskListOrderInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La posición elegida ya no pertenece al destino", "code": "invalid_list_order_anchor"})
	case errors.Is(err, repository.ErrTaskFolderOrderInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La posición de la carpeta ya no es válida", "code": "invalid_folder_order_anchor"})
	case errors.Is(err, repository.ErrTaskSavedViewNameConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Ya existe una vista guardada con ese nombre", "code": "saved_view_name_conflict"})
	case errors.Is(err, repository.ErrTaskSavedViewDefaultConflict):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La vista predeterminada cambió en otra sesión; actualiza y reintenta", "code": "saved_view_default_conflict"})
	case errors.Is(err, repository.ErrTaskCollaboratorInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Uno de los colaboradores no pertenece a esta cuenta", "code": "invalid_collaborator"})
	case errors.Is(err, repository.ErrTaskStatusMappingInvalid):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "El flujo de destino no tiene estados equivalentes para todas las tareas", "code": "workflow_status_mapping"})
	case errors.Is(err, repository.ErrTaskStatusOrderInvalid):
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "El orden debe contener exactamente todos los estados del flujo", "code": "invalid_status_order"})
	case errors.Is(err, repository.ErrTaskContainerNotEmpty):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Mueve o elimina las tareas antes de archivar", "code": "task_container_not_empty"})
	case errors.Is(err, repository.ErrTaskParentArchived):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "Restaura primero la tarea padre", "code": "task_parent_archived"})
	case errors.Is(err, repository.ErrDefaultTaskList):
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "La Bandeja general debe permanecer como lista raíz predeterminada", "code": "default_list_invariant"})
	default:
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo completar la operación"})
	}
}

var taskContainerIconCatalog = map[string]struct{}{
	"inbox": {}, "list": {}, "folder": {}, "briefcase": {}, "rocket": {},
	"target": {}, "users": {}, "megaphone": {}, "graduation-cap": {},
	"building": {}, "clipboard-list": {}, "layers": {}, "calendar": {},
	"flag": {}, "phone": {}, "message-circle": {}, "bell": {}, "check-square": {},
}

func validTaskContainerIcon(value string) bool {
	_, ok := taskContainerIconCatalog[strings.TrimSpace(value)]
	return ok
}

func parseNullableTaskUUID(raw json.RawMessage) (*uuid.UUID, bool, error) {
	if len(raw) == 0 {
		return nil, false, nil
	}
	if string(raw) == "null" {
		return nil, true, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, true, err
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, true, nil
	}
	id, err := uuid.Parse(value)
	if err != nil {
		return nil, true, err
	}
	return &id, true, nil
}

func taskStructureOperationID(raw string) (uuid.UUID, error) {
	if strings.TrimSpace(raw) == "" {
		return uuid.New(), nil
	}
	return uuid.Parse(strings.TrimSpace(raw))
}

func parseTaskUUIDList(values []string) ([]uuid.UUID, error) {
	result := make([]uuid.UUID, 0, len(values))
	seen := make(map[uuid.UUID]struct{}, len(values))
	for _, value := range values {
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, err
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result, nil
}

func (s *Server) setTaskCommentPermissions(c *fiber.Ctx, accountID, userID uuid.UUID, comments []*domain.TaskComment) {
	admin := s.isAccountAdmin(c, accountID, userID)
	for _, comment := range comments {
		comment.CanEdit = admin || comment.AuthorID == userID
		comment.CanDelete = comment.CanEdit
	}
}

func (s *Server) broadcastTaskWork(accountID uuid.UUID, action string, payload fiber.Map) {
	if s.hub == nil {
		return
	}
	payload["action"] = action
	s.hub.BroadcastToAccountWithPermission(accountID, domain.PermTasks, ws.EventTaskUpdate, payload)
}

func validTaskSavedViewMode(value string) bool {
	switch value {
	case "list", "board", "calendar", "gantt", "summary":
		return true
	default:
		return false
	}
}

func normalizeCollapsedTaskStatusIDs(raw []string) ([]string, []uuid.UUID, error) {
	if len(raw) > 100 {
		return nil, nil, errors.New("too many collapsed statuses")
	}
	validCategories := map[string]bool{
		"category:not_started": true,
		"category:active":      true,
		"category:done":        true,
		"category:cancelled":   true,
	}
	collapsed := make([]string, 0, len(raw))
	uuidIDs := make([]uuid.UUID, 0, len(raw))
	seen := make(map[string]struct{}, len(raw))
	for _, item := range raw {
		value := strings.TrimSpace(item)
		if _, duplicate := seen[value]; duplicate {
			continue
		}
		if validCategories[value] {
			seen[value] = struct{}{}
			collapsed = append(collapsed, value)
			continue
		}
		id, err := uuid.Parse(value)
		if err != nil {
			return nil, nil, errors.New("invalid collapsed status")
		}
		canonical := id.String()
		if _, duplicate := seen[canonical]; duplicate {
			continue
		}
		seen[canonical] = struct{}{}
		collapsed = append(collapsed, canonical)
		uuidIDs = append(uuidIDs, id)
	}
	return collapsed, uuidIDs, nil
}

func (s *Server) validateTaskSavedViewFilters(c *fiber.Ctx, accountID uuid.UUID, raw json.RawMessage) error {
	if len(raw) > 32*1024 || !json.Valid(raw) {
		return errors.New("filters payload is invalid")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return errors.New("filters must be an object")
	}
	allowed := map[string]bool{
		"status_ids": true, "assigned_to_ids": true, "collaborator_ids": true,
		"priorities": true, "types": true, "creator_ids": true, "due": true,
		"created_from": true, "created_to": true, "completed_from": true, "completed_to": true,
		"has_subtasks": true, "has_comments": true, "has_attachments": true,
		"has_dependencies": true, "starred": true,
	}
	for key := range fields {
		if !allowed[key] {
			return fmt.Errorf("unsupported filter %s", key)
		}
	}
	var filters struct {
		StatusIDs       []string `json:"status_ids"`
		AssignedToIDs   []string `json:"assigned_to_ids"`
		CollaboratorIDs []string `json:"collaborator_ids"`
		Priorities      []string `json:"priorities"`
		Types           []string `json:"types"`
		CreatorIDs      []string `json:"creator_ids"`
		Due             string   `json:"due"`
		CreatedFrom     string   `json:"created_from"`
		CreatedTo       string   `json:"created_to"`
		CompletedFrom   string   `json:"completed_from"`
		CompletedTo     string   `json:"completed_to"`
		HasSubtasks     *bool    `json:"has_subtasks"`
		HasComments     *bool    `json:"has_comments"`
		HasAttachments  *bool    `json:"has_attachments"`
		HasDependencies *bool    `json:"has_dependencies"`
		Starred         *bool    `json:"starred"`
	}
	if err := json.Unmarshal(raw, &filters); err != nil {
		return err
	}
	for _, key := range []string{"status_ids", "assigned_to_ids", "collaborator_ids", "priorities", "types", "creator_ids"} {
		if value, present := fields[key]; present && string(value) == "null" {
			return fmt.Errorf("filter %s must be an array", key)
		}
	}
	for _, values := range [][]string{filters.StatusIDs, filters.AssignedToIDs, filters.CollaboratorIDs, filters.CreatorIDs} {
		if len(values) > 100 {
			return errors.New("too many IDs in a saved filter")
		}
	}
	if len(filters.Priorities) > 4 || len(filters.Types) > 4 {
		return errors.New("too many enum values in a saved filter")
	}
	for _, priority := range filters.Priorities {
		if !validTaskPriority(priority) {
			return errors.New("invalid saved priority")
		}
	}
	for _, taskType := range filters.Types {
		if !validTaskType(taskType) {
			return errors.New("invalid saved task type")
		}
	}
	validDue := map[string]bool{"": true, "overdue": true, "today": true, "this_week": true, "no_date": true}
	if !validDue[filters.Due] {
		return errors.New("invalid saved due filter")
	}
	dateFilters := map[string]string{
		"created_from": filters.CreatedFrom, "created_to": filters.CreatedTo,
		"completed_from": filters.CompletedFrom, "completed_to": filters.CompletedTo,
	}
	if key := invalidTaskQueryDateFilter(dateFilters); key != "" {
		return fmt.Errorf("invalid saved date filter %s", key)
	}
	statusIDs, err := parseTaskUUIDList(filters.StatusIDs)
	if err != nil {
		return errors.New("invalid saved status")
	}
	if len(statusIDs) > 0 {
		var count int
		if err := s.repos.DB().QueryRow(c.Context(), `SELECT COUNT(*) FROM task_statuses WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, statusIDs).Scan(&count); err != nil {
			return err
		}
		if count != len(statusIDs) {
			return errors.New("saved status does not belong to account")
		}
	}
	userStrings := append(append(append([]string{}, filters.AssignedToIDs...), filters.CollaboratorIDs...), filters.CreatorIDs...)
	userIDs, err := parseTaskUUIDList(userStrings)
	if err != nil {
		return errors.New("invalid saved user")
	}
	if len(userIDs) > 0 {
		var count int
		if err := s.repos.DB().QueryRow(c.Context(), `SELECT COUNT(*) FROM user_accounts WHERE account_id=$1 AND user_id=ANY($2::uuid[])`, accountID, userIDs).Scan(&count); err != nil {
			return err
		}
		if count != len(userIDs) {
			return errors.New("saved user does not belong to account")
		}
	}
	return nil
}

func (s *Server) applyTaskSavedViewRequest(c *fiber.Ctx, view *domain.TaskSavedView, req taskSavedViewRequest, creating bool) error {
	if req.Name != nil {
		view.Name = strings.TrimSpace(*req.Name)
	}
	if view.Name == "" || len([]rune(view.Name)) > 120 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "El nombre de la vista es obligatorio y debe tener hasta 120 caracteres"})
	}
	if req.ScopeType != nil {
		view.ScopeType = strings.ToLower(strings.TrimSpace(*req.ScopeType))
	}
	if view.ScopeType == "" {
		view.ScopeType = "all"
	}
	if req.ScopeID != nil {
		view.ScopeID = nil
		if strings.TrimSpace(*req.ScopeID) != "" {
			id, err := uuid.Parse(strings.TrimSpace(*req.ScopeID))
			if err != nil {
				return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Alcance de vista inválido"})
			}
			view.ScopeID = &id
		}
	}
	if view.ScopeType == "all" {
		view.ScopeID = nil
	}
	exists, err := s.repos.TaskWork.SavedViewScopeExists(c.Context(), view.AccountID, view.ScopeType, view.ScopeID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudo validar el alcance de la vista"})
	}
	if !exists {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "La carpeta o lista de la vista no pertenece a esta cuenta"})
	}
	if req.ViewMode != nil {
		view.ViewMode = strings.ToLower(strings.TrimSpace(*req.ViewMode))
	}
	if view.ViewMode == "" {
		view.ViewMode = "board"
	}
	if !validTaskSavedViewMode(view.ViewMode) {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Modo de vista inválido"})
	}
	if req.Filters != nil {
		if err := s.validateTaskSavedViewFilters(c, view.AccountID, *req.Filters); err != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Filtros de vista inválidos"})
		}
		view.Filters = append(json.RawMessage(nil), (*req.Filters)...)
	} else if creating {
		view.Filters = json.RawMessage(`{}`)
	}
	if req.CollapsedStatusIDs != nil {
		collapsed, uuidIDs, normalizeErr := normalizeCollapsedTaskStatusIDs(*req.CollapsedStatusIDs)
		if normalizeErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Estado contraído inválido"})
		}
		if len(uuidIDs) > 0 {
			var count int
			if err := s.repos.DB().QueryRow(c.Context(), `SELECT COUNT(*) FROM task_statuses WHERE account_id=$1 AND id=ANY($2::uuid[])`, view.AccountID, uuidIDs).Scan(&count); err != nil {
				return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron validar los estados de la vista"})
			}
			if count != len(uuidIDs) {
				return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Uno de los estados no pertenece a esta cuenta"})
			}
		}
		view.CollapsedStatusIDs = collapsed
	} else if creating {
		view.CollapsedStatusIDs = []string{}
	}
	if req.IsDefault != nil {
		view.IsDefault = *req.IsDefault
	}
	return nil
}

func (s *Server) handleListTaskSavedViews(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	views, err := s.repos.TaskWork.ListSavedViews(c.Context(), accountID, userID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "views": views})
}

func (s *Server) handleCreateTaskSavedView(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	var req taskSavedViewRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	view := &domain.TaskSavedView{AccountID: accountID, UserID: userID, ScopeType: "all", ViewMode: "board"}
	if err := s.applyTaskSavedViewRequest(c, view, req, true); err != nil {
		return err
	}
	if err := s.repos.TaskWork.CreateSavedView(c.Context(), view); err != nil {
		return taskWorkError(c, err)
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"success": true, "view": view})
}

func (s *Server) handleUpdateTaskSavedView(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	viewID, err := uuid.Parse(c.Params("viewId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Vista inválida"})
	}
	view, err := s.repos.TaskWork.GetSavedView(c.Context(), accountID, userID, viewID)
	if err != nil {
		return taskWorkError(c, err)
	}
	var req taskSavedViewRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.applyTaskSavedViewRequest(c, view, req, false); err != nil {
		return err
	}
	if err := s.repos.TaskWork.UpdateSavedView(c.Context(), view); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "view": view})
}

func (s *Server) handleDeleteTaskSavedView(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	viewID, err := uuid.Parse(c.Params("viewId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Vista inválida"})
	}
	if err := s.repos.TaskWork.DeleteSavedView(c.Context(), accountID, userID, viewID); err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleMoveTask(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		StatusID     string  `json:"status_id"`
		BeforeTaskID *string `json:"before_task_id"`
		Version      *int64  `json:"version"`
		OperationID  string  `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	statusID, err := uuid.Parse(strings.TrimSpace(req.StatusID))
	if err != nil || req.Version == nil || *req.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Estado y versión son obligatorios"})
	}
	operationID := strings.TrimSpace(req.OperationID)
	if operationID == "" {
		operationID = uuid.NewString()
	}
	if len(operationID) > 128 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Operación inválida"})
	}
	var beforeTaskID *uuid.UUID
	if req.BeforeTaskID != nil && strings.TrimSpace(*req.BeforeTaskID) != "" {
		id, parseErr := uuid.Parse(strings.TrimSpace(*req.BeforeTaskID))
		if parseErr != nil || id == taskID {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Posición de destino inválida"})
		}
		beforeTaskID = &id
	}
	existing, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil || existing.DeletedAt != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Tarea no encontrada"})
	}
	if existing.ParentTaskID != nil {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Las subtareas se ordenan dentro de su tarea padre", "code": "child_task_move_not_supported"})
	}
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
	}
	wasDone := existing.Status == domain.TaskStatusCompleted || (existing.StatusDetail != nil && existing.StatusDetail.Category == domain.TaskStatusCategoryDone)
	move, err := s.repos.TaskWork.MoveTask(c.Context(), accountID, taskID, statusID, beforeTaskID, userID, *req.Version, operationID)
	if err != nil {
		return taskWorkError(c, err)
	}
	full, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	isDone := full.Status == domain.TaskStatusCompleted || (full.StatusDetail != nil && full.StatusDetail.Category == domain.TaskStatusCategoryDone)
	if isDone {
		_ = s.repos.Task.DeleteRemindersByTask(c.Context(), taskID)
		if !wasDone {
			s.services.Task.EnsureNextOccurrence(c.Context(), full)
		}
	} else {
		s.services.Task.RebuildReminder(c.Context(), full)
	}
	order := fiber.Map{"list_id": move.ListID, "status_id": move.StatusID, "task_ids": move.TaskIDs}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "moved", fiber.Map{
		"operation_id": operationID,
		"task":         full,
		"order":        order,
	})
	return c.JSON(fiber.Map{
		"success":      true,
		"operation_id": operationID,
		"task":         full,
		"order":        order,
	})
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
		Icon        string  `json:"icon"`
		WorkflowID  *string `json:"workflow_id"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
	}
	req.Icon = strings.TrimSpace(req.Icon)
	if req.Icon == "" {
		req.Icon = "folder"
	}
	if !validTaskContainerIcon(req.Icon) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Icono inválido"})
	}
	folder := &domain.TaskFolder{AccountID: accountID, CreatedBy: userID, Name: strings.TrimSpace(req.Name), Description: strings.TrimSpace(req.Description), Color: req.Color, Icon: req.Icon}
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
		Name, Description, Color, Icon *string
		WorkflowID                     json.RawMessage `json:"workflow_id"`
		OperationID                    string          `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	var workflowID *uuid.UUID
	workflowProvided := len(req.WorkflowID) > 0
	if workflowProvided && string(req.WorkflowID) != "null" {
		var raw string
		if unmarshalErr := json.Unmarshal(req.WorkflowID, &raw); unmarshalErr != nil || strings.TrimSpace(raw) == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		id, parseErr := uuid.Parse(strings.TrimSpace(raw))
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
	if req.Icon != nil {
		trimmed := strings.TrimSpace(*req.Icon)
		req.Icon = &trimmed
	}
	if req.Icon != nil && !validTaskContainerIcon(*req.Icon) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Icono inválido"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.TaskWork.UpdateFolder(c.Context(), accountID, folderID, req.Name, req.Description, req.Color, req.Icon, workflowID, workflowProvided); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "folder_updated", fiber.Map{"folder_id": folderID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleReorderTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	var req struct {
		BeforeFolderID json.RawMessage `json:"before_folder_id"`
		OperationID    string          `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	beforeFolderID, _, err := parseNullableTaskUUID(req.BeforeFolderID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Posición de carpeta inválida"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.TaskWork.ReorderFolder(c.Context(), accountID, folderID, beforeFolderID); err != nil {
		return taskWorkError(c, err)
	}
	folders, rootLists, err := s.repos.TaskWork.ListFolders(c.Context(), accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "folder_updated", fiber.Map{"folder_id": folderID, "operation_id": operationID, "operation": "reordered"})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "folders": folders, "root_lists": rootLists})
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
		FolderID          json.RawMessage `json:"folder_id"`
		BeforeListID      json.RawMessage `json:"before_list_id"`
		WorkflowID        *string         `json:"workflow_id"`
		WorkflowInherited *bool           `json:"workflow_inherited"`
		Description       *string         `json:"description"`
		Name              *string         `json:"name"`
		Color             *string         `json:"color"`
		Icon              *string         `json:"icon"`
		OperationID       string          `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	folderID, folderProvided, parseErr := parseNullableTaskUUID(req.FolderID)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	beforeListID, orderProvided, parseErr := parseNullableTaskUUID(req.BeforeListID)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Posición de lista inválida"})
	}
	var workflowID *uuid.UUID
	if req.WorkflowID != nil && *req.WorkflowID != "" {
		id, e := uuid.Parse(*req.WorkflowID)
		if e != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
		}
		workflowID = &id
	}
	inherited := req.WorkflowInherited
	if folderProvided && inherited == nil {
		value := folderID != nil
		inherited = &value
	}
	if req.Name != nil {
		trimmed := strings.TrimSpace(*req.Name)
		if trimmed == "" {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "El nombre es obligatorio"})
		}
		req.Name = &trimmed
	}
	if req.Icon != nil {
		trimmed := strings.TrimSpace(*req.Icon)
		req.Icon = &trimmed
	}
	if req.Icon != nil && !validTaskContainerIcon(*req.Icon) {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Icono inválido"})
	}
	operationID, err := taskStructureOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	if err := s.repos.TaskWork.UpdateListLocation(c.Context(), accountID, listID, folderID, folderProvided, beforeListID, orderProvided, workflowID, inherited, req.Description, req.Name, req.Color, req.Icon); err != nil {
		return taskWorkError(c, err)
	}
	folders, rootLists, err := s.repos.TaskWork.ListFolders(c.Context(), accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "list_updated", fiber.Map{"list_id": listID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "folders": folders, "root_lists": rootLists})
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
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "status_updated", fiber.Map{"status_id": statusID})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleReorderTaskStatuses(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	workflowID, err := uuid.Parse(c.Params("workflowId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Flujo inválido"})
	}
	var req struct {
		StatusIDs []string `json:"status_ids"`
	}
	if err := c.BodyParser(&req); err != nil || len(req.StatusIDs) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "status_ids es obligatorio"})
	}
	statusIDs := make([]uuid.UUID, 0, len(req.StatusIDs))
	for _, raw := range req.StatusIDs {
		id, parseErr := uuid.Parse(strings.TrimSpace(raw))
		if parseErr != nil {
			return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Estado inválido"})
		}
		statusIDs = append(statusIDs, id)
	}
	if err := s.repos.TaskWork.ReorderStatuses(c.Context(), accountID, workflowID, statusIDs); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "status_updated", fiber.Map{"workflow_id": workflowID, "status_ids": statusIDs, "operation": "reordered"})
	return c.JSON(fiber.Map{"success": true, "workflow_id": workflowID, "status_ids": statusIDs})
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
	s.invalidateTasksCache(accountID)
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
		Version *int64   `json:"version"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if req.Version == nil || *req.Version < 1 {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "La versión de la tarea es obligatoria"})
	}
	existing, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Tarea no encontrada"})
	}
	if existing.ProgramID != nil {
		if handled, guardErr := s.validateTaskProgramMutation(c, accountID, *existing.ProgramID); handled {
			return guardErr
		}
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
	if _, err := s.repos.TaskWork.SetCollaborators(c.Context(), accountID, taskID, actorID, ids, *req.Version); err != nil {
		return taskWorkError(c, err)
	}
	full, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	if full.Collaborators == nil {
		full.Collaborators = []*domain.TaskCollaborator{}
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &actorID, "collaborators_updated", fiber.Map{"count": len(ids)})
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "collaborators_updated", fiber.Map{"task_id": taskID, "task": full, "collaborators": full.Collaborators})
	return c.JSON(fiber.Map{"success": true, "task": full, "collaborators": full.Collaborators, "version": full.Version})
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
	childIDs := make([]uuid.UUID, 0, len(items))
	for _, child := range items {
		childIDs = append(childIDs, child.ID)
	}
	byTask, e := s.repos.TaskWork.ListCollaboratorsByTaskIDs(c.Context(), accountID, childIDs)
	if e != nil {
		return taskWorkError(c, e)
	}
	for _, child := range items {
		child.Collaborators = byTask[child.ID]
		if child.Collaborators == nil {
			child.Collaborators = []*domain.TaskCollaborator{}
		}
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
	child := &domain.Task{AccountID: accountID, CreatedBy: userID, AssignedTo: assigned, Title: strings.TrimSpace(req.Title), Description: req.Description, Type: domain.TaskTypeReminder, Priority: req.Priority, Status: domain.TaskStatusPending, StatusID: &status.ID, ListID: parent.ListID, ParentTaskID: &parentID, IsAllDay: req.IsAllDay, MutationActor: &userID}
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
	s.invalidateTasksCache(accountID)
	return c.Status(201).JSON(fiber.Map{"success": true, "task": full})
}

func (s *Server) handleGetTaskComments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	limit, offset, pageErr := parseTaskCommentPage(c.Query("limit", "100"), c.Query("offset", "0"))
	if pageErr != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Paginación inválida"})
	}
	belongs, err := s.repos.TaskWork.TaskBelongsToAccount(c.Context(), accountID, taskID)
	if err != nil {
		return taskWorkError(c, err)
	}
	if !belongs {
		return c.Status(fiber.StatusNotFound).JSON(fiber.Map{"success": false, "error": "Tarea no encontrada"})
	}
	items, err := s.repos.TaskWork.ListComments(c.Context(), accountID, taskID, limit+1, offset)
	if err != nil {
		return taskWorkError(c, err)
	}
	hasMore := len(items) > limit
	items, hasMore = trimTaskCommentPage(items, limit)
	s.setTaskCommentPermissions(c, accountID, userID, items)
	nextOffset := offset
	if hasMore {
		nextOffset = offset + limit
	}
	return c.JSON(fiber.Map{"success": true, "comments": items, "has_more": hasMore, "next_offset": nextOffset})
}

// ListComments returns a chronological slice selected newest-first in SQL.
// When limit+1 rows are present, the extra row is therefore the oldest item
// at the beginning of the reversed slice, not the newest item at the end.
func trimTaskCommentPage(items []*domain.TaskComment, limit int) ([]*domain.TaskComment, bool) {
	if len(items) <= limit {
		return items, false
	}
	return items[len(items)-limit:], true
}

func parseTaskCommentPage(limitRaw, offsetRaw string) (int, int, error) {
	limit, limitErr := strconv.Atoi(limitRaw)
	offset, offsetErr := strconv.Atoi(offsetRaw)
	if limitErr != nil || offsetErr != nil || limit < 1 || limit > 100 || offset < 0 {
		return 0, 0, errors.New("invalid task comment pagination")
	}
	return limit, offset, nil
}

func (s *Server) handleCreateTaskComment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	var req struct {
		Body             string   `json:"body"`
		MentionedUserIDs []string `json:"mentioned_user_ids"`
		AttachmentIDs    []string `json:"attachment_ids"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El comentario está vacío"})
	}
	mentionIDs, parseErr := parseTaskUUIDList(req.MentionedUserIDs)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Mención inválida"})
	}
	attachmentIDs, parseErr := parseTaskUUIDList(req.AttachmentIDs)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	comment := &domain.TaskComment{AccountID: accountID, TaskID: taskID, AuthorID: userID, Body: strings.TrimSpace(req.Body)}
	if err := s.repos.TaskWork.CreateComment(c.Context(), comment, mentionIDs, attachmentIDs); err != nil {
		return taskWorkError(c, err)
	}
	full, err := s.repos.TaskWork.GetComment(c.Context(), accountID, taskID, comment.ID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.setTaskCommentPermissions(c, accountID, userID, []*domain.TaskComment{full})
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "comment_created", fiber.Map{"comment_id": comment.ID})
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "comment_created", fiber.Map{"task_id": taskID, "comment_id": comment.ID, "comment": taskCommentForRealtime(full)})
	if s.hub != nil && len(full.Mentions) > 0 {
		task, _ := s.services.Task.GetByID(c.Context(), taskID, accountID)
		title := "Tarea"
		if task != nil {
			title = task.Title
		}
		targetIDs := make([]uuid.UUID, 0, len(full.Mentions))
		for _, mention := range full.Mentions {
			targetIDs = append(targetIDs, mention.UserID)
		}
		s.hub.BroadcastToAccountUsersWithPermission(accountID, targetIDs, domain.PermTasks, ws.EventTaskMention, fiber.Map{
			"task_id": taskID, "comment_id": comment.ID, "task_title": title, "author_name": full.AuthorName,
		})
	}
	return c.Status(201).JSON(fiber.Map{"success": true, "comment": full})
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
		Body             string   `json:"body"`
		MentionedUserIDs []string `json:"mentioned_user_ids"`
		AttachmentIDs    []string `json:"attachment_ids"`
	}
	if err := c.BodyParser(&req); err != nil || strings.TrimSpace(req.Body) == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "El comentario está vacío"})
	}
	mentionIDs, parseErr := parseTaskUUIDList(req.MentionedUserIDs)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Mención inválida"})
	}
	attachmentIDs, parseErr := parseTaskUUIDList(req.AttachmentIDs)
	if parseErr != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Adjunto inválido"})
	}
	previous, err := s.repos.TaskWork.GetComment(c.Context(), accountID, taskID, commentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	previousMentionIDs := make(map[uuid.UUID]struct{}, len(previous.Mentions))
	for _, mention := range previous.Mentions {
		previousMentionIDs[mention.UserID] = struct{}{}
	}
	if err := s.repos.TaskWork.UpdateComment(c.Context(), accountID, taskID, commentID, userID, strings.TrimSpace(req.Body), s.isAccountAdmin(c, accountID, userID), mentionIDs, attachmentIDs); err != nil {
		return taskWorkError(c, err)
	}
	full, err := s.repos.TaskWork.GetComment(c.Context(), accountID, taskID, commentID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.setTaskCommentPermissions(c, accountID, userID, []*domain.TaskComment{full})
	s.broadcastTaskWork(accountID, "comment_updated", fiber.Map{"task_id": taskID, "comment_id": commentID, "comment": taskCommentForRealtime(full)})
	if s.hub != nil {
		newMentionIDs := make([]uuid.UUID, 0, len(full.Mentions))
		for _, mention := range full.Mentions {
			if _, existed := previousMentionIDs[mention.UserID]; !existed {
				newMentionIDs = append(newMentionIDs, mention.UserID)
			}
		}
		if len(newMentionIDs) > 0 {
			task, _ := s.services.Task.GetByID(c.Context(), taskID, accountID)
			title := "Tarea"
			if task != nil {
				title = task.Title
			}
			s.hub.BroadcastToAccountUsersWithPermission(accountID, newMentionIDs, domain.PermTasks, ws.EventTaskMention, fiber.Map{
				"task_id": taskID, "comment_id": commentID, "task_title": title, "author_name": full.AuthorName,
			})
		}
	}
	return c.JSON(fiber.Map{"success": true, "comment": full})
}

func taskCommentForRealtime(comment *domain.TaskComment) *domain.TaskComment {
	if comment == nil {
		return nil
	}
	copy := *comment
	// These permissions are viewer-specific and the account-wide websocket has
	// no single viewer. Each client preserves/fetches its own authoritative flags.
	copy.CanEdit = false
	copy.CanDelete = false
	return &copy
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
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "comment_deleted", fiber.Map{"task_id": taskID, "comment_id": commentID})
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
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "attachment_added", fiber.Map{"task_id": taskID, "attachment": item})
	return c.Status(201).JSON(fiber.Map{"success": true, "attachment": item})
}
func (s *Server) handleDeleteTaskAttachment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
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
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "attachment_deleted", fiber.Map{"attachment_id": attachmentID})
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "attachment_deleted", fiber.Map{"task_id": taskID, "attachment_id": attachmentID})
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
	relatedTaskIDs := []uuid.UUID{predecessorID, successorID}
	s.broadcastTaskWork(accountID, "dependency_added", fiber.Map{"task_id": predecessorID, "related_task_ids": relatedTaskIDs, "dependency": dep})
	s.broadcastTaskWork(accountID, "dependency_added", fiber.Map{"task_id": successorID, "related_task_ids": relatedTaskIDs, "dependency": dep})
	return c.Status(201).JSON(fiber.Map{"success": true, "dependency": dep})
}
func (s *Server) handleDeleteTaskDependency(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	dependencyID, err := uuid.Parse(c.Params("dependencyId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Dependencia inválida"})
	}
	dependency, err := s.repos.TaskWork.DeleteDependency(c.Context(), accountID, taskID, dependencyID)
	if err != nil {
		return taskWorkError(c, err)
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "dependency_deleted", fiber.Map{"dependency_id": dependencyID})
	relatedTaskIDs := []uuid.UUID{dependency.PredecessorTaskID, dependency.SuccessorTaskID}
	s.broadcastTaskWork(accountID, "dependency_deleted", fiber.Map{"task_id": dependency.PredecessorTaskID, "related_task_ids": relatedTaskIDs, "dependency_id": dependencyID})
	s.broadcastTaskWork(accountID, "dependency_deleted", fiber.Map{"task_id": dependency.SuccessorTaskID, "related_task_ids": relatedTaskIDs, "dependency_id": dependencyID})
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
	full, err := s.services.Task.GetByID(c.Context(), taskID, accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.services.Task.RebuildReminder(c.Context(), full)
	if children, err := s.repos.TaskWork.ListChildTasks(c.Context(), accountID, taskID); err == nil {
		for _, child := range children {
			s.services.Task.RebuildReminder(c.Context(), child)
		}
	}
	_ = s.repos.TaskWork.LogActivity(c.Context(), accountID, taskID, &userID, "restored", fiber.Map{})
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(accountID, "restored", fiber.Map{"task_id": taskID, "task": full})
	parentID := taskID
	if full.ParentTaskID != nil {
		parentID = *full.ParentTaskID
	}
	s.services.Task.NotifySubtasksUpdated(c.Context(), accountID, parentID)
	return c.JSON(fiber.Map{"success": true, "task": full})
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
	filters := taskQueryFilters(c)
	if key := invalidTaskQueryDateFilter(filters); key != "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Filtro de fecha inválido", "field": key})
	}
	filters["include_subtasks"] = "true"
	if folderID != nil {
		filters["folder_id"] = folderID.String()
	}
	if listID != nil {
		filters["list_id"] = listID.String()
	}
	const ganttPageSize = 1000
	const ganttMaxTasks = 5000
	allTasks, total, err := s.services.Task.GetByAccount(c.Context(), accountID, filters, ganttPageSize, 0)
	if err != nil {
		return taskWorkError(c, err)
	}
	if total > ganttMaxTasks {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{
			"success": false, "error": "El ámbito es demasiado grande para el Gantt; filtra por carpeta, lista, estado o fechas",
			"code": "gantt_scope_too_large", "total": total, "max_tasks": ganttMaxTasks,
		})
	}
	for offset := len(allTasks); offset < total; offset = len(allTasks) {
		page, _, pageErr := s.services.Task.GetByAccount(c.Context(), accountID, filters, ganttPageSize, offset)
		if pageErr != nil {
			return taskWorkError(c, pageErr)
		}
		if len(page) == 0 {
			break
		}
		allTasks = append(allTasks, page...)
	}
	tasks := make([]*domain.Task, 0, len(allTasks))
	for _, task := range allTasks {
		if taskIsScheduledForGantt(task) {
			tasks = append(tasks, task)
		}
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
	return c.JSON(fiber.Map{"success": true, "tasks": tasks, "dependencies": deps, "critical_task_ids": critical,
		"slack_minutes": slack, "total_count": total, "scheduled_count": len(tasks), "unscheduled_count": len(allTasks) - len(tasks)})
}

func taskIsScheduledForGantt(task *domain.Task) bool {
	return task != nil && task.StartAt != nil && task.DueAt != nil && !task.DueAt.Before(*task.StartAt)
}

func taskDurationMinutes(task *domain.Task) float64 {
	if taskIsScheduledForGantt(task) {
		return task.DueAt.Sub(*task.StartAt).Minutes()
	}
	return 0
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
