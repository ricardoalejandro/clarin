package api

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func generateMCPToken() (string, error) {
	b := make([]byte, 40)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return "clarin_mcp_" + hex.EncodeToString(b), nil
}

func hashMCPToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

func mcpTokenPrefix(token string) string {
	if len(token) <= 22 {
		return token + "..."
	}
	return token[:22] + "..."
}

func validateChatGPTRedirectURI(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", errors.New("configura la URL de retorno OAuth de ChatGPT para esta conexión")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "chatgpt.com" || !strings.HasPrefix(parsed.Path, "/connector/oauth/") {
		return "", errors.New("la URL de retorno OAuth debe ser exactamente la URL https://chatgpt.com/connector/oauth/... que muestra ChatGPT")
	}
	if parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("la URL de retorno OAuth no debe incluir query ni fragment")
	}
	return parsed.String(), nil
}

func (s *Server) handleAdminListMCPClients(c *fiber.Ctx) error {
	clients, err := s.repos.MCP.ListClients(c.Context(), c.QueryBool("include_revoked", false))
	if err != nil {
		log.Printf("[MCP-ADMIN] list clients: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to list MCP clients"})
	}
	if clients == nil {
		clients = []*domain.MCPClient{}
	}
	return c.JSON(fiber.Map{"success": true, "clients": clients})
}

func (s *Server) handleAdminCreateMCPClient(c *fiber.Ctx) error {
	var req struct {
		Name             string   `json:"name"`
		ClientKind       string   `json:"client_kind"`
		AccountIDs       []string `json:"account_ids"`
		OAuthRedirectURI string   `json:"oauth_redirect_uri"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid request"})
	}
	accountIDs, err := s.parseMCPAccountIDs(c, req.AccountIDs)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = "Cliente MCP Global"
	}
	if req.ClientKind == "" {
		req.ClientKind = domain.MCPClientKindChatGPT
	}
	if req.ClientKind != domain.MCPClientKindChatGPT {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "client_kind must be chatgpt"})
	}
	oauthRedirectURI, err := validateChatGPTRedirectURI(req.OAuthRedirectURI)
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
	}

	rawToken, err := generateMCPToken()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to generate token"})
	}
	now := time.Now()
	userID, _ := c.Locals("user_id").(uuid.UUID)
	client := &domain.MCPClient{
		ID:               uuid.New(),
		Name:             req.Name,
		ClientKind:       req.ClientKind,
		ScopeType:        domain.MCPScopeSelectedAccounts,
		Status:           domain.MCPStatusActive,
		TokenHash:        hashMCPToken(rawToken),
		TokenPrefix:      mcpTokenPrefix(rawToken),
		OAuthRedirectURI: oauthRedirectURI,
		CreatedByUserID:  &userID,
		CreatedAt:        now,
		ActivatedAt:      &now,
	}
	if err := s.repos.MCP.CreateClientWithAccounts(c.Context(), client, accountIDs); err != nil {
		log.Printf("[MCP-ADMIN] create client: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to create MCP client"})
	}
	client.OAuthClientID = client.ID.String()
	client.AllowedAccounts, _ = s.repos.MCP.ListClientAccounts(c.Context(), client.ID)
	_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
		ClientID:  &client.ID,
		EventType: "client_created",
		Metadata:  map[string]any{"created_by": userID.String(), "client_kind": client.ClientKind, "allowed_account_count": len(accountIDs), "oauth_redirect_host": "chatgpt.com"},
	})
	return c.Status(201).JSON(fiber.Map{"success": true, "client": client, "token": rawToken})
}

func (s *Server) handleAdminRotateMCPClient(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}
	rawToken, err := generateMCPToken()
	if err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to generate token"})
	}
	if err := s.repos.MCP.RotateClientToken(c.Context(), id, hashMCPToken(rawToken), mcpTokenPrefix(rawToken)); err != nil {
		log.Printf("[MCP-ADMIN] rotate client: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to rotate MCP token"})
	}
	_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
		ClientID:  &id,
		EventType: "client_token_rotated",
	})
	return c.JSON(fiber.Map{"success": true, "token": rawToken})
}

func (s *Server) handleAdminUpdateMCPClient(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}
	var req struct {
		Name             *string   `json:"name"`
		Status           string    `json:"status"`
		Reason           string    `json:"reason"`
		AccountIDs       *[]string `json:"account_ids"`
		OAuthRedirectURI *string   `json:"oauth_redirect_uri"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid request"})
	}
	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "name cannot be empty"})
		}
		if err := s.repos.MCP.RenameClient(c.Context(), id, name); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to rename MCP client"})
		}
	}
	if req.OAuthRedirectURI != nil {
		redirectURI, err := validateChatGPTRedirectURI(*req.OAuthRedirectURI)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		if err := s.repos.MCP.UpdateClientOAuthRedirectURI(c.Context(), id, redirectURI); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to update OAuth redirect URI"})
		}
		_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
			ClientID:  &id,
			EventType: "client_oauth_redirect_updated",
			Metadata:  map[string]any{"redirect_host": "chatgpt.com"},
		})
	}
	if req.Status != "" {
		switch req.Status {
		case domain.MCPStatusActive, domain.MCPStatusBlocked, domain.MCPStatusRevoked:
		default:
			return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid status"})
		}
		if err := s.repos.MCP.UpdateClientStatus(c.Context(), id, req.Status, strings.TrimSpace(req.Reason)); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to update MCP client"})
		}
		_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
			ClientID:  &id,
			EventType: "client_" + req.Status,
			Metadata:  map[string]any{"reason": req.Reason},
		})
	}
	if req.AccountIDs != nil {
		accountIDs, err := s.parseMCPAccountIDs(c, *req.AccountIDs)
		if err != nil {
			return c.Status(400).JSON(fiber.Map{"success": false, "error": err.Error()})
		}
		if err := s.repos.MCP.SetClientAccounts(c.Context(), id, accountIDs); err != nil {
			return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to update allowed accounts"})
		}
		_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
			ClientID:  &id,
			EventType: "client_accounts_updated",
			Metadata:  map[string]any{"allowed_account_count": len(accountIDs)},
		})
	}
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) parseMCPAccountIDs(c *fiber.Ctx, rawIDs []string) ([]uuid.UUID, error) {
	if len(rawIDs) == 0 {
		return nil, errors.New("selecciona al menos una cuenta permitida para esta conexión MCP")
	}
	seen := make(map[uuid.UUID]struct{}, len(rawIDs))
	accountIDs := make([]uuid.UUID, 0, len(rawIDs))
	for _, raw := range rawIDs {
		id, err := uuid.Parse(strings.TrimSpace(raw))
		if err != nil {
			return nil, errors.New("account_id inválido")
		}
		if _, ok := seen[id]; ok {
			continue
		}
		var active bool
		err = s.repos.DB().QueryRow(c.Context(), `SELECT COALESCE(is_active, true) FROM accounts WHERE id = $1`, id).Scan(&active)
		if err != nil || !active {
			return nil, errors.New("una de las cuentas permitidas no existe o no está activa")
		}
		seen[id] = struct{}{}
		accountIDs = append(accountIDs, id)
	}
	if len(accountIDs) == 0 {
		return nil, errors.New("selecciona al menos una cuenta permitida para esta conexión MCP")
	}
	return accountIDs, nil
}

func (s *Server) handleAdminListMCPSessions(c *fiber.Ctx) error {
	sessions, err := s.repos.MCP.ListSessions(c.Context(), c.QueryInt("limit", 200))
	if err != nil {
		log.Printf("[MCP-ADMIN] list sessions: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to list MCP sessions"})
	}
	if sessions == nil {
		sessions = []*domain.MCPSession{}
	}
	return c.JSON(fiber.Map{"success": true, "sessions": sessions})
}

func (s *Server) handleAdminUpdateMCPSession(c *fiber.Ctx) error {
	id, err := uuid.Parse(c.Params("id"))
	if err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid id"})
	}
	var req struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	if err := c.BodyParser(&req); err != nil {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid request"})
	}
	if req.Status != domain.MCPStatusActive && req.Status != domain.MCPStatusBlocked && req.Status != "closed" {
		return c.Status(400).JSON(fiber.Map{"success": false, "error": "invalid status"})
	}
	if err := s.repos.MCP.UpdateSessionStatus(c.Context(), id, req.Status, strings.TrimSpace(req.Reason)); err != nil {
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to update MCP session"})
	}
	_ = s.repos.MCP.RecordAuditEvent(c.Context(), &domain.MCPAuditEvent{
		SessionID: &id,
		EventType: "session_" + req.Status,
		Metadata:  map[string]any{"reason": req.Reason},
	})
	return c.JSON(fiber.Map{"success": true})
}

func (s *Server) handleAdminListMCPAudit(c *fiber.Ctx) error {
	events, err := s.repos.MCP.ListAuditEvents(c.Context(), c.QueryInt("limit", 200))
	if err != nil {
		log.Printf("[MCP-ADMIN] list audit: %v", err)
		return c.Status(500).JSON(fiber.Map{"success": false, "error": "failed to list MCP audit"})
	}
	if events == nil {
		events = []*domain.MCPAuditEvent{}
	}
	return c.JSON(fiber.Map{"success": true, "events": events})
}
