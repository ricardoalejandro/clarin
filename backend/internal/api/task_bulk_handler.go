package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type taskBulkVersionRequest struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}

func parseTaskVersionInputs(raw []taskBulkVersionRequest) ([]repository.TaskVersionInput, error) {
	items := make([]repository.TaskVersionInput, 0, len(raw))
	for _, item := range raw {
		id, err := uuid.Parse(strings.TrimSpace(item.ID))
		if err != nil || item.Version < 1 {
			return nil, repository.ErrTaskBulkUpdateInvalid
		}
		items = append(items, repository.TaskVersionInput{ID: id, Version: item.Version})
	}
	return items, nil
}

func (s *Server) canonicalTasks(c *fiber.Ctx, accountID uuid.UUID, ids []uuid.UUID) ([]*domain.Task, error) {
	actorID := c.Locals("user_id").(uuid.UUID)
	result := make([]*domain.Task, 0, len(ids))
	for _, id := range ids {
		task, err := s.services.Task.GetByIDForActor(c.Context(), id, accountID, actorID)
		if err != nil {
			return nil, err
		}
		result = append(result, task)
	}
	return result, nil
}

func (s *Server) handleBulkUpdateTasks(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		Items         []taskBulkVersionRequest `json:"items"`
		Property      string                   `json:"property"`
		Value         json.RawMessage          `json:"value"`
		OperationID   string                   `json:"operation_id"`
		ConfirmGrants bool                     `json:"confirm_grants"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	items, err := parseTaskVersionInputs(req.Items)
	if err != nil {
		return taskWorkError(c, err)
	}
	taskIDs := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		taskIDs = append(taskIDs, item.ID)
	}
	if err := s.requireTaskIDsAccess(c, taskIDs, domain.TaskAccessEdit); err != nil {
		return taskWorkError(c, err)
	}
	parsedOperation, err := parseTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	operation := uuid.New()
	if parsedOperation != nil {
		operation = *parsedOperation
	}
	property := strings.ToLower(strings.TrimSpace(req.Property))
	var value any
	switch property {
	case "priority":
		var v string
		if json.Unmarshal(req.Value, &v) != nil || !validTaskPriority(v) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Prioridad inválida"})
		}
		value = v
	case "type":
		var v string
		if json.Unmarshal(req.Value, &v) != nil || !validTaskType(v) {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tipo inválido"})
		}
		value = v
	case "assigned_to":
		var raw string
		if json.Unmarshal(req.Value, &raw) != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Responsable inválido"})
		}
		id, parseErr := uuid.Parse(raw)
		if parseErr != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "Responsable inválido"})
		}
		value = id
	case "due_at":
		if string(req.Value) == "null" {
			value = nil
		} else {
			var raw string
			if json.Unmarshal(req.Value, &raw) != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha inválida"})
			}
			parsed, parseErr := time.Parse(time.RFC3339, raw)
			if parseErr != nil {
				return c.Status(400).JSON(fiber.Map{"success": false, "error": "Fecha inválida"})
			}
			value = parsed
		}
	default:
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Propiedad masiva no soportada"})
	}
	result, err := s.repos.TaskWork.BulkUpdateTasks(c.Context(), accountID, repository.TaskBulkUpdateInput{
		Items: items, Property: property, Value: value, ActorID: actorID, Operation: operation,
		ConfirmParticipantGrants: req.ConfirmGrants,
	})
	if err != nil {
		var confirmation *repository.TaskParticipantAccessConfirmationError
		if errors.As(err, &confirmation) {
			return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "code": "access_change_confirmation_required",
				"affected_user_ids": confirmation.AffectedUserIDs})
		}
		return taskWorkError(c, err)
	}
	tasks, err := s.canonicalTasks(c, accountID, result.TaskIDs)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	counts := s.taskHierarchyCounts(c.Context(), accountID, actorID)
	payload := putTaskMutationReconciliation(fiber.Map{"property": property, "tasks": tasks}, operation, counts)
	s.broadcastTaskWork(c.Context(), accountID, "bulk_updated", payload)
	return c.JSON(putTaskMutationReconciliation(fiber.Map{"success": true, "tasks": tasks}, operation, counts))
}

func (s *Server) handleBulkTrashTasks(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		Items        []taskBulkVersionRequest `json:"items"`
		Confirmation string                   `json:"confirmation"`
		OperationID  string                   `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	expected := fmt.Sprintf("MOVER %d TAREAS", len(req.Items))
	if req.Confirmation != expected {
		return c.Status(422).JSON(fiber.Map{"success": false, "error": "Escribe exactamente " + expected, "code": "trash_confirmation_mismatch"})
	}
	items, err := parseTaskVersionInputs(req.Items)
	if err != nil {
		return taskWorkError(c, repository.ErrTaskBulkTrashInvalid)
	}
	taskIDs := make([]uuid.UUID, 0, len(items))
	for _, item := range items {
		taskIDs = append(taskIDs, item.ID)
	}
	if err := s.requireTaskIDsAccess(c, taskIDs, domain.TaskAccessFull); err != nil {
		return taskWorkError(c, err)
	}
	parsedOperation, err := parseTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	operation := uuid.New()
	if parsedOperation != nil {
		operation = *parsedOperation
	}
	result, err := s.repos.TaskWork.BulkTrashTasks(c.Context(), accountID, actorID, items)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	counts := s.taskHierarchyCounts(c.Context(), accountID, actorID)
	payload := putTaskMutationReconciliation(fiber.Map{"task_ids": result.TaskIDs}, operation, counts)
	s.broadcastTaskWork(c.Context(), accountID, "bulk_deleted", payload)
	return c.JSON(putTaskMutationReconciliation(fiber.Map{"success": true, "task_ids": result.TaskIDs}, operation, counts))
}

func (s *Server) handleGanttReschedule(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req struct {
		TaskID                 string `json:"task_id"`
		Version                int64  `json:"version"`
		StartAt                string `json:"start_at"`
		DueAt                  string `json:"due_at"`
		RescheduleDependencies bool   `json:"reschedule_dependencies"`
		OperationID            string `json:"operation_id"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	taskID, err := uuid.Parse(req.TaskID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}
	if _, accessErr := s.repos.TaskWork.RequireTaskAccess(c.Context(), accountID, actorID, taskID, domain.TaskAccessEdit); accessErr != nil {
		return taskWorkError(c, accessErr)
	}
	start, err := time.Parse(time.RFC3339, req.StartAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Inicio inválido"})
	}
	due, err := time.Parse(time.RFC3339, req.DueAt)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "Entrega inválida"})
	}
	parsedOperation, err := parseTaskOperationID(req.OperationID)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}
	operation := uuid.New()
	if parsedOperation != nil {
		operation = *parsedOperation
	}
	result, err := s.repos.TaskWork.RescheduleTaskChain(c.Context(), accountID, repository.TaskGanttRescheduleInput{TaskID: taskID, Version: req.Version, StartAt: start, DueAt: due, RescheduleDependencies: req.RescheduleDependencies, ActorID: actorID})
	if err != nil {
		return taskWorkError(c, err)
	}
	tasks, err := s.canonicalTasks(c, accountID, result.TaskIDs)
	if err != nil {
		return taskWorkError(c, err)
	}
	s.invalidateTasksCache(accountID)
	payload := fiber.Map{"operation_id": operation.String(), "tasks": tasks}
	s.broadcastTaskWorkToCommonViewers(c.Context(), accountID, result.TaskIDs, "gantt_rescheduled", payload)
	return c.JSON(fiber.Map{"success": true, "operation_id": operation.String(), "tasks": tasks})
}
