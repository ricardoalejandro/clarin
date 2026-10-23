package api

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

func taskRemovalTarget(c *fiber.Ctx) (string, uuid.UUID, error) {
	kind, raw := domain.TaskAccessTargetList, c.Params("listId")
	if folder := c.Params("folderId"); folder != "" {
		kind, raw = domain.TaskAccessTargetFolder, folder
	}
	id, err := uuid.Parse(raw)
	if err != nil || id == uuid.Nil {
		return "", uuid.Nil, errors.New("invalid removal target")
	}
	return kind, id, nil
}

func parseTaskRemovalRequest(raw []byte, execute bool) (domain.TaskContainerRemovalRequest, uuid.UUID, error) {
	var request struct {
		domain.TaskContainerRemovalRequest
		OperationID string `json:"operation_id"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return request.TaskContainerRemovalRequest, uuid.Nil, err
	}
	request.Mode = strings.TrimSpace(request.Mode)
	if request.Mode != "trash_all" && request.Mode != "preserve_contents" {
		return request.TaskContainerRemovalRequest, uuid.Nil, errors.New("invalid removal mode")
	}
	if request.DestinationListID != nil && *request.DestinationListID == uuid.Nil {
		return request.TaskContainerRemovalRequest, uuid.Nil, errors.New("invalid removal destination")
	}
	if !execute {
		return request.TaskContainerRemovalRequest, uuid.Nil, nil
	}
	operationID, err := uuid.Parse(request.OperationID)
	if err != nil || operationID == uuid.Nil || strings.TrimSpace(request.PreviewToken) == "" {
		return request.TaskContainerRemovalRequest, uuid.Nil, errors.New("preview and operation required")
	}
	return request.TaskContainerRemovalRequest, operationID, nil
}

func (s *Server) handlePreviewTaskContainerRemoval(c *fiber.Ctx) error {
	kind, targetID, err := taskRemovalTarget(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista o carpeta inválida"})
	}
	request, _, err := parseTaskRemovalRequest(c.Body(), false)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Opciones de eliminación inválidas"})
	}
	accountID, actorID := c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID)
	preview, err := s.repos.TaskWork.PreviewTaskContainerRemoval(c.Context(), accountID, actorID, targetID, kind, request, s.workWhiteboardViewsEnabled())
	if err != nil {
		return taskWorkError(c, err)
	}
	return c.JSON(fiber.Map{"success": true, "preview": preview})
}

func (s *Server) handleRemoveTaskContainer(c *fiber.Ctx) error {
	kind, targetID, err := taskRemovalTarget(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista o carpeta inválida"})
	}
	request, operationID, err := parseTaskRemovalRequest(c.Body(), true)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Revisa la preparación antes de confirmar", "code": "invalid_removal_request"})
	}
	accountID, actorID := c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID)
	result, err := s.repos.TaskWork.RemoveTaskContainer(c.Context(), accountID, actorID, targetID, kind, request, operationID, s.workWhiteboardViewsEnabled())
	if errors.Is(err, repository.ErrTaskRemovalPreviewChanged) {
		payload := fiber.Map{"success": false, "error": "El contenido o los permisos cambiaron. Revisa el resumen actualizado y confirma otra vez.", "code": "removal_preview_changed"}
		if preview, previewErr := s.repos.TaskWork.PreviewTaskContainerRemoval(c.Context(), accountID, actorID, targetID, kind, request, s.workWhiteboardViewsEnabled()); previewErr == nil {
			payload["preview"] = preview
		}
		return c.Status(fiber.StatusConflict).JSON(payload)
	}
	if err != nil {
		if errors.Is(err, repository.ErrWorkEventCancelRequired) {
			return c.Status(fiber.StatusUnprocessableEntity).JSON(fiber.Map{"success": false, "error": "Confirma la cancelación de los eventos futuros con invitados antes de enviarlos a Papelera", "code": "work_event_cancel_required"})
		}
		return taskWorkError(c, err)
	}
	if !result.Replayed {
		s.revokeTaskLocationWhiteboardSockets(accountID, result.WhiteboardIDs)
		s.invalidateTasksCache(accountID)
		s.broadcastTaskContainerLifecycleInvalidation(c.Context(), accountID, result.EnvironmentID, operationID, "container_removed")
	}
	response := fiber.Map{"success": true, "operation_id": operationID, "result": result}
	// Counts belong to this actor. They must never be reused as the inventory
	// sent to other viewers whose folder/list/task grants can differ.
	if counts, countErr := s.repos.TaskWork.HierarchyCountsForActor(c.Context(), accountID, actorID, &result.EnvironmentID); countErr == nil {
		response["hierarchy_counts"] = counts
	}
	return c.JSON(response)
}

func (s *Server) broadcastTaskContainerLifecycleInvalidation(ctx context.Context, accountID, environmentID, operationID uuid.UUID, action string) {
	if s.hub == nil {
		return
	}
	recipients, err := s.repos.TaskWork.EnvironmentViewerUserIDs(ctx, accountID, environmentID)
	if err != nil || len(recipients) == 0 {
		return
	}
	// An Entorno viewer may be denied the removed container. Invalidation only
	// names the already-authorized Entorno, never a private child or its counts.
	s.hub.BroadcastToAccountUsersWithPermission(accountID, recipients, domain.PermTasks, ws.EventTaskUpdate, fiber.Map{
		"action": action, "environment_id": environmentID, "operation_id": operationID, "structure_changed": true,
	})
}

func (s *Server) handleTaskRemovalDestinations(c *fiber.Ctx) error {
	kind, targetID, err := taskRemovalTarget(c)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Lista o carpeta inválida"})
	}
	accountID, actorID := c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID)
	contextKey := taskStructurePageContext(accountID, "removal-destinations:"+actorID.String()+":"+kind+":"+targetID.String(), c.Query("search"))
	limit, cursor, err := parseTaskEnvironmentPage(c, contextKey)
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "Paginación inválida"})
	}
	items, next, err := s.repos.TaskWork.ListTaskRemovalDestinations(c.Context(), accountID, actorID, targetID, kind, limit, cursor, c.Query("search"))
	if err != nil {
		return taskWorkError(c, err)
	}
	response, err := taskEnvironmentPageResponse("lists", items, next, contextKey)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "No se pudieron cargar los destinos"})
	}
	return c.JSON(response)
}

func (s *Server) taskContainerRestoredResponse(c *fiber.Ctx, accountID, actorID, targetID, operationID uuid.UUID, kind string) error {
	response := fiber.Map{"success": true, "operation_id": operationID}
	if environmentID, err := s.repos.TaskWork.ContainerEnvironmentID(c.Context(), accountID, targetID, kind); err == nil {
		s.broadcastTaskContainerLifecycleInvalidation(c.Context(), accountID, environmentID, operationID, "container_restored")
		if counts, countErr := s.repos.TaskWork.HierarchyCountsForActor(c.Context(), accountID, actorID, &environmentID); countErr == nil {
			response["hierarchy_counts"] = counts
		}
	}
	return c.JSON(response)
}
