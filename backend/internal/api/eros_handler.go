package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/eroscontext"
	"github.com/naperu/clarin/internal/service"
)

type erosBridgeChatRequest struct {
	AccountID          string          `json:"account_id"`
	UserID             string          `json:"user_id"`
	ConversationID     string          `json:"conversation_id"`
	CodexThreadID      string          `json:"codex_thread_id,omitempty"`
	CodexModel         string          `json:"codex_model,omitempty"`
	ReasoningEffort    string          `json:"reasoning_effort,omitempty"`
	Message            string          `json:"message"`
	History            []aiChatMessage `json:"history,omitempty"`
	CurrentPage        string          `json:"current_page,omitempty"`
	GlobalInstructions string          `json:"global_instructions,omitempty"`
	MCPBaseURL         string          `json:"mcp_base_url,omitempty"`
	AuthMode           string          `json:"auth_mode,omitempty"`
	ErosContext        string          `json:"eros_context,omitempty"`
	ResultMemory       any             `json:"result_memory,omitempty"`
}

type erosBridgeChatResponse struct {
	Success       bool                 `json:"success"`
	Response      string               `json:"response"`
	CodexThreadID string               `json:"codex_thread_id"`
	CodexTurnID   string               `json:"codex_turn_id,omitempty"`
	Status        string               `json:"status"`
	Error         string               `json:"error"`
	ToolCalls     []erosToolTrace      `json:"tool_calls,omitempty"`
	Metadata      json.RawMessage      `json:"metadata,omitempty"`
	FileExports   []erosFileExportHint `json:"file_exports,omitempty"`
	Clarification json.RawMessage      `json:"clarification,omitempty"`
}

type erosBridgeTurnLocator struct {
	CodexThreadID string `json:"codex_thread_id"`
	CodexTurnID   string `json:"codex_turn_id"`
}

type erosToolTrace struct {
	Name      string `json:"name"`
	Status    string `json:"status,omitempty"`
	AccountID string `json:"account_id,omitempty"`
}

type erosFileExportHint struct {
	Filename string `json:"filename,omitempty"`
	Format   string `json:"format,omitempty"`
	Title    string `json:"title,omitempty"`
	Content  string `json:"content,omitempty"`
}

type erosBridgeHTTPError struct {
	StatusCode int
	Code       string
	Detail     string
}

func (e *erosBridgeHTTPError) Error() string {
	if e == nil {
		return ""
	}
	detail := strings.TrimSpace(e.Detail)
	if len(detail) > 1200 {
		detail = detail[:1200]
	}
	if e.Code != "" && detail != "" {
		return fmt.Sprintf("bridge returned %d (%s): %s", e.StatusCode, e.Code, detail)
	}
	if detail != "" {
		return fmt.Sprintf("bridge returned %d: %s", e.StatusCode, detail)
	}
	return fmt.Sprintf("bridge returned %d", e.StatusCode)
}

func erosBridgeErrorIsCodexAuth(value string) bool {
	text := strings.ToLower(value)
	return strings.Contains(text, "codex_auth_revoked") ||
		strings.Contains(text, "codex_auth_required") ||
		strings.Contains(text, "token_revoked") ||
		strings.Contains(text, "token_invalidated") ||
		strings.Contains(text, "token has been invalidated") ||
		strings.Contains(text, "invalidated oauth token") ||
		strings.Contains(text, "codex chatgpt auth") ||
		strings.Contains(text, "openai connection")
}

func erosBridgeCodexAuthDetail(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var bridgeErr *erosBridgeHTTPError
	if errors.As(err, &bridgeErr) {
		if erosBridgeErrorIsCodexAuth(bridgeErr.Code) || erosBridgeErrorIsCodexAuth(bridgeErr.Detail) {
			return "Eros está temporalmente sin conexión. Inténtalo nuevamente más tarde o contacta a un administrador si el problema continúa.", true
		}
	}
	if erosBridgeErrorIsCodexAuth(err.Error()) {
		return "Eros está temporalmente sin conexión. Inténtalo nuevamente más tarde o contacta a un administrador si el problema continúa.", true
	}
	return "", false
}

func (s *Server) effectiveErosSettings(ctx context.Context) (*domain.ErosSettings, error) {
	settings, err := s.repos.ErosSettings.Get(ctx)
	if err != nil {
		if err != pgx.ErrNoRows {
			return nil, err
		}
		settings = &domain.ErosSettings{
			ID:                         1,
			Enabled:                    true,
			Provider:                   "codex_bridge",
			AuthMode:                   "chatgpt_subscription",
			CodexModel:                 "gpt-5.4-mini",
			DefaultReasoningEffort:     "medium",
			AllowedReasoningEfforts:    []string{"low", "medium", "high", "xhigh"},
			AllowUserReasoningOverride: true,
			MaxHistoryMessages:         20,
		}
	}
	if settings.Provider == "" {
		settings.Provider = "codex_bridge"
	}
	if settings.AuthMode == "" {
		settings.AuthMode = "chatgpt_subscription"
	}
	settings.CodexModel = normalizeCodexModel(settings.CodexModel, s.cfg.ErosCodexModel)
	settings.DefaultReasoningEffort = normalizeReasoningEffortValue(settings.DefaultReasoningEffort, s.cfg.ErosCodexReasoning)
	settings.AllowedReasoningEfforts = normalizeAllowedReasoningEfforts(settings.AllowedReasoningEfforts)
	settings.DefaultReasoningEffort = selectAllowedReasoningEffort(settings.DefaultReasoningEffort, settings.AllowedReasoningEfforts)
	if settings.MaxHistoryMessages <= 0 {
		settings.MaxHistoryMessages = 20
	}
	if strings.TrimSpace(settings.BridgeURL) == "" {
		settings.BridgeURL = s.cfg.ErosCodexBridgeURL
	}
	settings.BridgeURL = strings.TrimRight(strings.TrimSpace(settings.BridgeURL), "/")
	if strings.TrimSpace(settings.MCPBaseURL) == "" {
		settings.MCPBaseURL = s.cfg.ErosMCPBaseURL
	}
	settings.MCPBaseURL = strings.TrimRight(strings.TrimSpace(settings.MCPBaseURL), "/")
	settings.Enabled = settings.Enabled && s.cfg.ErosEnabled
	return settings, nil
}

func (s *Server) erosCredentialConfigured() bool {
	return strings.TrimSpace(s.cfg.ErosCodexBridgeToken) != ""
}

func (s *Server) erosStatusPayload(ctx context.Context, userID uuid.UUID) (fiber.Map, error) {
	settings, err := s.effectiveErosSettings(ctx)
	if err != nil {
		return nil, err
	}
	userEnabled := false
	if userID != uuid.Nil {
		userEnabled, err = s.repos.User.IsErosEnabled(ctx, userID)
		if err != nil && err != pgx.ErrNoRows {
			return nil, err
		}
	}
	bridgeConfigured := settings.BridgeURL != ""
	return fiber.Map{
		"enabled":                       settings.Enabled,
		"user_enabled":                  userEnabled,
		"available":                     settings.Enabled && userEnabled && bridgeConfigured,
		"provider":                      settings.Provider,
		"auth_mode":                     settings.AuthMode,
		"codex_model":                   settings.CodexModel,
		"default_reasoning_effort":      settings.DefaultReasoningEffort,
		"allowed_reasoning_efforts":     settings.AllowedReasoningEfforts,
		"allow_user_reasoning_override": false,
		"bridge_configured":             bridgeConfigured,
		"credential_configured":         s.erosCredentialConfigured(),
		"mcp_configured":                settings.MCPBaseURL != "",
		"mcp_token_configured":          strings.TrimSpace(s.cfg.ErosMCPAccessToken) != "",
		"max_history_messages":          settings.MaxHistoryMessages,
	}, nil
}

func (s *Server) handleErosStatus(c *fiber.Ctx) error {
	userID, _ := c.Locals("user_id").(uuid.UUID)
	status, err := s.erosStatusPayload(c.Context(), userID)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros status"})
	}
	status["success"] = true
	return c.JSON(status)
}

func (s *Server) requireErosUserAccess(ctx context.Context, userID uuid.UUID, settings *domain.ErosSettings) (bool, string, error) {
	if !settings.Enabled {
		return false, "eros_disabled", nil
	}
	if strings.TrimSpace(settings.BridgeURL) == "" {
		return false, "bridge_not_configured", nil
	}
	enabled, err := s.repos.User.IsErosEnabled(ctx, userID)
	if err != nil {
		return false, "", err
	}
	if !enabled {
		return false, "eros_user_disabled", nil
	}
	return true, "", nil
}

func (s *Server) handleErosChat(c *fiber.Ctx) error {
	accountID, ok := c.Locals("account_id").(uuid.UUID)
	if !ok || accountID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}
	userID, ok := c.Locals("user_id").(uuid.UUID)
	if !ok || userID == uuid.Nil {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{"success": false, "error": "unauthorized"})
	}

	var req aiChatRequest
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid request body"})
	}
	req.Message = strings.TrimSpace(req.Message)
	if req.Message == "" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "message is required"})
	}

	settings, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros settings"})
	}
	allowed, code, err := s.requireErosUserAccess(c.Context(), userID, settings)
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not verify Eros access"})
	}
	if !allowed {
		return c.Status(fiber.StatusForbidden).JSON(fiber.Map{"success": false, "error": code})
	}

	conv, err := s.resolveErosConversation(c.Context(), accountID, userID, req.ConversationID, req.Message)
	if err != nil {
		status := fiber.StatusInternalServerError
		if err == pgx.ErrNoRows {
			status = fiber.StatusNotFound
		}
		return c.Status(status).JSON(fiber.Map{"success": false, "error": "conversation not found"})
	}

	if _, err := s.repos.ErosConversation.AddMessage(c.Context(), conv.ID, "user", req.Message); err != nil {
		log.Printf("[Eros] could not save user message conversation=%s: %v", conv.ID, err)
	}

	history := req.History
	if max := settings.MaxHistoryMessages; max > 0 && len(history) > max {
		history = history[len(history)-max:]
	}

	reasoningEffort, _ := automaticErosReasoning(req.Message, "chat", "", settings)
	permissions := []string{domain.PermAll}
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok {
		permissions = claimsPermissions(claims)
	}
	legacyGrantID := uuid.New()
	legacyGrantExpiresAt := time.Now().UTC().Add(10 * time.Minute)
	if _, contextErr := s.repos.DB().Exec(c.Context(), `INSERT INTO eros_context_grants (id,account_id,user_id,expires_at) VALUES ($1,$2,$3,$4)`, legacyGrantID, accountID, userID, legacyGrantExpiresAt); contextErr != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could_not_bind_eros_context"})
	}
	defer func() {
		_, _ = s.repos.DB().Exec(context.Background(), `UPDATE eros_context_grants SET revoked_at=COALESCE(revoked_at,NOW()) WHERE id=$1`, legacyGrantID)
	}()
	erosContextToken, contextErr := eroscontext.Sign(s.cfg.JWTSecret, legacyGrantID, accountID, userID, permissions, true, time.Until(legacyGrantExpiresAt))
	if contextErr != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could_not_bind_eros_context"})
	}
	bridgeStart := time.Now()
	bridgeResp, err := s.callErosBridge(c.Context(), settings, erosBridgeChatRequest{
		AccountID:          accountID.String(),
		UserID:             userID.String(),
		ConversationID:     conv.ID.String(),
		CodexThreadID:      conv.CodexThreadID,
		CodexModel:         settings.CodexModel,
		ReasoningEffort:    reasoningEffort,
		Message:            req.Message,
		History:            history,
		CurrentPage:        req.CurrentPage,
		GlobalInstructions: settings.GlobalInstructions,
		MCPBaseURL:         settings.MCPBaseURL,
		AuthMode:           settings.AuthMode,
		ErosContext:        erosContextToken,
	})
	bridgeDurationMS := time.Since(bridgeStart).Milliseconds()
	if err != nil {
		_ = s.repos.ErosConversation.UpdateBridgeState(c.Context(), accountID, userID, conv.ID, "", "bridge_error", err.Error())
		log.Printf("[Eros] bridge error account=%s user=%s conversation=%s: %v", accountID, userID, conv.ID, err)
		resp := fiber.Map{
			"success": false,
			"error":   "eros_bridge_unavailable",
		}
		if detail, ok := erosBridgeCodexAuthDetail(err); ok {
			resp["error"] = "eros_openai_connection_required"
			resp["detail"] = detail
		}
		return c.Status(fiber.StatusBadGateway).JSON(resp)
	}
	if !bridgeResp.Success || strings.TrimSpace(bridgeResp.Response) == "" {
		errMsg := strings.TrimSpace(bridgeResp.Error)
		if errMsg == "" {
			errMsg = "empty bridge response"
		}
		_ = s.repos.ErosConversation.UpdateBridgeState(c.Context(), accountID, userID, conv.ID, bridgeResp.CodexThreadID, "bridge_error", errMsg)
		resp := fiber.Map{
			"success": false,
			"error":   "eros_bridge_error",
			"detail":  errMsg,
		}
		if erosBridgeErrorIsCodexAuth(errMsg) {
			resp["error"] = "eros_openai_connection_required"
			resp["detail"] = "Eros está temporalmente sin conexión. Inténtalo nuevamente más tarde o contacta a un administrador si el problema continúa."
		}
		return c.Status(fiber.StatusBadGateway).JSON(resp)
	}
	bridgeResp.Response = strings.ReplaceAll(bridgeResp.Response, erosContextToken, "[contexto protegido]")

	response := displayErosFileExportResponse(strings.TrimSpace(bridgeResp.Response), bridgeResp.FileExports)
	metadata, codexModel, savedReasoningEffort := buildErosExecutionSnapshot(
		bridgeResp.Metadata,
		settings.CodexModel,
		reasoningEffort,
		bridgeDurationMS,
		bridgeResp.ToolCalls,
	)
	toolCallsJSON := marshalErosJSON(bridgeResp.ToolCalls, "[]")
	assistantMsg, saveErr := s.repos.ErosConversation.AddMessageWithMetadata(
		c.Context(),
		conv.ID,
		"assistant",
		response,
		codexModel,
		savedReasoningEffort,
		bridgeDurationMS,
		metadata,
		toolCallsJSON,
	)
	if saveErr != nil {
		log.Printf("[Eros] could not save assistant message conversation=%s: %v", conv.ID, saveErr)
	}
	if assistantMsg != nil {
		if file := buildErosFileDescriptor(accountID, userID, conv.ID, assistantMsg.ID, req.Message, response, bridgeResp.FileExports); file != nil {
			if savedFile, err := s.repos.ErosFile.Create(c.Context(), file); err != nil {
				log.Printf("[Eros] could not create file descriptor conversation=%s message=%s: %v", conv.ID, assistantMsg.ID, err)
			} else {
				assistantMsg.Attachments = append(assistantMsg.Attachments, *savedFile)
			}
		}
	}
	state := bridgeResp.Status
	if state == "" {
		state = "completed"
	}
	_ = s.repos.ErosConversation.UpdateBridgeState(c.Context(), accountID, userID, conv.ID, bridgeResp.CodexThreadID, state, "")

	return c.JSON(fiber.Map{
		"success":          true,
		"response":         response,
		"conversation_id":  conv.ID.String(),
		"codex_thread_id":  bridgeResp.CodexThreadID,
		"status":           state,
		"tool_calls":       bridgeResp.ToolCalls,
		"metadata":         metadata,
		"codex_model":      codexModel,
		"reasoning_effort": savedReasoningEffort,
		"duration_ms":      bridgeDurationMS,
		"message":          assistantMsg,
	})
}

func normalizeCodexModel(value, fallback string) string {
	model := strings.TrimSpace(value)
	if model == "" {
		model = strings.TrimSpace(fallback)
	}
	if model == "" {
		return "gpt-5.4-mini"
	}
	if len(model) > 100 {
		return "gpt-5.4-mini"
	}
	for _, r := range model {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
			continue
		}
		switch r {
		case '.', '-', '_', '/', ':':
			continue
		default:
			return "gpt-5.4-mini"
		}
	}
	return model
}

func normalizeReasoningEffortValue(value, fallback string) string {
	effort := strings.ToLower(strings.TrimSpace(value))
	if effort == "" {
		effort = strings.ToLower(strings.TrimSpace(fallback))
	}
	if isValidReasoningEffort(effort) {
		return effort
	}
	return "medium"
}

func isValidReasoningEffort(effort string) bool {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "low", "medium", "high", "xhigh":
		return true
	default:
		return false
	}
}

func normalizeAllowedReasoningEfforts(values []string) []string {
	if len(values) == 0 {
		return []string{"low", "medium", "high", "xhigh"}
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		effort := strings.ToLower(strings.TrimSpace(value))
		if !isValidReasoningEffort(effort) {
			continue
		}
		if seen[effort] {
			continue
		}
		seen[effort] = true
		out = append(out, effort)
	}
	if len(out) == 0 {
		return []string{"low", "medium", "high", "xhigh"}
	}
	return out
}

func selectAllowedReasoningEffort(value string, allowed []string) string {
	if len(allowed) == 0 {
		allowed = []string{"low", "medium", "high", "xhigh"}
	}
	effort := normalizeReasoningEffortValue(value, "medium")
	for _, candidate := range allowed {
		if candidate == effort {
			return effort
		}
	}
	return allowed[0]
}

func effectiveErosReasoningEffort(requested string, settings *domain.ErosSettings) string {
	if !settings.AllowUserReasoningOverride {
		return settings.DefaultReasoningEffort
	}
	effort := normalizeReasoningEffortValue(requested, settings.DefaultReasoningEffort)
	return selectAllowedReasoningEffort(effort, settings.AllowedReasoningEfforts)
}

func buildErosExecutionSnapshot(raw json.RawMessage, fallbackModel, fallbackEffort string, durationMS int64, toolCalls []erosToolTrace) (json.RawMessage, string, string) {
	incoming := map[string]any{}
	if len(raw) > 0 && json.Valid(raw) {
		_ = json.Unmarshal(raw, &incoming)
	}
	metadata := map[string]any{}
	for _, key := range []string{
		"mcp_server",
		"model",
		"reasoning_effort",
		"requested_reasoning_effort",
		"reasoning_fallback",
		"duration_ms",
		"turn_duration_ms",
		"codex_turn_duration_ms",
		"attempts",
		"recovered",
		"login_cached",
		"codex_login_cached",
		"login_duration_ms",
	} {
		copySafeErosMetadataValue(metadata, incoming, key)
	}

	model := strings.TrimSpace(erosMetadataString(incoming, "model"))
	if model == "" {
		model = strings.TrimSpace(fallbackModel)
	}
	effort := normalizeReasoningEffortValue(erosMetadataString(incoming, "reasoning_effort"), fallbackEffort)
	metadata["backend_bridge_duration_ms"] = durationMS
	metadata["tool_call_count"] = len(toolCalls)
	if model != "" {
		metadata["model"] = model
	}
	if effort != "" {
		metadata["reasoning_effort"] = effort
	}

	out, err := json.Marshal(metadata)
	if err != nil {
		return json.RawMessage(`{}`), model, effort
	}
	return json.RawMessage(out), model, effort
}

func erosMetadataString(metadata map[string]any, key string) string {
	value, ok := metadata[key]
	if !ok {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func copySafeErosMetadataValue(dst, src map[string]any, key string) {
	value, ok := src[key]
	if !ok {
		return
	}
	switch typed := value.(type) {
	case string:
		if strings.TrimSpace(typed) != "" {
			dst[key] = typed
		}
	case bool:
		dst[key] = typed
	case float64:
		dst[key] = typed
	}
}

func marshalErosJSON(value any, fallback string) json.RawMessage {
	raw, err := json.Marshal(value)
	if err != nil || len(raw) == 0 || string(raw) == "null" || !json.Valid(raw) {
		return json.RawMessage(fallback)
	}
	return json.RawMessage(raw)
}

func (s *Server) resolveErosConversation(ctx context.Context, accountID, userID uuid.UUID, rawConversationID, message string) (*domain.ErosConversation, error) {
	if strings.TrimSpace(rawConversationID) != "" {
		convID, err := uuid.Parse(strings.TrimSpace(rawConversationID))
		if err != nil {
			return nil, pgx.ErrNoRows
		}
		return s.repos.ErosConversation.GetWithMessages(ctx, accountID, userID, convID)
	}
	title := strings.TrimSpace(message)
	if len(title) > 60 {
		title = title[:60]
	}
	return s.repos.ErosConversation.Create(ctx, accountID, userID, title)
}

func (s *Server) callErosBridge(ctx context.Context, settings *domain.ErosSettings, payload erosBridgeChatRequest) (*erosBridgeChatResponse, error) {
	var bridgeResp erosBridgeChatResponse
	if err := s.callErosBridgeEndpoint(ctx, settings, http.MethodPost, "/chat", payload, &bridgeResp, s.cfg.ErosBridgeTimeout); err != nil {
		return nil, err
	}
	return &bridgeResp, nil
}

func (s *Server) startErosBridgeTurn(ctx context.Context, settings *domain.ErosSettings, payload erosBridgeChatRequest) (*erosBridgeChatResponse, error) {
	var bridgeResp erosBridgeChatResponse
	if err := s.callErosBridgeEndpoint(ctx, settings, http.MethodPost, "/turn/start", payload, &bridgeResp, 45*time.Second); err != nil {
		return nil, err
	}
	return &bridgeResp, nil
}

func (s *Server) readErosBridgeTurn(ctx context.Context, settings *domain.ErosSettings, threadID, turnID string) (*erosBridgeChatResponse, error) {
	var bridgeResp erosBridgeChatResponse
	payload := erosBridgeTurnLocator{CodexThreadID: threadID, CodexTurnID: turnID}
	if err := s.callErosBridgeEndpoint(ctx, settings, http.MethodPost, "/turn/read", payload, &bridgeResp, 40*time.Second); err != nil {
		return nil, err
	}
	return &bridgeResp, nil
}

func (s *Server) interruptErosBridgeTurn(ctx context.Context, settings *domain.ErosSettings, threadID, turnID string) error {
	var bridgeResp erosBridgeChatResponse
	payload := erosBridgeTurnLocator{CodexThreadID: threadID, CodexTurnID: turnID}
	return s.callErosBridgeEndpoint(ctx, settings, http.MethodPost, "/turn/interrupt", payload, &bridgeResp, 15*time.Second)
}

func (s *Server) callErosBridgeEndpoint(ctx context.Context, settings *domain.ErosSettings, method, endpoint string, payload, output any, timeout time.Duration) error {
	if settings.BridgeURL == "" {
		return fmt.Errorf("bridge url is empty")
	}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal bridge payload: %w", err)
	}
	if timeout <= 0 {
		timeout = 45 * time.Second
	}
	httpCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(httpCtx, method, strings.TrimRight(settings.BridgeURL, "/")+endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return fmt.Errorf("create bridge request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Clarin-Eros-Bridge", "codex")
	if token := strings.TrimSpace(s.cfg.ErosCodexBridgeToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return fmt.Errorf("call bridge: %w", err)
	}
	defer resp.Body.Close()
	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bridgeErr := &erosBridgeHTTPError{StatusCode: resp.StatusCode, Detail: strings.TrimSpace(string(respBytes))}
		var errBody struct {
			Error  string `json:"error"`
			Detail string `json:"detail"`
		}
		if json.Unmarshal(respBytes, &errBody) == nil {
			bridgeErr.Code = strings.TrimSpace(errBody.Error)
			if strings.TrimSpace(errBody.Detail) != "" {
				bridgeErr.Detail = strings.TrimSpace(errBody.Detail)
			}
		}
		return bridgeErr
	}
	if err := json.Unmarshal(respBytes, output); err != nil {
		return fmt.Errorf("parse bridge response: %w", err)
	}
	return nil
}

func (s *Server) handleErosLegacyConfig(c *fiber.Ctx) error {
	status, err := s.erosStatusPayload(c.Context(), c.Locals("user_id").(uuid.UUID))
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros status"})
	}
	return c.JSON(fiber.Map{
		"success":       true,
		"has_key":       status["available"],
		"configured":    status["available"],
		"managed":       true,
		"provider":      status["provider"],
		"bridge_status": status,
	})
}

func (s *Server) handleErosLegacyConfigWrite(c *fiber.Ctx) error {
	return c.Status(fiber.StatusGone).JSON(fiber.Map{
		"success": false,
		"error":   "Eros ahora se configura desde Admin y variables de entorno del proyecto.",
	})
}
