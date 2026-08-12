package api

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func parseTaskTrashEnvironmentID(raw string) (uuid.UUID, error) {
	environmentID, err := uuid.Parse(raw)
	if err != nil || environmentID == uuid.Nil {
		return uuid.Nil, errors.New("invalid task trash environment")
	}
	return environmentID, nil
}

type taskTrashMutationRequest struct {
	ConfirmationName string `json:"confirmation_name"`
	OperationID      string `json:"operation_id"`
	Version          *int64 `json:"version"`
}

func parseTaskTrashMutation(c *fiber.Ctx) (taskTrashMutationRequest, uuid.UUID, error) {
	request := taskTrashMutationRequest{}
	if len(c.Body()) > 0 {
		if err := c.BodyParser(&request); err != nil {
			return request, uuid.Nil, err
		}
	}
	operationID, err := taskStructureOperationID(request.OperationID)
	return request, operationID, err
}

func (s *Server) handleGetTaskTrashPolicy(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	days, err := s.repos.TaskWork.GetTrashRetentionDays(c.Context(), accountID)
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "retention_days": days, "can_manage": s.isAccountAdmin(c, accountID, userID)})
}

func (s *Server) handlePutTaskTrashPolicy(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	if !s.isAccountAdmin(c, accountID, userID) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Solo un administrador puede cambiar la retención"})
	}
	var request struct {
		RetentionDays json.RawMessage `json:"retention_days"`
	}
	if err := c.BodyParser(&request); err != nil || len(request.RetentionDays) == 0 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Política inválida"})
	}
	var days *int
	if string(request.RetentionDays) != "null" {
		var value int
		if err := json.Unmarshal(request.RetentionDays, &value); err != nil || value < 7 || value > 365 {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "El plazo debe estar entre 7 y 365 días, o ser Nunca"})
		}
		days = &value
	}
	if err := s.repos.TaskWork.UpdateTrashRetentionDays(c.Context(), accountID, days); err != nil {
		return taskWorkError(c, err)
	}
	s.broadcastTaskWork(c.Context(), accountID, "trash_policy_updated", fiber.Map{"retention_days": days})
	return c.JSON(fiber.Map{"success": true, "retention_days": days, "can_manage": true})
}

func (s *Server) handleGetTaskTrashContainers(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := parseTaskTrashEnvironmentID(c.Query("environment_id"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido", "code": "invalid_environment_id"})
	}
	items, err := s.repos.TaskWork.ListTrashContainers(c.Context(), accountID, userID, environmentID, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "containers": items})
}

func (s *Server) handleGetTaskTrashEnvironments(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	items, err := s.repos.TaskWork.ListTrashEnvironments(c.Context(), accountID, userID, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "environments": items})
}

func (s *Server) handleArchiveTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	_, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.repos.TaskWork.ArchiveList(c.Context(), accountID, userID, listID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "list_archived", fiber.Map{"list_id": listID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleUnarchiveTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	_, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.repos.TaskWork.UnarchiveList(c.Context(), accountID, userID, listID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "list_unarchived", fiber.Map{"list_id": listID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleArchiveTaskFolderHistorical(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	_, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.repos.TaskWork.ArchiveFolder(c.Context(), accountID, userID, folderID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "folder_archived", fiber.Map{"folder_id": folderID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleUnarchiveTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	_, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.repos.TaskWork.UnarchiveFolder(c.Context(), accountID, userID, folderID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "folder_unarchived", fiber.Map{"folder_id": folderID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleTrashTaskEnvironment(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := uuid.Parse(c.Params("environmentId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil || request.Version == nil || *request.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Confirmación y versión obligatorias"})
	}
	if err := s.repos.TaskWork.TrashEnvironment(c.Context(), accountID, userID, environmentID, request.ConfirmationName, *request.Version); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "environment_trashed", fiber.Map{"environment_id": environmentID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleRestoreTaskEnvironmentFromTrash(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := uuid.Parse(c.Params("environmentId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil || request.Version == nil || *request.Version < 1 {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Versión obligatoria"})
	}
	if err := s.repos.TaskWork.RestoreEnvironmentFromTrash(c.Context(), accountID, userID, environmentID, *request.Version); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "environment_restored", fiber.Map{"environment_id": environmentID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleRestoreTaskList(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	_ = request
	if err := s.repos.TaskWork.RestoreList(c.Context(), accountID, userID, listID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "list_restored", fiber.Map{"list_id": listID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) handleRestoreTaskFolder(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	_, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if err := s.repos.TaskWork.RestoreFolder(c.Context(), accountID, userID, folderID); err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "folder_restored", fiber.Map{"folder_id": folderID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID})
}

func (s *Server) requireTaskTrashAdmin(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	if !s.isAccountAdmin(c, accountID, userID) {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": "Solo un administrador puede eliminar permanentemente"})
	}
	return nil
}

func (s *Server) handlePurgeTask(c *fiber.Ctx) error {
	if err := s.requireTaskTrashAdmin(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	result, err := s.repos.TaskWork.PurgeTask(c.Context(), accountID, userID, taskID, request.ConfirmationName, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "task_purged", fiber.Map{"task_id": taskID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "purged": result})
}

func (s *Server) handlePurgeTaskList(c *fiber.Ctx) error {
	if err := s.requireTaskTrashAdmin(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	listID, err := uuid.Parse(c.Params("listId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Lista inválida"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	result, err := s.repos.TaskWork.PurgeList(c.Context(), accountID, userID, listID, request.ConfirmationName, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "list_purged", fiber.Map{"list_id": listID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "purged": result})
}

func (s *Server) handlePurgeTaskFolder(c *fiber.Ctx) error {
	if err := s.requireTaskTrashAdmin(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	folderID, err := uuid.Parse(c.Params("folderId"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Carpeta inválida"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	result, err := s.repos.TaskWork.PurgeFolder(c.Context(), accountID, userID, folderID, request.ConfirmationName, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "folder_purged", fiber.Map{"folder_id": folderID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "purged": result})
}

func (s *Server) handlePurgeTaskEnvironment(c *fiber.Ctx) error {
	if err := s.requireTaskTrashAdmin(c); err != nil {
		return err
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	environmentID, err := uuid.Parse(c.Params("environmentId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Entorno inválido"})
	}
	request, operationID, err := parseTaskTrashMutation(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	result, err := s.repos.TaskWork.PurgeEnvironment(c.Context(), accountID, userID, environmentID, request.ConfirmationName, time.Now().UTC())
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	s.broadcastTaskWork(c.Context(), accountID, "environment_purged", fiber.Map{"environment_id": environmentID, "operation_id": operationID})
	return c.JSON(fiber.Map{"success": true, "operation_id": operationID, "purged": result})
}
