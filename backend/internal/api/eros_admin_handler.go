package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func (s *Server) handleAdminGetErosSettings(c *fiber.Ctx) error {
	settings, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros settings"})
	}
	return c.JSON(fiber.Map{
		"success":  true,
		"settings": settings,
		"environment": fiber.Map{
			"project_enabled":             s.cfg.ErosEnabled,
			"bridge_url_from_env":         s.cfg.ErosCodexBridgeURL != "",
			"mcp_base_url_from_env":       s.cfg.ErosMCPBaseURL != "",
			"credential_configured":       s.erosCredentialConfigured(),
			"auth_file_configured":        s.cfg.ErosCodexAuthFile != "",
			"bridge_token_configured":     s.cfg.ErosCodexBridgeToken != "",
			"mcp_access_token_configured": strings.TrimSpace(s.cfg.ErosMCPAccessToken) != "",
			"bridge_timeout_seconds":      int(s.cfg.ErosBridgeTimeout.Seconds()),
			"secrets_visible_in_admin":    false,
			"subscription_auth_mode_hint": s.cfg.ErosCodexAuthMode,
			"codex_model_from_env":        s.cfg.ErosCodexModel != "",
			"reasoning_effort_from_env":   s.cfg.ErosCodexReasoning != "",
		},
	})
}

func (s *Server) handleAdminUpdateErosSettings(c *fiber.Ctx) error {
	current, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros settings"})
	}
	var req struct {
		Enabled                    *bool    `json:"enabled"`
		Provider                   string   `json:"provider"`
		BridgeURL                  string   `json:"bridge_url"`
		AuthMode                   string   `json:"auth_mode"`
		MCPBaseURL                 string   `json:"mcp_base_url"`
		CodexModel                 string   `json:"codex_model"`
		DefaultReasoningEffort     string   `json:"default_reasoning_effort"`
		AllowedReasoningEfforts    []string `json:"allowed_reasoning_efforts"`
		AllowUserReasoningOverride *bool    `json:"allow_user_reasoning_override"`
		GlobalInstructions         string   `json:"global_instructions"`
		MaxHistoryMessages         int      `json:"max_history_messages"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid body"})
	}
	if req.Enabled != nil {
		current.Enabled = *req.Enabled
	}
	if strings.TrimSpace(req.Provider) != "" {
		current.Provider = strings.TrimSpace(req.Provider)
	}
	if current.Provider != "codex_bridge" {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "provider must be codex_bridge"})
	}
	if strings.TrimSpace(req.AuthMode) != "" {
		current.AuthMode = strings.TrimSpace(req.AuthMode)
	}
	if current.AuthMode == "" {
		current.AuthMode = "chatgpt_subscription"
	}
	current.BridgeURL = strings.TrimRight(strings.TrimSpace(req.BridgeURL), "/")
	current.MCPBaseURL = strings.TrimRight(strings.TrimSpace(req.MCPBaseURL), "/")
	current.CodexModel = normalizeCodexModel(req.CodexModel, s.cfg.ErosCodexModel)
	current.AllowedReasoningEfforts = normalizeAllowedReasoningEfforts(req.AllowedReasoningEfforts)
	current.DefaultReasoningEffort = selectAllowedReasoningEffort(
		normalizeReasoningEffortValue(req.DefaultReasoningEffort, s.cfg.ErosCodexReasoning),
		current.AllowedReasoningEfforts,
	)
	if req.AllowUserReasoningOverride != nil {
		current.AllowUserReasoningOverride = *req.AllowUserReasoningOverride
	}
	current.GlobalInstructions = strings.TrimSpace(req.GlobalInstructions)
	if req.MaxHistoryMessages > 0 {
		if req.MaxHistoryMessages > 50 {
			req.MaxHistoryMessages = 50
		}
		current.MaxHistoryMessages = req.MaxHistoryMessages
	}
	adminID, _ := c.Locals("user_id").(uuid.UUID)
	if adminID != uuid.Nil {
		current.UpdatedByUserID = &adminID
	}
	if err := s.repos.ErosSettings.Upsert(c.Context(), current); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not save Eros settings"})
	}
	return c.JSON(fiber.Map{"success": true, "settings": current})
}

func (s *Server) handleAdminUpdateErosUser(c *fiber.Ctx) error {
	userID, err := uuid.Parse(c.Params("userId"))
	if err != nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "invalid user id"})
	}
	var req struct {
		ErosEnabled *bool `json:"eros_enabled"`
	}
	if err := c.BodyParser(&req); err != nil || req.ErosEnabled == nil {
		return c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"success": false, "error": "eros_enabled is required"})
	}
	if err := s.repos.User.SetErosEnabled(c.Context(), userID, *req.ErosEnabled); err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not update Eros access"})
	}
	return c.JSON(fiber.Map{"success": true, "user_id": userID, "eros_enabled": *req.ErosEnabled})
}

func (s *Server) handleAdminErosHealthcheck(c *fiber.Ctx) error {
	settings, err := s.effectiveErosSettings(c.Context())
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).JSON(fiber.Map{"success": false, "error": "could not load Eros settings"})
	}
	timeout := 8 * time.Second
	ctx, cancel := context.WithTimeout(c.Context(), timeout)
	defer cancel()

	bridge := s.checkErosBridge(ctx, settings)
	mcp := s.checkErosMCP(ctx, settings)

	return c.JSON(fiber.Map{
		"success": true,
		"health": fiber.Map{
			"bridge": bridge,
			"mcp":    mcp,
			"env": fiber.Map{
				"project_enabled":               s.cfg.ErosEnabled,
				"credential_configured":         s.erosCredentialConfigured(),
				"bridge_token_configured":       s.cfg.ErosCodexBridgeToken != "",
				"mcp_token_configured":          strings.TrimSpace(s.cfg.ErosMCPAccessToken) != "",
				"codex_model":                   settings.CodexModel,
				"default_reasoning_effort":      settings.DefaultReasoningEffort,
				"allow_user_reasoning_override": settings.AllowUserReasoningOverride,
			},
			"checked_at": time.Now().UTC(),
		},
	})
}

func (s *Server) checkErosBridge(ctx context.Context, settings *domain.ErosSettings) fiber.Map {
	if settings.BridgeURL == "" {
		return fiber.Map{"configured": false, "ok": false, "error": "bridge_not_configured"}
	}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, settings.BridgeURL+"/health", nil)
	if err != nil {
		return fiber.Map{"configured": true, "ok": false, "error": "invalid_bridge_url"}
	}
	if token := strings.TrimSpace(s.cfg.ErosCodexBridgeToken); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return fiber.Map{"configured": true, "ok": false, "error": err.Error(), "duration_ms": time.Since(start).Milliseconds()}
	}
	defer resp.Body.Close()
	result := fiber.Map{
		"configured":  true,
		"ok":          resp.StatusCode >= 200 && resp.StatusCode < 300,
		"status_code": resp.StatusCode,
		"duration_ms": time.Since(start).Milliseconds(),
	}
	respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	var bridgeBody map[string]any
	if len(respBytes) > 0 && json.Unmarshal(respBytes, &bridgeBody) == nil {
		if success, ok := bridgeBody["success"].(bool); ok {
			result["success"] = success
		}
		if initialized, ok := bridgeBody["codex_initialized"].(bool); ok {
			result["codex_initialized"] = initialized
		}
		if authenticated, ok := bridgeBody["codex_authenticated"].(bool); ok {
			result["codex_authenticated"] = authenticated
		}
		if tokenValid, ok := bridgeBody["codex_auth_token_valid"].(bool); ok {
			result["codex_auth_token_valid"] = tokenValid
		}
		if expiresAt, ok := bridgeBody["codex_auth_token_expires_at"].(string); ok {
			result["codex_auth_token_expires_at"] = expiresAt
		}
		if requiresAuth, ok := bridgeBody["codex_requires_openai_auth"].(bool); ok {
			result["codex_requires_openai_auth"] = requiresAuth
			if _, exists := result["codex_authenticated"]; !exists {
				result["codex_authenticated"] = !requiresAuth
			}
		}
		if authMethod, ok := bridgeBody["codex_auth_method"].(string); ok {
			result["codex_auth_method"] = authMethod
		}
		if toolsCount, ok := bridgeBody["mcp_tools_count"].(float64); ok {
			result["mcp_tools_count"] = int(toolsCount)
		}
		if authStatus, ok := bridgeBody["mcp_auth_status"].(string); ok {
			result["mcp_auth_status"] = authStatus
		}
		if model, ok := bridgeBody["codex_model"].(string); ok {
			result["codex_model"] = model
		}
		if effort, ok := bridgeBody["reasoning_effort"].(string); ok {
			result["reasoning_effort"] = effort
		}
		if bridgeErr, ok := bridgeBody["error"].(string); ok && bridgeErr != "" {
			result["bridge_error"] = bridgeErr
		}
	}
	return result
}

func (s *Server) checkErosMCP(ctx context.Context, settings *domain.ErosSettings) fiber.Map {
	if settings.MCPBaseURL == "" {
		return fiber.Map{"configured": false, "protected": false, "error": "mcp_base_url_not_configured"}
	}
	start := time.Now()
	body := `{"jsonrpc":"2.0","id":"health","method":"tools/list"}`
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.MCPBaseURL, strings.NewReader(body))
	if err != nil {
		return fiber.Map{"configured": true, "protected": false, "error": "invalid_mcp_url"}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return fiber.Map{"configured": true, "protected": false, "error": err.Error(), "duration_ms": time.Since(start).Milliseconds()}
	}
	defer resp.Body.Close()
	result := fiber.Map{
		"configured":  true,
		"protected":   resp.StatusCode == http.StatusUnauthorized,
		"status_code": resp.StatusCode,
		"duration_ms": time.Since(start).Milliseconds(),
	}
	token := strings.TrimSpace(s.cfg.ErosMCPAccessToken)
	result["token_configured"] = token != ""
	if token == "" {
		result["authorized"] = false
		result["authorized_error"] = "mcp_access_token_not_configured"
		return result
	}
	authReq, err := http.NewRequestWithContext(ctx, http.MethodPost, settings.MCPBaseURL, strings.NewReader(body))
	if err != nil {
		result["authorized"] = false
		result["authorized_error"] = "invalid_mcp_url"
		return result
	}
	authReq.Header.Set("Content-Type", "application/json")
	authReq.Header.Set("Accept", "application/json, text/event-stream")
	authReq.Header.Set("Authorization", "Bearer "+token)
	authResp, err := (&http.Client{}).Do(authReq)
	if err != nil {
		result["authorized"] = false
		result["authorized_error"] = err.Error()
		return result
	}
	defer authResp.Body.Close()
	authBody, _ := io.ReadAll(io.LimitReader(authResp.Body, 64*1024))
	authBodyText := strings.TrimSpace(string(authBody))
	authorized := authResp.StatusCode >= 200 && authResp.StatusCode < 300
	if authResp.StatusCode == http.StatusBadRequest && strings.Contains(authBodyText, "Invalid session ID") {
		authorized = true
		result["authorized_note"] = "token accepted; MCP transport requires a session id for tools/list"
	}
	result["authorized"] = authorized
	result["authorized_status_code"] = authResp.StatusCode
	result["accessible"] = result["protected"] == true && result["authorized"] == true
	return result
}
