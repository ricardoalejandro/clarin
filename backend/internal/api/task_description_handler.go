package api

import (
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

type taskDescriptionUpdateRequest struct {
	Description *string `json:"description"`
	Version     *int64  `json:"version"`
	OperationID string  `json:"operation_id"`
}

func taskDescriptionRequestError(request taskDescriptionUpdateRequest) string {
	if request.Description == nil {
		return "La descripción es obligatoria"
	}
	if request.Version == nil || *request.Version < 1 {
		return "La versión de la tarea es obligatoria"
	}
	return ""
}

func taskDescriptionConflictResponse(state *repository.TaskDescriptionState) fiber.Map {
	return fiber.Map{
		"success": false,
		"code":    "version_conflict",
		"error":   "La descripción cambió en otra sesión",
		"current": fiber.Map{
			"description": state.Description,
			"version":     state.Version,
			"updated_at":  state.UpdatedAt,
		},
	}
}

func taskDescriptionSuccessResponse(state *repository.TaskDescriptionState, operationID uuid.UUID) fiber.Map {
	return fiber.Map{
		"success":      true,
		"operation_id": operationID.String(),
		"current": fiber.Map{
			"description": state.Description,
			"version":     state.Version,
			"updated_at":  state.UpdatedAt,
		},
	}
}

func (s *Server) handleUpdateTaskDescription(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	taskID, err := uuid.Parse(strings.TrimSpace(c.Params("id")))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Tarea inválida"})
	}

	var request taskDescriptionUpdateRequest
	if err := c.BodyParser(&request); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Solicitud inválida"})
	}
	if validationError := taskDescriptionRequestError(request); validationError != "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": validationError})
	}
	operationID, err := resolveTaskOperationID(request.OperationID)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "operation_id inválido"})
	}

	state, err := s.services.Task.UpdateDescription(c.Context(), accountID, actorID, taskID,
		*request.Description, *request.Version, *operationID)
	if errors.Is(err, repository.ErrTaskVersionConflict) && state != nil {
		return c.Status(fiber.StatusConflict).JSON(taskDescriptionConflictResponse(state))
	}
	if err != nil {
		return taskWorkError(c, err)
	}
	if state.Changed {
		s.invalidateTasksCache(accountID)
		s.services.Task.PublishDescriptionUpdated(c.Context(), accountID, taskID, state, *operationID)
	}
	return c.JSON(taskDescriptionSuccessResponse(state, *operationID))
}
