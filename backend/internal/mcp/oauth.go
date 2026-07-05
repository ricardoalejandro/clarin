package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const (
	mcpPublicBaseURL       = "https://clarin.naperu.cloud"
	mcpResourceURI         = mcpPublicBaseURL + "/mcp"
	mcpOAuthScope          = "mcp:read"
	mcpOAuthCodeTTL        = 5 * time.Minute
	mcpOAuthAccessTokenTTL = 1 * time.Hour
	mcpOAuthRefreshTTL     = 30 * 24 * time.Hour
)

func setMCPAuthChallenge(w http.ResponseWriter, reason string) {
	value := fmt.Sprintf(`Bearer resource_metadata="%s/.well-known/oauth-protected-resource"`, mcpPublicBaseURL)
	if reason != "" && reason != "missing_authorization" {
		value += `, error="invalid_token"`
	}
	w.Header().Set("WWW-Authenticate", value)
}

func (s *MCPServer) oauthProtectedResourceMetadataHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		writeOAuthJSON(w, map[string]any{
			"resource":                 mcpResourceURI,
			"authorization_servers":    []string{mcpPublicBaseURL},
			"scopes_supported":         []string{mcpOAuthScope},
			"bearer_methods_supported": []string{"header"},
		})
	}
}

func (s *MCPServer) oauthAuthorizationServerMetadataHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		writeOAuthJSON(w, map[string]any{
			"issuer":                                mcpPublicBaseURL,
			"authorization_endpoint":                mcpPublicBaseURL + "/oauth/authorize",
			"token_endpoint":                        mcpPublicBaseURL + "/oauth/token",
			"response_types_supported":              []string{"code"},
			"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
			"code_challenge_methods_supported":      []string{"S256"},
			"token_endpoint_auth_methods_supported": []string{"none"},
			"scopes_supported":                      []string{mcpOAuthScope},
		})
	}
}

func (s *MCPServer) oauthAuthorizeHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		redirectURI := strings.TrimSpace(q.Get("redirect_uri"))
		state := q.Get("state")

		client, err := s.validateOAuthAuthorizeRequest(r.Context(), q)
		if err != nil {
			if redirectURI != "" && isAllowedChatGPTRedirectURI(redirectURI) {
				redirectWithOAuthError(w, r, redirectURI, state, "invalid_request", err.Error())
				return
			}
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		claims, err := s.currentOAuthUser(r)
		if err != nil {
			next := mcpPublicBaseURL + r.URL.RequestURI()
			http.Redirect(w, r, mcpPublicBaseURL+"/login?next="+url.QueryEscape(next), http.StatusFound)
			return
		}
		if !claims.IsSuperAdmin {
			http.Error(w, "solo un super_admin puede autorizar conexiones MCP OAuth", http.StatusForbidden)
			return
		}

		rawCode, err := randomOAuthSecret("clarin_mcp_code_")
		if err != nil {
			http.Error(w, "could not create authorization code", http.StatusInternalServerError)
			return
		}
		code := &domain.MCPOAuthCode{
			ID:                  uuid.New(),
			CodeHash:            hashKey(rawCode),
			ClientID:            client.ID,
			RedirectURI:         redirectURI,
			CodeChallenge:       q.Get("code_challenge"),
			CodeChallengeMethod: q.Get("code_challenge_method"),
			Resource:            q.Get("resource"),
			Scope:               normalizeOAuthScope(q.Get("scope")),
			UserID:              claims.UserID,
			ExpiresAt:           time.Now().Add(mcpOAuthCodeTTL),
			IPHash:              hashKey(remoteIP(r)),
			UserAgentHash:       hashKey(r.UserAgent()),
			CreatedAt:           time.Now(),
		}
		if err := s.repos.MCP.CreateOAuthCode(r.Context(), code); err != nil {
			http.Error(w, "could not store authorization code", http.StatusInternalServerError)
			return
		}
		_ = s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
			ClientID:      &client.ID,
			EventType:     "oauth_authorized",
			IPHash:        code.IPHash,
			UserAgentHash: code.UserAgentHash,
			Metadata:      map[string]any{"user_id": claims.UserID.String(), "scope": code.Scope, "resource": code.Resource},
		})

		out := redirectAppend(redirectURI, "code", rawCode)
		if state != "" {
			out = redirectAppend(out, "state", state)
		}
		http.Redirect(w, r, out, http.StatusFound)
	}
}

func (s *MCPServer) oauthTokenHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		if err := r.ParseForm(); err != nil {
			writeOAuthError(w, http.StatusBadRequest, "invalid_request", "invalid form")
			return
		}
		if strings.TrimSpace(r.Form.Get("client_secret")) != "" || r.Header.Get("Authorization") != "" {
			writeOAuthError(w, http.StatusBadRequest, "invalid_client", "client authentication is not supported for this public MCP client")
			return
		}
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			s.handleOAuthAuthorizationCodeGrant(w, r)
		case "refresh_token":
			s.handleOAuthRefreshTokenGrant(w, r)
		default:
			writeOAuthError(w, http.StatusBadRequest, "unsupported_grant_type", "only authorization_code and refresh_token are supported")
		}
	}
}

func (s *MCPServer) handleOAuthAuthorizationCodeGrant(w http.ResponseWriter, r *http.Request) {
	clientID, err := uuid.Parse(strings.TrimSpace(r.Form.Get("client_id")))
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "invalid client_id")
		return
	}
	redirectURI := strings.TrimSpace(r.Form.Get("redirect_uri"))
	resource := strings.TrimSpace(r.Form.Get("resource"))
	if resource == "" {
		resource = mcpResourceURI
	}
	if resource != mcpResourceURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target", "invalid resource")
		return
	}

	code, err := s.repos.MCP.ConsumeOAuthCode(r.Context(), hashKey(r.Form.Get("code")))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "authorization code is invalid, expired, or already used")
			return
		}
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not consume authorization code")
		return
	}
	if code.ClientID != clientID || code.RedirectURI != redirectURI || code.Resource != mcpResourceURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "authorization code does not match this request")
		return
	}
	if !verifyPKCE(r.Form.Get("code_verifier"), code.CodeChallenge) {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "PKCE verification failed")
		return
	}
	client, err := s.repos.MCP.GetClientByID(r.Context(), clientID)
	if err != nil || client == nil || client.Status != domain.MCPStatusActive || client.OAuthRedirectURI != redirectURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "MCP OAuth client is not active")
		return
	}

	accessToken, err := randomOAuthSecret("clarin_mcp_at_")
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not create access token")
		return
	}
	refreshToken, err := randomOAuthSecret("clarin_mcp_rt_")
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not create refresh token")
		return
	}
	now := time.Now()
	expiresAt := now.Add(mcpOAuthAccessTokenTTL)
	refreshExpiresAt := now.Add(mcpOAuthRefreshTTL)
	if err := s.repos.MCP.CreateOAuthTokenPair(r.Context(), hashKey(accessToken), hashKey(refreshToken), clientID, resource, code.Scope, expiresAt, refreshExpiresAt); err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not store access token")
		return
	}
	_ = s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
		ClientID:      &clientID,
		EventType:     "oauth_token_issued",
		IPHash:        hashKey(remoteIP(r)),
		UserAgentHash: hashKey(r.UserAgent()),
		Metadata:      map[string]any{"scope": code.Scope, "resource": resource, "expires_in": int(mcpOAuthAccessTokenTTL.Seconds())},
	})
	writeOAuthJSON(w, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    int(mcpOAuthAccessTokenTTL.Seconds()),
		"refresh_token": refreshToken,
		"resource":      mcpResourceURI,
		"scope":         code.Scope,
	})
}

func (s *MCPServer) handleOAuthRefreshTokenGrant(w http.ResponseWriter, r *http.Request) {
	clientID, err := uuid.Parse(strings.TrimSpace(r.Form.Get("client_id")))
	if err != nil {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "invalid client_id")
		return
	}
	resource := strings.TrimSpace(r.Form.Get("resource"))
	if resource == "" {
		resource = mcpResourceURI
	}
	if resource != mcpResourceURI {
		writeOAuthError(w, http.StatusBadRequest, "invalid_target", "invalid resource")
		return
	}
	refreshToken := strings.TrimSpace(r.Form.Get("refresh_token"))
	if refreshToken == "" {
		writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "missing refresh_token")
		return
	}
	accessToken, err := randomOAuthSecret("clarin_mcp_at_")
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not create access token")
		return
	}
	nextRefreshToken, err := randomOAuthSecret("clarin_mcp_rt_")
	if err != nil {
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not create refresh token")
		return
	}
	now := time.Now()
	rotated, err := s.repos.MCP.RotateOAuthRefreshToken(
		r.Context(),
		hashKey(refreshToken),
		hashKey(nextRefreshToken),
		hashKey(accessToken),
		clientID,
		resource,
		now.Add(mcpOAuthAccessTokenTTL),
		now.Add(mcpOAuthRefreshTTL),
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeOAuthError(w, http.StatusBadRequest, "invalid_grant", "refresh token is invalid, expired, or already used")
			return
		}
		writeOAuthError(w, http.StatusInternalServerError, "server_error", "could not rotate refresh token")
		return
	}
	client, err := s.repos.MCP.GetClientByID(r.Context(), clientID)
	if err != nil || client == nil || client.Status != domain.MCPStatusActive {
		writeOAuthError(w, http.StatusBadRequest, "invalid_client", "MCP OAuth client is not active")
		return
	}
	_ = s.repos.MCP.RecordAuditEvent(context.Background(), &domain.MCPAuditEvent{
		ClientID:      &clientID,
		EventType:     "oauth_token_refreshed",
		IPHash:        hashKey(remoteIP(r)),
		UserAgentHash: hashKey(r.UserAgent()),
		Metadata:      map[string]any{"scope": rotated.Scope, "resource": resource, "expires_in": int(mcpOAuthAccessTokenTTL.Seconds())},
	})
	writeOAuthJSON(w, map[string]any{
		"access_token":  accessToken,
		"token_type":    "Bearer",
		"expires_in":    int(mcpOAuthAccessTokenTTL.Seconds()),
		"refresh_token": nextRefreshToken,
		"resource":      mcpResourceURI,
		"scope":         rotated.Scope,
	})
}

func (s *MCPServer) validateOAuthAuthorizeRequest(ctx context.Context, q url.Values) (*domain.MCPClient, error) {
	if q.Get("response_type") != "code" {
		return nil, errors.New("response_type debe ser code")
	}
	clientID, err := uuid.Parse(strings.TrimSpace(q.Get("client_id")))
	if err != nil {
		return nil, errors.New("client_id inválido")
	}
	client, err := s.repos.MCP.GetClientByID(ctx, clientID)
	if err != nil {
		return nil, err
	}
	if client == nil || client.Status != domain.MCPStatusActive {
		return nil, errors.New("cliente OAuth MCP no activo")
	}
	redirectURI := strings.TrimSpace(q.Get("redirect_uri"))
	if redirectURI == "" || redirectURI != client.OAuthRedirectURI || !isAllowedChatGPTRedirectURI(redirectURI) {
		return nil, errors.New("redirect_uri no coincide con la conexión MCP")
	}
	if strings.TrimSpace(q.Get("resource")) != mcpResourceURI {
		return nil, errors.New("resource inválido")
	}
	if normalizeOAuthScope(q.Get("scope")) != mcpOAuthScope {
		return nil, errors.New("scope inválido")
	}
	if q.Get("code_challenge_method") != "S256" || strings.TrimSpace(q.Get("code_challenge")) == "" {
		return nil, errors.New("PKCE S256 es obligatorio")
	}
	return client, nil
}

func (s *MCPServer) currentOAuthUser(r *http.Request) (*serviceJWTClaims, error) {
	cookie, err := r.Cookie("auth-token")
	if err != nil || strings.TrimSpace(cookie.Value) == "" {
		return nil, errors.New("missing auth cookie")
	}
	claims, err := s.services.Auth.ValidateToken(cookie.Value, s.jwtSecret)
	if err != nil {
		return nil, err
	}
	return &serviceJWTClaims{
		UserID:       claims.UserID,
		IsSuperAdmin: claims.IsSuperAdmin || claims.Role == domain.RoleSuperAdmin,
	}, nil
}

type serviceJWTClaims struct {
	UserID       uuid.UUID
	IsSuperAdmin bool
}

func isAllowedChatGPTRedirectURI(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "chatgpt.com" && strings.HasPrefix(parsed.Path, "/connector/oauth/") && parsed.RawQuery == "" && parsed.Fragment == ""
}

func normalizeOAuthScope(raw string) string {
	parts := strings.Fields(strings.TrimSpace(raw))
	if len(parts) == 0 {
		return mcpOAuthScope
	}
	if len(parts) == 1 && parts[0] == mcpOAuthScope {
		return mcpOAuthScope
	}
	return strings.Join(parts, " ")
}

func verifyPKCE(verifier, challenge string) bool {
	if verifier == "" || challenge == "" {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:]) == challenge
}

func randomOAuthSecret(prefix string) (string, error) {
	b := make([]byte, 40)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

func redirectAppend(raw, key, value string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	q := parsed.Query()
	q.Set(key, value)
	parsed.RawQuery = q.Encode()
	return parsed.String()
}

func redirectWithOAuthError(w http.ResponseWriter, r *http.Request, redirectURI, state, code, description string) {
	out := redirectAppend(redirectURI, "error", code)
	if description != "" {
		out = redirectAppend(out, "error_description", description)
	}
	if state != "" {
		out = redirectAppend(out, "state", state)
	}
	http.Redirect(w, r, out, http.StatusFound)
}

func writeOAuthError(w http.ResponseWriter, status int, code, description string) {
	writeOAuthJSONStatus(w, status, map[string]any{"error": code, "error_description": description})
}

func writeOAuthJSON(w http.ResponseWriter, payload map[string]any) {
	writeOAuthJSONStatus(w, http.StatusOK, payload)
}

func writeOAuthJSONStatus(w http.ResponseWriter, status int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
