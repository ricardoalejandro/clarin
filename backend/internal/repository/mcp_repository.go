package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type MCPRepository struct {
	db *pgxpool.Pool
}

func (r *MCPRepository) CreateClient(ctx context.Context, client *domain.MCPClient) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO mcp_clients (
			id, name, client_kind, scope_type, status, token_hash, token_prefix,
			oauth_redirect_uri, created_by_user_id, created_at, activated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, client.ID, client.Name, client.ClientKind, client.ScopeType, client.Status, client.TokenHash, client.TokenPrefix, client.OAuthRedirectURI, client.CreatedByUserID, client.CreatedAt, client.ActivatedAt)
	return err
}

func (r *MCPRepository) CreateClientWithAccounts(ctx context.Context, client *domain.MCPClient, accountIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO mcp_clients (
			id, name, client_kind, scope_type, status, token_hash, token_prefix,
			oauth_redirect_uri, created_by_user_id, created_at, activated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, client.ID, client.Name, client.ClientKind, client.ScopeType, client.Status, client.TokenHash, client.TokenPrefix, client.OAuthRedirectURI, client.CreatedByUserID, client.CreatedAt, client.ActivatedAt); err != nil {
		return err
	}

	for _, accountID := range accountIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mcp_client_accounts (client_id, account_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, client.ID, accountID); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}

func (r *MCPRepository) ListClients(ctx context.Context, includeRevoked bool) ([]*domain.MCPClient, error) {
	rows, err := r.db.Query(ctx, `
		SELECT c.id, c.name, c.client_kind, c.scope_type, c.status, c.token_prefix, COALESCE(c.oauth_redirect_uri, ''),
		       c.created_by_user_id, c.created_at, c.activated_at, c.last_seen_at, c.blocked_at,
		       COALESCE(c.blocked_reason, ''),
		       COALESCE(COUNT(s.id) FILTER (WHERE s.status = 'active'), 0) AS active_sessions
		FROM mcp_clients c
		LEFT JOIN mcp_sessions s ON s.client_id = c.id
		WHERE ($1 OR c.status <> 'revoked')
		GROUP BY c.id
		ORDER BY c.created_at DESC
	`, includeRevoked)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var clients []*domain.MCPClient
	for rows.Next() {
		client := &domain.MCPClient{}
		if err := rows.Scan(
			&client.ID, &client.Name, &client.ClientKind, &client.ScopeType, &client.Status, &client.TokenPrefix,
			&client.OAuthRedirectURI, &client.CreatedByUserID, &client.CreatedAt, &client.ActivatedAt, &client.LastSeenAt, &client.BlockedAt,
			&client.BlockedReason, &client.ActiveSessions,
		); err != nil {
			return nil, err
		}
		clients = append(clients, client)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, client := range clients {
		if err := r.hydrateClientAccounts(ctx, client); err != nil {
			return nil, err
		}
	}
	return clients, nil
}

func (r *MCPRepository) GetClientByTokenHash(ctx context.Context, tokenHash string) (*domain.MCPClient, error) {
	client := &domain.MCPClient{}
	err := r.db.QueryRow(ctx, `
		SELECT id, name, client_kind, scope_type, status, token_hash, token_prefix, COALESCE(oauth_redirect_uri, ''),
		       created_by_user_id, created_at, activated_at, last_seen_at, blocked_at,
		       COALESCE(blocked_reason, '')
		FROM mcp_clients
		WHERE token_hash = $1
	`, tokenHash).Scan(
		&client.ID, &client.Name, &client.ClientKind, &client.ScopeType, &client.Status, &client.TokenHash, &client.TokenPrefix,
		&client.OAuthRedirectURI, &client.CreatedByUserID, &client.CreatedAt, &client.ActivatedAt, &client.LastSeenAt, &client.BlockedAt,
		&client.BlockedReason,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.hydrateClientAccounts(ctx, client); err != nil {
		return nil, err
	}
	return client, nil
}

func (r *MCPRepository) GetClientByID(ctx context.Context, id uuid.UUID) (*domain.MCPClient, error) {
	client := &domain.MCPClient{}
	err := r.db.QueryRow(ctx, `
		SELECT id, name, client_kind, scope_type, status, token_hash, token_prefix, COALESCE(oauth_redirect_uri, ''),
		       created_by_user_id, created_at, activated_at, last_seen_at, blocked_at,
		       COALESCE(blocked_reason, '')
		FROM mcp_clients
		WHERE id = $1
	`, id).Scan(
		&client.ID, &client.Name, &client.ClientKind, &client.ScopeType, &client.Status, &client.TokenHash, &client.TokenPrefix,
		&client.OAuthRedirectURI, &client.CreatedByUserID, &client.CreatedAt, &client.ActivatedAt, &client.LastSeenAt, &client.BlockedAt,
		&client.BlockedReason,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err := r.hydrateClientAccounts(ctx, client); err != nil {
		return nil, err
	}
	return client, nil
}

func (r *MCPRepository) CreateOAuthCode(ctx context.Context, code *domain.MCPOAuthCode) error {
	_, err := r.db.Exec(ctx, `
		INSERT INTO mcp_oauth_codes (
			id, code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
			resource, scope, user_id, expires_at, ip_hash, user_agent_hash, created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
	`, code.ID, code.CodeHash, code.ClientID, code.RedirectURI, code.CodeChallenge, code.CodeChallengeMethod, code.Resource, code.Scope, code.UserID, code.ExpiresAt, code.IPHash, code.UserAgentHash, code.CreatedAt)
	return err
}

func (r *MCPRepository) ConsumeOAuthCode(ctx context.Context, codeHash string) (*domain.MCPOAuthCode, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	code := &domain.MCPOAuthCode{}
	err = tx.QueryRow(ctx, `
		SELECT id, code_hash, client_id, redirect_uri, code_challenge, code_challenge_method,
		       resource, scope, user_id, expires_at, consumed_at, COALESCE(ip_hash, ''),
		       COALESCE(user_agent_hash, ''), created_at
		FROM mcp_oauth_codes
		WHERE code_hash = $1
		FOR UPDATE
	`, codeHash).Scan(
		&code.ID, &code.CodeHash, &code.ClientID, &code.RedirectURI, &code.CodeChallenge, &code.CodeChallengeMethod,
		&code.Resource, &code.Scope, &code.UserID, &code.ExpiresAt, &code.ConsumedAt, &code.IPHash,
		&code.UserAgentHash, &code.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if code.ConsumedAt != nil || time.Now().After(code.ExpiresAt) {
		return nil, pgx.ErrNoRows
	}
	if _, err := tx.Exec(ctx, `UPDATE mcp_oauth_codes SET consumed_at = NOW() WHERE id = $1`, code.ID); err != nil {
		return nil, err
	}
	return code, tx.Commit(ctx)
}

func (r *MCPRepository) CreateOAuthToken(ctx context.Context, tokenHash string, clientID uuid.UUID, resource, scope string, expiresAt time.Time) error {
	return r.CreateOAuthTokenPair(ctx, tokenHash, "", clientID, resource, scope, expiresAt, time.Time{})
}

func (r *MCPRepository) CreateOAuthTokenPair(ctx context.Context, accessTokenHash, refreshTokenHash string, clientID uuid.UUID, resource, scope string, accessExpiresAt, refreshExpiresAt time.Time) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `
		INSERT INTO mcp_oauth_tokens (id, token_hash, client_id, resource, scope, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
	`, uuid.New(), accessTokenHash, clientID, resource, scope, accessExpiresAt); err != nil {
		return err
	}
	if refreshTokenHash != "" {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mcp_oauth_refresh_tokens (id, token_hash, client_id, resource, scope, expires_at, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
		`, uuid.New(), refreshTokenHash, clientID, resource, scope, refreshExpiresAt); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *MCPRepository) RotateOAuthRefreshToken(ctx context.Context, oldRefreshHash, newRefreshHash, newAccessHash string, clientID uuid.UUID, resource string, accessExpiresAt, refreshExpiresAt time.Time) (*domain.MCPOAuthRefreshToken, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	refreshToken := &domain.MCPOAuthRefreshToken{}
	err = tx.QueryRow(ctx, `
		SELECT id, token_hash, client_id, resource, scope, expires_at, revoked_at, last_used_at, created_at
		FROM mcp_oauth_refresh_tokens
		WHERE token_hash = $1
		  AND client_id = $2
		  AND resource = $3
		  AND revoked_at IS NULL
		  AND expires_at > NOW()
		FOR UPDATE
	`, oldRefreshHash, clientID, resource).Scan(
		&refreshToken.ID, &refreshToken.TokenHash, &refreshToken.ClientID, &refreshToken.Resource, &refreshToken.Scope,
		&refreshToken.ExpiresAt, &refreshToken.RevokedAt, &refreshToken.LastUsedAt, &refreshToken.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE mcp_oauth_refresh_tokens
		SET revoked_at = NOW(), last_used_at = NOW()
		WHERE id = $1
	`, refreshToken.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mcp_oauth_tokens (id, token_hash, client_id, resource, scope, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
	`, uuid.New(), newAccessHash, refreshToken.ClientID, resource, refreshToken.Scope, accessExpiresAt); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO mcp_oauth_refresh_tokens (id, token_hash, client_id, resource, scope, expires_at, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, NOW())
	`, uuid.New(), newRefreshHash, refreshToken.ClientID, resource, refreshToken.Scope, refreshExpiresAt); err != nil {
		return nil, err
	}
	return refreshToken, tx.Commit(ctx)
}

func (r *MCPRepository) GetClientByOAuthTokenHash(ctx context.Context, tokenHash, resource string) (*domain.MCPClient, error) {
	client := &domain.MCPClient{}
	err := r.db.QueryRow(ctx, `
		SELECT c.id, c.name, c.client_kind, c.scope_type, c.status, c.token_hash, c.token_prefix,
		       COALESCE(c.oauth_redirect_uri, ''), c.created_by_user_id, c.created_at, c.activated_at,
		       c.last_seen_at, c.blocked_at, COALESCE(c.blocked_reason, '')
		FROM mcp_oauth_tokens t
		JOIN mcp_clients c ON c.id = t.client_id
		WHERE t.token_hash = $1
		  AND t.resource = $2
		  AND t.revoked_at IS NULL
		  AND t.expires_at > NOW()
	`, tokenHash, resource).Scan(
		&client.ID, &client.Name, &client.ClientKind, &client.ScopeType, &client.Status, &client.TokenHash, &client.TokenPrefix,
		&client.OAuthRedirectURI, &client.CreatedByUserID, &client.CreatedAt, &client.ActivatedAt,
		&client.LastSeenAt, &client.BlockedAt, &client.BlockedReason,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if _, err := r.db.Exec(ctx, `UPDATE mcp_oauth_tokens SET last_used_at = NOW() WHERE token_hash = $1`, tokenHash); err != nil {
		return nil, err
	}
	if err := r.hydrateClientAccounts(ctx, client); err != nil {
		return nil, err
	}
	return client, nil
}

func (r *MCPRepository) SetClientAccounts(ctx context.Context, clientID uuid.UUID, accountIDs []uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM mcp_client_accounts WHERE client_id = $1`, clientID); err != nil {
		return err
	}
	for _, accountID := range accountIDs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO mcp_client_accounts (client_id, account_id)
			VALUES ($1, $2)
			ON CONFLICT DO NOTHING
		`, clientID, accountID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *MCPRepository) hydrateClientAccounts(ctx context.Context, client *domain.MCPClient) error {
	client.OAuthClientID = client.ID.String()
	accounts, err := r.ListClientAccounts(ctx, client.ID)
	if err != nil {
		return err
	}
	client.AllowedAccounts = accounts
	client.AllowedAccountIDs = make([]uuid.UUID, 0, len(accounts))
	for _, account := range accounts {
		if account.IsActive {
			client.AllowedAccountIDs = append(client.AllowedAccountIDs, account.AccountID)
		}
	}
	return nil
}

func (r *MCPRepository) ListClientAccounts(ctx context.Context, clientID uuid.UUID) ([]domain.MCPClientAccount, error) {
	rows, err := r.db.Query(ctx, `
		SELECT a.id, a.name, COALESCE(a.slug, ''), COALESCE(a.is_active, true)
		FROM mcp_client_accounts mca
		JOIN accounts a ON a.id = mca.account_id
		WHERE mca.client_id = $1
		ORDER BY a.name ASC
	`, clientID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	accounts := make([]domain.MCPClientAccount, 0)
	for rows.Next() {
		var account domain.MCPClientAccount
		if err := rows.Scan(&account.AccountID, &account.AccountName, &account.AccountSlug, &account.IsActive); err != nil {
			return nil, err
		}
		accounts = append(accounts, account)
	}
	return accounts, rows.Err()
}

func (r *MCPRepository) RotateClientToken(ctx context.Context, id uuid.UUID, tokenHash, tokenPrefix string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE mcp_clients
		SET token_hash = $2, token_prefix = $3, status = 'active', activated_at = COALESCE(activated_at, NOW()), updated_at = NOW()
		WHERE id = $1 AND status <> 'revoked'
	`, id, tokenHash, tokenPrefix)
	return err
}

func (r *MCPRepository) UpdateClientStatus(ctx context.Context, id uuid.UUID, status, reason string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE mcp_clients
		SET status = $2,
		    blocked_at = CASE WHEN $2 = 'blocked' THEN NOW() ELSE blocked_at END,
		    blocked_reason = CASE WHEN $2 = 'blocked' THEN $3 ELSE '' END,
		    updated_at = NOW()
		WHERE id = $1
	`, id, status, reason)
	return err
}

func (r *MCPRepository) RenameClient(ctx context.Context, id uuid.UUID, name string) error {
	_, err := r.db.Exec(ctx, `UPDATE mcp_clients SET name = $2, updated_at = NOW() WHERE id = $1`, id, name)
	return err
}

func (r *MCPRepository) UpdateClientOAuthRedirectURI(ctx context.Context, id uuid.UUID, redirectURI string) error {
	_, err := r.db.Exec(ctx, `UPDATE mcp_clients SET oauth_redirect_uri = $2, updated_at = NOW() WHERE id = $1`, id, redirectURI)
	return err
}

func (r *MCPRepository) TouchClient(ctx context.Context, id uuid.UUID) {
	_, _ = r.db.Exec(ctx, `UPDATE mcp_clients SET last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`, id)
}

func (r *MCPRepository) UpsertSession(ctx context.Context, session *domain.MCPSession) (*domain.MCPSession, error) {
	row := r.db.QueryRow(ctx, `
		INSERT INTO mcp_sessions (
			id, client_id, transport, session_key_hash, ip_hash, user_agent_hash, origin_hash,
			status, first_seen_at, last_seen_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NOW(), NOW())
		ON CONFLICT (client_id, session_key_hash) DO UPDATE
		SET last_seen_at = NOW(),
		    transport = EXCLUDED.transport,
		    ip_hash = EXCLUDED.ip_hash,
		    user_agent_hash = EXCLUDED.user_agent_hash,
		    origin_hash = EXCLUDED.origin_hash
		RETURNING id, client_id, transport, session_key_hash, COALESCE(ip_hash, ''), COALESCE(user_agent_hash, ''),
		          COALESCE(origin_hash, ''), status, COALESCE(block_reason, ''), first_seen_at, last_seen_at, disconnected_at
	`, session.ID, session.ClientID, session.Transport, session.SessionKeyHash, session.IPHash, session.UserAgentHash, session.OriginHash)

	out := &domain.MCPSession{}
	err := row.Scan(
		&out.ID, &out.ClientID, &out.Transport, &out.SessionKeyHash, &out.IPHash, &out.UserAgentHash,
		&out.OriginHash, &out.Status, &out.BlockReason, &out.FirstSeenAt, &out.LastSeenAt, &out.DisconnectedAt,
	)
	return out, err
}

func (r *MCPRepository) ListSessions(ctx context.Context, limit int) ([]*domain.MCPSession, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := r.db.Query(ctx, `
		SELECT s.id, s.client_id, c.name, s.transport, s.session_key_hash,
		       COALESCE(s.ip_hash, ''), COALESCE(s.user_agent_hash, ''), COALESCE(s.origin_hash, ''),
		       s.status, COALESCE(s.block_reason, ''), s.first_seen_at, s.last_seen_at, s.disconnected_at
		FROM mcp_sessions s
		JOIN mcp_clients c ON c.id = s.client_id
		ORDER BY s.last_seen_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sessions []*domain.MCPSession
	for rows.Next() {
		session := &domain.MCPSession{}
		if err := rows.Scan(
			&session.ID, &session.ClientID, &session.ClientName, &session.Transport, &session.SessionKeyHash,
			&session.IPHash, &session.UserAgentHash, &session.OriginHash,
			&session.Status, &session.BlockReason, &session.FirstSeenAt, &session.LastSeenAt, &session.DisconnectedAt,
		); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	return sessions, rows.Err()
}

func (r *MCPRepository) UpdateSessionStatus(ctx context.Context, id uuid.UUID, status, reason string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE mcp_sessions
		SET status = $2,
		    block_reason = CASE WHEN $2 = 'blocked' THEN $3 ELSE '' END,
		    disconnected_at = CASE WHEN $2 IN ('blocked', 'closed') THEN NOW() ELSE disconnected_at END
		WHERE id = $1
	`, id, status, reason)
	return err
}

func (r *MCPRepository) RecordAuditEvent(ctx context.Context, event *domain.MCPAuditEvent) error {
	if event.ID == uuid.Nil {
		event.ID = uuid.New()
	}
	if event.CreatedAt.IsZero() {
		event.CreatedAt = time.Now()
	}
	metadata := []byte("{}")
	if event.Metadata != nil {
		if raw, err := json.Marshal(event.Metadata); err == nil {
			metadata = raw
		}
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO mcp_audit_events (
			id, client_id, session_id, event_type, tool_name, account_ids, result_count,
			ip_hash, user_agent_hash, metadata, created_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
	`, event.ID, event.ClientID, event.SessionID, event.EventType, event.ToolName, event.AccountIDs, event.ResultCount, event.IPHash, event.UserAgentHash, metadata, event.CreatedAt)
	return err
}

func (r *MCPRepository) ListAuditEvents(ctx context.Context, limit int) ([]*domain.MCPAuditEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := r.db.Query(ctx, `
		SELECT e.id, e.client_id, COALESCE(c.name, ''), e.session_id, e.event_type, COALESCE(e.tool_name, ''),
		       COALESCE(e.account_ids, ARRAY[]::TEXT[]), COALESCE(e.result_count, 0),
		       COALESCE(e.ip_hash, ''), COALESCE(e.user_agent_hash, ''), COALESCE(e.metadata, '{}'::jsonb), e.created_at
		FROM mcp_audit_events e
		LEFT JOIN mcp_clients c ON c.id = e.client_id
		ORDER BY e.created_at DESC
		LIMIT $1
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var events []*domain.MCPAuditEvent
	for rows.Next() {
		event := &domain.MCPAuditEvent{}
		var metadata []byte
		if err := rows.Scan(
			&event.ID, &event.ClientID, &event.ClientName, &event.SessionID, &event.EventType, &event.ToolName,
			&event.AccountIDs, &event.ResultCount, &event.IPHash, &event.UserAgentHash, &metadata, &event.CreatedAt,
		); err != nil {
			return nil, err
		}
		if len(metadata) > 0 {
			_ = json.Unmarshal(metadata, &event.Metadata)
		}
		events = append(events, event)
	}
	return events, rows.Err()
}
