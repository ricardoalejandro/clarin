package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/eroscontext"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

type erosRunRequest struct {
	ClientRequestID string         `json:"client_request_id"`
	ConversationID  string         `json:"conversation_id"`
	Kind            string         `json:"kind"`
	Message         string         `json:"message"`
	TaskKey         string         `json:"task_key"`
	Parameters      map[string]any `json:"parameters"`
	CurrentPage     string         `json:"current_page"`
	ReasoningEffort string         `json:"reasoning_effort"`
}

type erosRunAnswerRequest struct {
	ClientRequestID string `json:"client_request_id"`
	OptionID        string `json:"option_id"`
	CustomText      string `json:"custom_text"`
}

type erosStoredRunParameters struct {
	CurrentPage         string         `json:"current_page,omitempty"`
	ReasoningEffort     string         `json:"reasoning_effort,omitempty"`
	Task                map[string]any `json:"task,omitempty"`
	ReasoningReason     string         `json:"reasoning_reason,omitempty"`
	ClarificationAnswer map[string]any `json:"clarification_answer,omitempty"`
}

func claimsPermissions(claims *service.JWTClaims) []string {
	if claims == nil {
		return nil
	}
	if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
		return []string{domain.PermAll}
	}
	return append([]string(nil), claims.Permissions...)
}

func hasModulePermission(permissions []string, module string) bool {
	for _, permission := range permissions {
		if permission == domain.PermAll || permission == module {
			return true
		}
	}
	return false
}

func quickTaskPermission(definition service.ErosQuickTaskDefinition) string {
	if definition.Permission != "" {
		return definition.Permission
	}
	switch definition.Category {
	case "conversaciones":
		return domain.PermChats
	case "tareas":
		return domain.PermTasks
	default:
		return domain.PermLeads
	}
}

func canUseQuickTask(permissions []string, definition service.ErosQuickTaskDefinition) bool {
	if definition.ID == service.ErosQuickTaskExportCurrentResult {
		return len(permissions) > 0
	}
	if definition.ID == service.ErosQuickTaskPerformanceOverview {
		for _, permission := range []string{domain.PermBroadcasts, domain.PermEvents, domain.PermPrograms, domain.PermSurveys} {
			if !hasModulePermission(permissions, permission) {
				return false
			}
		}
		return true
	}
	return hasModulePermission(permissions, quickTaskPermission(definition))
}

func (s *Server) handleListErosQuickTasks(c *fiber.Ctx) error {
	claims, _ := c.Locals("claims").(*service.JWTClaims)
	permissions := claimsPermissions(claims)
	catalog := service.ErosQuickTaskCatalog()
	tasks := make([]service.ErosQuickTaskDefinition, 0, len(catalog))
	for _, task := range catalog {
		if canUseQuickTask(permissions, task) {
			tasks = append(tasks, task)
		}
	}
	return c.JSON(fiber.Map{"success": true, "tasks": tasks})
}

func (s *Server) handleCreateErosRun(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok || accountID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	settings, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could_not_load_eros_settings"})
	}
	allowed, code, err := s.requireErosUserAccess(c.Context(), userID, settings)
	if err != nil || !allowed {
		if err != nil {
			code = "could_not_verify_eros_access"
		}
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": code})
	}

	var req erosRunRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_request"})
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.ClientRequestID))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "client_request_id_must_be_uuid"})
	}
	req.Kind = strings.ToLower(strings.TrimSpace(req.Kind))
	if req.Kind == "" {
		req.Kind = "chat"
	}
	if req.Kind != "chat" && req.Kind != "quick_task" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_run_kind"})
	}
	permissions := claimsPermissions(c.Locals("claims").(*service.JWTClaims))
	message := strings.TrimSpace(req.Message)
	if req.Kind == "chat" && message == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "message_is_required"})
	}
	if req.Kind == "quick_task" {
		task, found := service.ErosQuickTaskByID(strings.TrimSpace(req.TaskKey))
		if !found || !task.ReadOnly || !canUseQuickTask(permissions, task) {
			return c.Status(403).JSON(fiber.Map{"success": false, "error": "quick_task_not_allowed"})
		}
		if message == "" {
			message = task.Title
		}
	}

	conv, err := s.resolveErosConversation(c.Context(), accountID, userID, req.ConversationID, message)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "conversation_not_found"})
	}
	effort, reason := automaticErosReasoning(message, req.Kind, req.TaskKey, settings)
	stored := erosStoredRunParameters{
		CurrentPage:     strings.TrimSpace(req.CurrentPage),
		ReasoningEffort: effort,
		ReasoningReason: reason,
		Task:            req.Parameters,
	}
	params, _ := json.Marshal(stored)
	run, created, err := s.repos.ErosRun.CreateWithUserMessage(c.Context(), &domain.ErosRun{
		ID:             uuid.New(),
		AccountID:      accountID,
		UserID:         userID,
		ConversationID: conv.ID,
		Kind:           req.Kind,
		TaskKey:        strings.TrimSpace(req.TaskKey),
		Parameters:     params,
		Permissions:    permissions,
		IdempotencyKey: requestID.String(),
		MaxAttempts:    2,
	}, message)
	if repository.IsErosConversationBusy(err) {
		return c.Status(fiber.StatusConflict).JSON(fiber.Map{"success": false, "error": "conversation_run_active"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could_not_create_eros_run"})
	}
	status := fiber.StatusAccepted
	if !created {
		status = fiber.StatusOK
	}
	return c.Status(status).JSON(fiber.Map{"success": true, "run": run})
}

func parseErosRunID(c *fiber.Ctx) (uuid.UUID, error) {
	return uuid.Parse(strings.TrimSpace(c.Params("id")))
}

func (s *Server) enrichErosRun(ctx context.Context, run *domain.ErosRun) {
	if run == nil || (run.Status != domain.ErosRunCompleted && run.Status != domain.ErosRunWaitingForInput) {
		return
	}
	conv, err := s.repos.ErosConversation.GetWithMessages(ctx, run.AccountID, run.UserID, run.ConversationID)
	if err != nil {
		return
	}
	for i := range conv.Messages {
		if conv.Messages[i].RunID != nil && *conv.Messages[i].RunID == run.ID && conv.Messages[i].Role == "assistant" {
			run.Message = &conv.Messages[i]
			return
		}
	}
}

func (s *Server) handleGetErosRun(c *fiber.Ctx) error {
	runID, err := parseErosRunID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_run_id"})
	}
	run, err := s.repos.ErosRun.Get(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID), runID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "run_not_found"})
	}
	s.enrichErosRun(c.Context(), run)
	return c.JSON(fiber.Map{"success": true, "run": run})
}

func (s *Server) handleListActiveErosRuns(c *fiber.Ctx) error {
	if strings.ToLower(c.Query("active", "true")) != "true" {
		return c.JSON(fiber.Map{"success": true, "runs": []domain.ErosRun{}})
	}
	runs, err := s.repos.ErosRun.ListActive(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID))
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could_not_list_runs"})
	}
	return c.JSON(fiber.Map{"success": true, "runs": runs})
}

func (s *Server) handleCancelErosRun(c *fiber.Ctx) error {
	runID, err := parseErosRunID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_run_id"})
	}
	ok, err := s.repos.ErosRun.RequestCancel(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID), runID)
	if err != nil || !ok {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "run_not_cancellable"})
	}
	s.erosRunMu.Lock()
	cancel := s.erosRunCancels[runID]
	s.erosRunMu.Unlock()
	if cancel != nil {
		cancel()
	}
	return c.JSON(fiber.Map{"success": true, "status": "cancelling"})
}

func (s *Server) handleRetryErosRun(c *fiber.Ctx) error {
	runID, err := parseErosRunID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_run_id"})
	}
	ok, err := s.repos.ErosRun.ResetFailed(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID), runID)
	if err != nil || !ok {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "run_not_retryable"})
	}
	run, _ := s.repos.ErosRun.Get(c.Context(), c.Locals("account_id").(uuid.UUID), c.Locals("user_id").(uuid.UUID), runID)
	return c.Status(fiber.StatusAccepted).JSON(fiber.Map{"success": true, "run": run})
}

func (s *Server) handleAnswerErosRun(c *fiber.Ctx) error {
	runID, err := parseErosRunID(c)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_run_id"})
	}
	accountID := c.Locals("account_id").(uuid.UUID)
	userID := c.Locals("user_id").(uuid.UUID)
	parent, err := s.repos.ErosRun.Get(c.Context(), accountID, userID, runID)
	if err != nil {
		return c.Status(404).JSON(fiber.Map{"success": false, "error": "run_not_found"})
	}
	var req erosRunAnswerRequest
	if err = c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid_request"})
	}
	requestID, err := uuid.Parse(strings.TrimSpace(req.ClientRequestID))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "client_request_id_must_be_uuid"})
	}
	var stored struct {
		Clarification struct {
			Question string `json:"question"`
			Options  []struct {
				ID          string `json:"id"`
				Label       string `json:"label"`
				Description string `json:"description"`
			} `json:"options"`
			AllowCustom bool `json:"allow_custom"`
		} `json:"clarification"`
	}
	if json.Unmarshal(parent.Result, &stored) != nil || stored.Clarification.Question == "" {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "run_has_no_clarification"})
	}
	custom := strings.TrimSpace(req.CustomText)
	optionID := strings.TrimSpace(req.OptionID)
	answer := ""
	label := ""
	if custom != "" && stored.Clarification.AllowCustom {
		answer = custom
		label = "Otra opción: " + custom
	} else {
		for _, option := range stored.Clarification.Options {
			if option.ID == optionID {
				answer = option.Description
				label = option.Label
				break
			}
		}
	}
	if answer == "" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "clarification_answer_required"})
	}
	settings, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could_not_load_eros_settings"})
	}
	effort, reason := automaticErosReasoning(answer, "chat", "", settings)
	params, _ := json.Marshal(erosStoredRunParameters{ReasoningEffort: effort, ReasoningReason: reason, ClarificationAnswer: map[string]any{"parent_run_id": parent.ID, "question": stored.Clarification.Question, "option_id": optionID, "answer": answer}})
	child := &domain.ErosRun{ID: uuid.New(), AccountID: accountID, UserID: userID, ConversationID: parent.ConversationID, ParentRunID: &parent.ID, Kind: "chat", Parameters: params, Permissions: parent.Permissions, IdempotencyKey: requestID.String(), MaxAttempts: 2}
	message := fmt.Sprintf("Respuesta a la aclaración «%s»: %s", stored.Clarification.Question, answer)
	created, wasCreated, err := s.repos.ErosRun.AnswerClarification(c.Context(), parent, child, message)
	if errors.Is(err, repository.ErrErosRunNotStartable) {
		return c.Status(409).JSON(fiber.Map{"success": false, "error": "clarification_already_answered"})
	}
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "could_not_answer_clarification"})
	}
	status := fiber.StatusAccepted
	if !wasCreated {
		status = fiber.StatusOK
	}
	return c.Status(status).JSON(fiber.Map{"success": true, "run": created, "answer_label": label})
}

func (s *Server) StartErosRunWorker(ctx context.Context) {
	if recovered, err := s.repos.ErosRun.RecoverStale(ctx, 30*time.Second); err != nil {
		log.Printf("[Eros runs] stale recovery failed: %v", err)
	} else if recovered > 0 {
		log.Printf("[Eros runs] recovered %d stale execution(s)", recovered)
	}
	go s.erosRunRecoveryLoop(ctx)
	for i := 0; i < 2; i++ {
		go s.erosRunLoop(ctx, "chat")
		go s.erosRunLoop(ctx, "quick_task")
	}
}

func (s *Server) erosRunRecoveryLoop(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	sweeps := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweeps++
			if recovered, err := s.repos.ErosRun.RecoverStale(ctx, 30*time.Second); err != nil {
				log.Printf("[Eros runs] periodic stale recovery failed: %v", err)
			} else if recovered > 0 {
				log.Printf("[Eros runs] recovered %d stale execution(s)", recovered)
			}
			if sweeps%6 == 0 {
				_, _ = s.repos.DB().Exec(ctx, `DELETE FROM eros_context_grants WHERE expires_at<NOW() OR revoked_at<NOW()-INTERVAL '1 day'`)
			}
		}
	}
}

func (s *Server) erosRunLoop(ctx context.Context, kind string) {
	ticker := time.NewTicker(350 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run, err := s.repos.ErosRun.ClaimNextKind(ctx, kind)
			if err == pgx.ErrNoRows {
				continue
			}
			if err != nil {
				log.Printf("[Eros runs] claim failed: %v", err)
				continue
			}
			s.processErosRun(ctx, run)
		}
	}
}

func (s *Server) processErosRun(parent context.Context, run *domain.ErosRun) {
	runCtx, cancel := context.WithCancel(parent)
	s.erosRunMu.Lock()
	s.erosRunCancels[run.ID] = cancel
	s.erosRunMu.Unlock()
	defer func() {
		cancel()
		s.erosRunMu.Lock()
		delete(s.erosRunCancels, run.ID)
		s.erosRunMu.Unlock()
	}()
	if err := s.repos.ErosRun.MarkRunning(runCtx, run.ID); err != nil {
		if errors.Is(err, repository.ErrErosRunNotStartable) || errors.Is(runCtx.Err(), context.Canceled) {
			_ = s.repos.ErosRun.MarkCancelled(context.Background(), run.ID)
		} else {
			log.Printf("[Eros runs] could not mark run=%s running: %v", run.ID, err)
		}
		return
	}
	heartbeatDone := make(chan struct{})
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatDone:
				return
			case <-runCtx.Done():
				return
			case <-ticker.C:
				_ = s.repos.ErosRun.Heartbeat(context.Background(), run.ID, "processing")
			}
		}
	}()
	defer close(heartbeatDone)

	var err error
	if run.Kind == "quick_task" {
		err = s.processErosQuickTask(runCtx, run)
	} else {
		err = s.processErosChatRun(runCtx, run)
	}
	if err == nil {
		return
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, repository.ErrErosRunCancelled) {
		_ = s.repos.ErosRun.MarkCancelled(context.Background(), run.ID)
		return
	}
	code, safe, transient := classifyErosRunError(err)
	delay := 2 * time.Second
	if run.AttemptCount > 1 {
		delay = 8 * time.Second
	}
	if !transient {
		run.MaxAttempts = run.AttemptCount
	}
	if _, retryErr := s.repos.ErosRun.RetryOrFail(context.Background(), run, delay, code, safe); retryErr != nil {
		log.Printf("[Eros runs] could not persist failure run=%s: %v", run.ID, retryErr)
	}
}

func classifyErosRunError(err error) (code, safe string, transient bool) {
	text := strings.ToLower(err.Error())
	switch {
	case strings.Contains(text, "context deadline"), strings.Contains(text, "timed out"), strings.Contains(text, "timeout"):
		return "timeout", "La consulta tardó más de lo esperado. Eros la reintentará automáticamente.", true
	case strings.Contains(text, "reconnecting"), strings.Contains(text, "connection"), strings.Contains(text, "unavailable"), strings.Contains(text, "overload"):
		return "bridge_unavailable", "El servicio de Eros se desconectó temporalmente.", true
	case erosBridgeErrorIsCodexAuth(text):
		return "openai_auth", "Eros está temporalmente sin conexión. Un administrador debe revisar su conexión con OpenAI.", false
	case strings.Contains(text, "account"), strings.Contains(text, "permission"):
		return "account_denied", "Eros no tiene permiso para consultar esos datos.", false
	default:
		return "processing_error", "Eros no pudo completar esta consulta. Puedes reintentarlo.", false
	}
}

func decodeStoredRunParameters(run *domain.ErosRun) erosStoredRunParameters {
	var params erosStoredRunParameters
	_ = json.Unmarshal(run.Parameters, &params)
	if params.Task == nil {
		params.Task = map[string]any{}
	}
	return params
}

func (s *Server) processErosChatRun(ctx context.Context, run *domain.ErosRun) error {
	select {
	case s.erosRunSem <- struct{}{}:
		defer func() { <-s.erosRunSem }()
	case <-ctx.Done():
		return ctx.Err()
	}
	settings, err := s.effectiveErosSettings(ctx)
	if err != nil {
		return err
	}
	userMessage, err := s.repos.ErosRun.UserMessage(ctx, run.ID)
	if err != nil {
		return err
	}
	conv, err := s.repos.ErosConversation.GetWithMessages(ctx, run.AccountID, run.UserID, run.ConversationID)
	if err != nil {
		return err
	}
	params := decodeStoredRunParameters(run)
	history := make([]aiChatMessage, 0, len(conv.Messages))
	for _, message := range conv.Messages {
		if message.RunID != nil && *message.RunID == run.ID {
			continue
		}
		history = append(history, aiChatMessage{Role: message.Role, Content: message.Content})
	}
	if max := settings.MaxHistoryMessages; max > 0 && len(history) > max {
		history = history[len(history)-max:]
	}
	contextToken, err := eroscontext.Sign(s.cfg.JWTSecret, run.ID, run.AccountID, run.UserID, run.Permissions, false, 10*time.Minute)
	if err != nil {
		return err
	}
	resultMemory, _ := s.repos.ErosResultSet.ListRecent(ctx, run.AccountID, run.UserID, run.ConversationID, 5)
	bridgePayload := erosBridgeChatRequest{
		AccountID:      run.AccountID.String(),
		UserID:         run.UserID.String(),
		ConversationID: run.ConversationID.String(),
		// Each user message gets an isolated thread. Retries of this same run are
		// reconciled below through the persisted run turn locator.
		CodexThreadID:      "",
		CodexModel:         settings.CodexModel,
		ReasoningEffort:    params.ReasoningEffort,
		Message:            userMessage.Content,
		History:            history,
		CurrentPage:        params.CurrentPage,
		GlobalInstructions: settings.GlobalInstructions,
		MCPBaseURL:         settings.MCPBaseURL,
		AuthMode:           settings.AuthMode,
		ErosContext:        contextToken,
		ResultMemory:       resultMemory,
	}
	started := time.Now()
	turnCtx, cancelTurn := context.WithTimeout(ctx, 180*time.Second)
	defer cancelTurn()

	threadID := strings.TrimSpace(run.CodexThreadID)
	turnID := strings.TrimSpace(run.CodexTurnID)
	if (threadID == "") != (turnID == "") {
		return errors.New("incomplete persisted Codex turn locator")
	}
	replaceInterrupted := run.AttemptCount > 1 && run.ErrorCode == "timeout"
	replaced := false
	var bridgeResp *erosBridgeChatResponse
	for {
		if threadID == "" {
			_ = s.repos.ErosRun.Heartbeat(turnCtx, run.ID, "starting_codex")
			bridgeResp, err = s.startErosBridgeTurn(turnCtx, settings, bridgePayload)
			if err != nil {
				return err
			}
			threadID = strings.TrimSpace(bridgeResp.CodexThreadID)
			turnID = strings.TrimSpace(bridgeResp.CodexTurnID)
			if !bridgeResp.Success || threadID == "" || turnID == "" {
				return fmt.Errorf("bridge did not return a durable Codex turn locator: %s", strings.TrimSpace(bridgeResp.Error))
			}
			// This write deliberately happens before any wait/poll. Recovery can
			// now reconcile this exact turn through thread/read instead of starting
			// another model request.
			if err := s.repos.ErosRun.UpdateBridgeIDs(turnCtx, run.ID, threadID, turnID); err != nil {
				s.interruptErosTurnBestEffort(settings, threadID, turnID)
				return fmt.Errorf("persist Codex turn locator: %w", err)
			}
			run.CodexThreadID, run.CodexTurnID = threadID, turnID
		}

		_ = s.repos.ErosRun.Heartbeat(turnCtx, run.ID, "waiting_codex")
		bridgeResp, err = s.waitForErosBridgeTurn(turnCtx, settings, threadID, turnID)
		if err != nil {
			if turnCtx.Err() != nil {
				s.interruptErosTurnBestEffort(settings, threadID, turnID)
				if errors.Is(ctx.Err(), context.Canceled) {
					return context.Canceled
				}
				return fmt.Errorf("Codex turn timed out: %w", turnCtx.Err())
			}
			return err
		}
		if bridgeResp.Success && strings.EqualFold(bridgeResp.Status, "completed") {
			break
		}
		if strings.EqualFold(bridgeResp.Status, "interrupted") && replaceInterrupted && !replaced {
			if err := s.repos.ErosRun.ClearBridgeIDs(turnCtx, run.ID, threadID, turnID); err != nil {
				return err
			}
			threadID, turnID = "", ""
			run.CodexThreadID, run.CodexTurnID = "", ""
			replaced = true
			continue
		}
		return fmt.Errorf("Codex turn %s: %s", strings.TrimSpace(bridgeResp.Status), strings.TrimSpace(bridgeResp.Error))
	}
	duration := time.Since(started).Milliseconds()
	if !bridgeResp.Success || strings.TrimSpace(bridgeResp.Response) == "" {
		return fmt.Errorf("bridge failed: %s", strings.TrimSpace(bridgeResp.Error))
	}
	bridgeResp.Response = strings.ReplaceAll(bridgeResp.Response, contextToken, "[contexto protegido]")
	run.CodexThreadID = bridgeResp.CodexThreadID
	run.CodexTurnID = bridgeResp.CodexTurnID
	response := displayErosFileExportResponse(strings.TrimSpace(bridgeResp.Response), bridgeResp.FileExports)
	metadata, model, effort := buildErosExecutionSnapshot(bridgeResp.Metadata, settings.CodexModel, params.ReasoningEffort, duration, bridgeResp.ToolCalls)
	if params.ReasoningReason != "" {
		var values map[string]any
		_ = json.Unmarshal(metadata, &values)
		values["reasoning_reason"] = params.ReasoningReason
		metadata, _ = json.Marshal(values)
	}
	if len(bridgeResp.Clarification) > 0 && string(bridgeResp.Clarification) != "null" && json.Valid(bridgeResp.Clarification) {
		result, _ := json.Marshal(map[string]any{"clarification": json.RawMessage(bridgeResp.Clarification), "reasoning_effort": effort})
		_, err = s.repos.ErosRun.WaitForInput(ctx, run, response, model, effort, duration, metadata, marshalErosJSON(bridgeResp.ToolCalls, "[]"), result)
		return err
	}
	resultJSON := json.RawMessage(`{}`)
	if sets, listErr := s.repos.ErosResultSet.ListRecent(ctx, run.AccountID, run.UserID, run.ConversationID, 5); listErr == nil {
		for _, set := range sets {
			if set.RunID == run.ID {
				resultJSON, _ = json.Marshal(map[string]any{"result_set": set})
				var values map[string]any
				_ = json.Unmarshal(metadata, &values)
				values["result_set"] = map[string]any{"id": set.ID, "entity_type": set.EntityType, "returned_count": set.ReturnedCount, "has_more": set.HasMore}
				metadata, _ = json.Marshal(values)
				break
			}
		}
	}
	_, err = s.repos.ErosRun.Complete(ctx, run, response, model, effort, duration, metadata, marshalErosJSON(bridgeResp.ToolCalls, "[]"), resultJSON, func(messageID uuid.UUID) *domain.ErosFile {
		return buildErosFileDescriptor(run.AccountID, run.UserID, run.ConversationID, messageID, userMessage.Content, response, bridgeResp.FileExports)
	})
	return err
}

func automaticErosReasoning(message, kind, taskKey string, settings *domain.ErosSettings) (string, string) {
	text := strings.ToLower(strings.TrimSpace(message))
	requested := "medium"
	reason := "consulta_natural"
	if kind == "quick_task" || strings.Contains(text, "exporta") || strings.Contains(text, "descarga") || strings.Contains(text, "añade su") || strings.Contains(text, "agrega su") {
		requested, reason = "low", "tarea_directa_o_deterministica"
	}
	complexMarkers := []string{"compara", "analiza", "por qué", "porque", "tendencia", "relación", "prioriza", "varios criterios", "cruza"}
	complexity := 0
	for _, marker := range complexMarkers {
		if strings.Contains(text, marker) {
			complexity++
		}
	}
	conditionCount := strings.Count(text, " y ") + strings.Count(text, " además ") + strings.Count(text, " pero ")
	if complexity > 0 || conditionCount >= 2 {
		requested, reason = "high", "consulta_interpretativa_o_multicriterio"
	}
	if complexity >= 4 || (len(text) > 900 && conditionCount >= 4) {
		requested, reason = "xhigh", "sintesis_compleja_de_varios_pasos"
	}
	allowed := normalizeAllowedReasoningEfforts(settings.AllowedReasoningEfforts)
	return selectClosestReasoningEffort(requested, allowed), reason
}

func selectClosestReasoningEffort(requested string, allowed []string) string {
	rank := map[string]int{"low": 0, "medium": 1, "high": 2, "xhigh": 3}
	target := rank[requested]
	best := ""
	distance := 10
	for _, candidate := range allowed {
		value, ok := rank[candidate]
		if !ok {
			continue
		}
		d := value - target
		if d < 0 {
			d = -d
		}
		if d < distance {
			best, distance = candidate, d
		}
	}
	if best == "" {
		return "medium"
	}
	return best
}

func (s *Server) waitForErosBridgeTurn(ctx context.Context, settings *domain.ErosSettings, threadID, turnID string) (*erosBridgeChatResponse, error) {
	ticker := time.NewTicker(750 * time.Millisecond)
	defer ticker.Stop()
	for {
		response, err := s.readErosBridgeTurn(ctx, settings, threadID, turnID)
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(response.Status, "inProgress") && !strings.EqualFold(response.Status, "running") && !strings.EqualFold(response.Status, "starting") {
			return response, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) interruptErosTurnBestEffort(settings *domain.ErosSettings, threadID, turnID string) {
	if strings.TrimSpace(threadID) == "" || strings.TrimSpace(turnID) == "" {
		return
	}
	interruptCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := s.interruptErosBridgeTurn(interruptCtx, settings, threadID, turnID); err != nil {
		log.Printf("[Eros runs] could not interrupt Codex turn=%s: %v", turnID, err)
	}
}

func mergeQuickTaskParameters(definition service.ErosQuickTaskDefinition, supplied map[string]any) (map[string]any, error) {
	merged := make(map[string]any, len(definition.Defaults)+len(supplied))
	for key, value := range definition.Defaults {
		merged[key] = value
	}
	properties, _ := definition.InputSchema["properties"].(map[string]any)
	for key, value := range supplied {
		if _, allowed := properties[key]; !allowed {
			return nil, fmt.Errorf("parámetro no permitido: %s", key)
		}
		merged[key] = value
	}
	return merged, nil
}

func parseQuickTaskDate(value any, end bool) (*time.Time, error) {
	raw := strings.TrimSpace(fmt.Sprint(value))
	if raw == "" || raw == "<nil>" {
		return nil, nil
	}
	location, _ := time.LoadLocation("America/Lima")
	if parsed, err := time.ParseInLocation("2006-01-02", raw, location); err == nil {
		if end {
			parsed = parsed.AddDate(0, 0, 1)
		}
		return &parsed, nil
	}
	if parsed, err := time.Parse(time.RFC3339, raw); err == nil {
		return &parsed, nil
	}
	return nil, fmt.Errorf("fecha inválida: %s", raw)
}

func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	default:
		return fallback
	}
}

func quickResultMarkdown(title string, payload any) string {
	var result service.OperationalLeadQueryResult
	raw, _ := json.Marshal(payload)
	if json.Unmarshal(raw, &result) == nil && (result.Mode != "" || result.Items != nil) {
		if result.Mode == service.OperationalLeadQueryModeCount {
			return fmt.Sprintf("## %s\n\n**Total: %d**", title, result.Count)
		}
		var builder strings.Builder
		builder.WriteString("## " + title + "\n\n")
		builder.WriteString(fmt.Sprintf("Encontré **%d** resultado(s) en esta página", result.Returned))
		if result.HasMore {
			builder.WriteString("; hay más resultados disponibles")
		}
		builder.WriteString(".\n")
		if len(result.Items) > 0 {
			fields := result.Fields
			if len(fields) == 0 {
				for key := range result.Items[0] {
					fields = append(fields, key)
				}
			}
			if len(fields) > 7 {
				fields = fields[:7]
			}
			builder.WriteString("\n| " + strings.Join(fields, " | ") + " |\n")
			builder.WriteString("|" + strings.Repeat(" --- |", len(fields)) + "\n")
			limit := len(result.Items)
			if limit > 50 {
				limit = 50
			}
			for _, item := range result.Items[:limit] {
				cells := make([]string, 0, len(fields))
				for _, field := range fields {
					cell := strings.ReplaceAll(fmt.Sprint(item[field]), "|", "\\|")
					cells = append(cells, cell)
				}
				builder.WriteString("| " + strings.Join(cells, " | ") + " |\n")
			}
		}
		return builder.String()
	}
	pretty, _ := json.MarshalIndent(payload, "", "  ")
	return fmt.Sprintf("## %s\n\n```json\n%s\n```", title, pretty)
}

func (s *Server) processErosQuickTask(ctx context.Context, run *domain.ErosRun) error {
	definition, ok := service.ErosQuickTaskByID(run.TaskKey)
	if !ok || !definition.ReadOnly || !canUseQuickTask(run.Permissions, definition) {
		return errors.New("invalid quick task")
	}
	params := decodeStoredRunParameters(run)
	values, err := mergeQuickTaskParameters(definition, params.Task)
	if err != nil {
		return err
	}
	_ = s.repos.ErosRun.Heartbeat(ctx, run.ID, "querying")
	started := time.Now()
	var payload any
	var exportHint *erosFileExportHint

	switch definition.Action {
	case service.ErosQuickTaskActionOperationalLeadQuery:
		filters, err := service.OperationalLeadFiltersForQuickTask(run.TaskKey, run.AccountID, params.Task)
		if err != nil {
			return err
		}
		payload, err = service.NewOperationalLeadQueryService(s.repos).Query(ctx, filters)
		if err != nil {
			return err
		}
	case service.ErosQuickTaskActionLeadCycleSummary:
		payload, err = s.quickLeadCycleSummary(ctx, run.AccountID, values)
	case service.ErosQuickTaskActionFollowupPriority:
		payload, err = s.quickFollowupPriority(ctx, run.AccountID, values)
	case service.ErosQuickTaskActionLeadDataQuality:
		payload, err = s.quickLeadDataQualityScoped(ctx, run.AccountID, values)
	case service.ErosQuickTaskActionPerformanceOverview:
		payload, err = s.quickPerformanceOverviewScoped(ctx, run.AccountID, values)
	case service.ErosQuickTaskActionExportCurrentResult:
		payload, exportHint, err = s.quickExportResult(ctx, run, values)
	default:
		err = errors.New("quick task action is not implemented")
	}
	if err != nil {
		return err
	}
	resultJSON, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	content := quickResultMarkdown(definition.Title, payload)
	_, err = s.repos.ErosRun.Complete(ctx, run, content, "deterministic", "none", time.Since(started).Milliseconds(), json.RawMessage(`{"execution":"quick_task"}`), json.RawMessage(`[]`), resultJSON, func(messageID uuid.UUID) *domain.ErosFile {
		if exportHint == nil {
			return nil
		}
		return buildErosFileDescriptor(run.AccountID, run.UserID, run.ConversationID, messageID, "exportar resultado", content, []erosFileExportHint{*exportHint})
	})
	return err
}

func (s *Server) quickLeadCycleSummary(ctx context.Context, accountID uuid.UUID, values map[string]any) (map[string]any, error) {
	args := []any{accountID}
	where := "l.account_id=$1"
	if pipeline := strings.TrimSpace(fmt.Sprint(values["pipeline"])); pipeline != "" && pipeline != "<nil>" {
		if pipeline == "__no_pipeline__" {
			where += " AND l.pipeline_id IS NULL"
		} else if id, err := uuid.Parse(pipeline); err == nil {
			args = append(args, id)
			where += fmt.Sprintf(" AND l.pipeline_id=$%d", len(args))
		} else {
			args = append(args, pipeline)
			where += fmt.Sprintf(" AND l.pipeline_id IN (SELECT id FROM pipelines WHERE account_id=$1 AND lower(name)=lower($%d))", len(args))
		}
	}
	result := map[string]any{"as_of": time.Now().UTC()}
	var open, won, lost, archived, trash, blocked int
	err := s.repos.DB().QueryRow(ctx, `SELECT
		COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.status='open' AND NOT l.is_archived),
		COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.status='won' AND NOT l.is_archived),
		COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.status='lost' AND NOT l.is_archived),
		COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND l.is_archived),
		COUNT(*) FILTER (WHERE l.deleted_at IS NOT NULL),
		COUNT(*) FILTER (WHERE l.deleted_at IS NULL AND COALESCE(c.do_not_contact,false))
		FROM leads l LEFT JOIN contacts c ON c.id=l.contact_id AND c.account_id=l.account_id WHERE `+where, args...).Scan(&open, &won, &lost, &archived, &trash, &blocked)
	result["open"], result["won"], result["lost"] = open, won, lost
	result["archived"], result["trash"], result["blocked"] = archived, trash, blocked
	return result, err
}

func (s *Server) quickExportResult(ctx context.Context, run *domain.ErosRun, values map[string]any) (any, *erosFileExportHint, error) {
	sourceID, err := uuid.Parse(strings.TrimSpace(fmt.Sprint(values["source_run_id"])))
	if err != nil {
		return nil, nil, errors.New("source_run_id inválido")
	}
	source, err := s.repos.ErosRun.Get(ctx, run.AccountID, run.UserID, sourceID)
	if err != nil || source.Status != domain.ErosRunCompleted {
		return nil, nil, errors.New("la ejecución fuente no está disponible")
	}
	format := normalizeErosFileFormat(fmt.Sprint(values["format"]))
	if format != "csv" && format != "xlsx" && format != "pdf" {
		return nil, nil, errors.New("formato de exportación inválido")
	}
	content := quickResultMarkdown("Resultado de Eros", json.RawMessage(source.Result))
	hint := &erosFileExportHint{Format: format, Filename: "resultado_eros." + format, Title: "Resultado de Eros", Content: content}
	return map[string]any{"source_run_id": sourceID, "format": format, "ready": true}, hint, nil
}
