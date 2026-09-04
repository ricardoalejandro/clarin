package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
)

type taskMyWorkCursorPayload struct {
	Version      int    `json:"v"`
	Section      string `json:"section"`
	Position     int64  `json:"position,omitempty"`
	ReasonRank   int    `json:"reason_rank,omitempty"`
	PriorityRank int    `json:"priority_rank,omitempty"`
	DueNullRank  int    `json:"due_null_rank,omitempty"`
	DueAtNano    int64  `json:"due_at_nano,omitempty"`
	TaskID       string `json:"task_id"`
}

type taskMyWorkMutationRequest struct {
	TaskID           string  `json:"task_id,omitempty"`
	BusinessDate     string  `json:"business_date"`
	ExpectedRevision *int64  `json:"expected_revision"`
	OperationID      string  `json:"operation_id"`
	BeforeTaskID     *string `json:"before_task_id,omitempty"`
}

func parseTaskMyWorkLimit(raw string) (int, error) {
	if strings.TrimSpace(raw) == "" {
		return 50, nil
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		return 0, repository.ErrTaskMyWorkInvalid
	}
	if limit > 200 {
		limit = 200
	}
	return limit, nil
}

func decodeTaskMyWorkCursor(raw, section string) (*repository.TaskMyWorkFocusCursor, *repository.TaskMyWorkSuggestionCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, nil, repository.ErrTaskMyWorkInvalid
	}
	var payload taskMyWorkCursorPayload
	if err := json.Unmarshal(decoded, &payload); err != nil || payload.Version != 1 || payload.Section != section {
		return nil, nil, repository.ErrTaskMyWorkInvalid
	}
	taskID, err := uuid.Parse(payload.TaskID)
	if err != nil {
		return nil, nil, repository.ErrTaskMyWorkInvalid
	}
	switch section {
	case "focus":
		if payload.Position < 1 {
			return nil, nil, repository.ErrTaskMyWorkInvalid
		}
		return &repository.TaskMyWorkFocusCursor{Position: payload.Position, TaskID: taskID}, nil, nil
	case "suggestions":
		if payload.ReasonRank < 0 || payload.PriorityRank < 0 || (payload.DueNullRank != 0 && payload.DueNullRank != 1) {
			return nil, nil, repository.ErrTaskMyWorkInvalid
		}
		dueAt := time.Unix(0, payload.DueAtNano).UTC()
		return nil, &repository.TaskMyWorkSuggestionCursor{
			ReasonRank: payload.ReasonRank, PriorityRank: payload.PriorityRank, DueNullRank: payload.DueNullRank, DueAt: dueAt, TaskID: taskID,
		}, nil
	default:
		return nil, nil, repository.ErrTaskMyWorkInvalid
	}
}

func encodeTaskMyWorkFocusCursor(cursor *repository.TaskMyWorkFocusCursor) (string, error) {
	if cursor == nil {
		return "", nil
	}
	return encodeTaskMyWorkCursor(taskMyWorkCursorPayload{Version: 1, Section: "focus", Position: cursor.Position, TaskID: cursor.TaskID.String()})
}

func encodeTaskMyWorkSuggestionCursor(cursor *repository.TaskMyWorkSuggestionCursor) (string, error) {
	if cursor == nil {
		return "", nil
	}
	return encodeTaskMyWorkCursor(taskMyWorkCursorPayload{
		Version: 1, Section: "suggestions", ReasonRank: cursor.ReasonRank, PriorityRank: cursor.PriorityRank,
		DueNullRank: cursor.DueNullRank, DueAtNano: cursor.DueAt.UTC().UnixNano(), TaskID: cursor.TaskID.String(),
	})
}

func encodeTaskMyWorkCursor(payload taskMyWorkCursorPayload) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (s *Server) handleGetTaskMyWorkSummary(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	summary, err := s.repos.TaskWork.TaskMyWorkSummary(c.Context(), accountID, actorID, time.Now())
	if err != nil {
		return taskMyWorkError(c, err, nil)
	}
	return c.JSON(fiber.Map{"success": true, "summary": summary})
}

func (s *Server) handleGetTaskMyWork(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	section := strings.ToLower(strings.TrimSpace(c.Query("section", "all")))
	if section != "all" && section != "focus" && section != "suggestions" {
		return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
	}
	if section == "all" && strings.TrimSpace(c.Query("cursor")) != "" {
		return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
	}
	limit, err := parseTaskMyWorkLimit(c.Query("limit"))
	if err != nil {
		return taskMyWorkError(c, err, nil)
	}
	focusCursor, suggestionCursor, err := decodeTaskMyWorkCursor(c.Query("cursor"), section)
	if err != nil {
		return taskMyWorkError(c, err, nil)
	}
	now := time.Now()
	summary, err := s.repos.TaskWork.TaskMyWorkSummary(c.Context(), accountID, actorID, now)
	if err != nil {
		return taskMyWorkError(c, err, nil)
	}
	response := fiber.Map{
		"success": true, "summary": summary,
		"focus_items": []*repository.TaskMyWorkItem{}, "completed_items": []*repository.TaskMyWorkItem{},
		"suggestions": []*repository.TaskMyWorkSuggestion{}, "focus_next_cursor": "", "suggestions_next_cursor": "",
	}
	if section == "all" || section == "focus" {
		focusLimit := limit
		if section == "all" {
			focusLimit = repository.TaskMyWorkMaxItems
		}
		items, next, listErr := s.repos.TaskWork.ListTaskMyWorkFocus(c.Context(), accountID, actorID, now, focusLimit, focusCursor)
		if listErr != nil {
			return taskMyWorkError(c, listErr, summary)
		}
		focus := make([]*repository.TaskMyWorkItem, 0, len(items))
		completed := make([]*repository.TaskMyWorkItem, 0, len(items))
		for _, item := range items {
			if repository.TaskMyWorkTaskIsClosed(item.Task) {
				completed = append(completed, item)
			} else {
				focus = append(focus, item)
			}
		}
		nextCursor, encodeErr := encodeTaskMyWorkFocusCursor(next)
		if encodeErr != nil {
			return taskMyWorkError(c, encodeErr, summary)
		}
		response["focus_items"] = focus
		response["completed_items"] = completed
		response["focus_next_cursor"] = nextCursor
	}
	if section == "all" || section == "suggestions" {
		suggestions, next, listErr := s.repos.TaskWork.ListTaskMyWorkSuggestions(c.Context(), accountID, actorID, now, limit, suggestionCursor)
		if listErr != nil {
			return taskMyWorkError(c, listErr, summary)
		}
		nextCursor, encodeErr := encodeTaskMyWorkSuggestionCursor(next)
		if encodeErr != nil {
			return taskMyWorkError(c, encodeErr, summary)
		}
		response["suggestions"] = suggestions
		response["suggestions_next_cursor"] = nextCursor
	}
	return c.JSON(response)
}

func (s *Server) handleAddTaskMyWorkItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	var req taskMyWorkMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
	}
	taskID, err := uuid.Parse(strings.TrimSpace(req.TaskID))
	operationID, inputErr := parseTaskMyWorkMutationInput(req, err)
	if inputErr != nil {
		return taskMyWorkError(c, inputErr, nil)
	}
	result, err := s.repos.TaskWork.AddTaskMyWorkItem(c.Context(), accountID, actorID, taskID, req.BusinessDate, *req.ExpectedRevision, operationID, time.Now())
	if err != nil {
		return s.writeTaskMyWorkMutationError(c, accountID, actorID, err)
	}
	s.broadcastTaskMyWorkMutation(accountID, actorID, "my_work_added", result)
	return c.JSON(fiber.Map{"success": true, "mutation": result})
}

func (s *Server) handleReorderTaskMyWorkItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	taskID, pathErr := uuid.Parse(c.Params("taskId"))
	var req taskMyWorkMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
	}
	operationID, inputErr := parseTaskMyWorkMutationInput(req, pathErr)
	if inputErr != nil {
		return taskMyWorkError(c, inputErr, nil)
	}
	var beforeTaskID *uuid.UUID
	if req.BeforeTaskID != nil && strings.TrimSpace(*req.BeforeTaskID) != "" {
		parsed, err := uuid.Parse(strings.TrimSpace(*req.BeforeTaskID))
		if err != nil {
			return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
		}
		beforeTaskID = &parsed
	}
	result, err := s.repos.TaskWork.ReorderTaskMyWorkItem(c.Context(), accountID, actorID, taskID, beforeTaskID, req.BusinessDate, *req.ExpectedRevision, operationID, time.Now())
	if err != nil {
		return s.writeTaskMyWorkMutationError(c, accountID, actorID, err)
	}
	s.broadcastTaskMyWorkMutation(accountID, actorID, "my_work_reordered", result)
	return c.JSON(fiber.Map{"success": true, "mutation": result})
}

func (s *Server) handleRemoveTaskMyWorkItem(c *fiber.Ctx) error {
	accountID := c.Locals("account_id").(uuid.UUID)
	actorID := c.Locals("user_id").(uuid.UUID)
	taskID, pathErr := uuid.Parse(c.Params("taskId"))
	var req taskMyWorkMutationRequest
	if err := c.BodyParser(&req); err != nil {
		return taskMyWorkError(c, repository.ErrTaskMyWorkInvalid, nil)
	}
	operationID, inputErr := parseTaskMyWorkMutationInput(req, pathErr)
	if inputErr != nil {
		return taskMyWorkError(c, inputErr, nil)
	}
	result, err := s.repos.TaskWork.RemoveTaskMyWorkItem(c.Context(), accountID, actorID, taskID, req.BusinessDate, *req.ExpectedRevision, operationID, time.Now())
	if err != nil {
		return s.writeTaskMyWorkMutationError(c, accountID, actorID, err)
	}
	s.broadcastTaskMyWorkMutation(accountID, actorID, "my_work_removed", result)
	return c.JSON(fiber.Map{"success": true, "mutation": result})
}

func parseTaskMyWorkMutationInput(req taskMyWorkMutationRequest, previousErr error) (uuid.UUID, error) {
	if previousErr != nil || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || strings.TrimSpace(req.BusinessDate) == "" {
		return uuid.Nil, repository.ErrTaskMyWorkInvalid
	}
	operationID, err := uuid.Parse(strings.TrimSpace(req.OperationID))
	if err != nil || operationID == uuid.Nil {
		return uuid.Nil, repository.ErrTaskMyWorkInvalid
	}
	return operationID, nil
}

func (s *Server) writeTaskMyWorkMutationError(c *fiber.Ctx, accountID, actorID uuid.UUID, err error) error {
	var summary *repository.TaskMyWorkSummary
	if errors.Is(err, repository.ErrTaskMyWorkDateChanged) || errors.Is(err, repository.ErrTaskMyWorkRevisionConflict) {
		summary, _ = s.repos.TaskWork.TaskMyWorkSummary(c.Context(), accountID, actorID, time.Now())
	}
	return taskMyWorkError(c, err, summary)
}

func taskMyWorkError(c *fiber.Ctx, err error, summary *repository.TaskMyWorkSummary) error {
	payload := fiber.Map{"success": false, "error": "No se pudo completar la operación de Mi trabajo."}
	status := fiber.StatusInternalServerError
	switch {
	case errors.Is(err, repository.ErrTaskWorkNotFound):
		status, payload["code"], payload["error"] = fiber.StatusNotFound, "task_not_found", "La tarea no existe o ya no está visible."
	case errors.Is(err, repository.ErrTaskMyWorkDateChanged):
		status, payload["code"], payload["error"] = fiber.StatusConflict, "business_date_changed", "Comenzó un nuevo día. Actualizamos Mi trabajo antes de continuar."
	case errors.Is(err, repository.ErrTaskMyWorkRevisionConflict):
		status, payload["code"], payload["error"] = fiber.StatusConflict, "my_work_revision_conflict", "Mi trabajo cambió en otra sesión. Actualiza y reintenta."
	case errors.Is(err, repository.ErrTaskMyWorkLimitReached):
		status, payload["code"], payload["error"] = fiber.StatusConflict, "my_work_limit_reached", "Mi trabajo admite hasta 200 tareas por día."
	case errors.Is(err, repository.ErrTaskMyWorkInvalid):
		status, payload["code"], payload["error"] = fiber.StatusBadRequest, "invalid_my_work_request", "La solicitud de Mi trabajo no es válida."
	}
	if summary != nil {
		payload["summary"] = summary
	}
	return c.Status(status).JSON(payload)
}

func (s *Server) broadcastTaskMyWorkMutation(accountID, actorID uuid.UUID, action string, result *repository.TaskMyWorkMutationResult) {
	if result == nil || result.Idempotent {
		return
	}
	s.hub.BroadcastToAccountUsersWithPermission(accountID, []uuid.UUID{actorID}, domain.PermTasks, ws.EventTaskUpdate, fiber.Map{
		"action": action, "my_work": result, "operation_id": result.OperationID,
	})
}
