package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ErosConversationRepository struct {
	db *pgxpool.Pool
}

type ErosSettingsRepository struct {
	db *pgxpool.Pool
}

type ErosFileRepository struct {
	db *pgxpool.Pool
}

func (r *ErosSettingsRepository) Get(ctx context.Context) (*domain.ErosSettings, error) {
	settings := &domain.ErosSettings{}
	err := r.db.QueryRow(ctx, `
		SELECT id, enabled, provider, bridge_url, auth_mode, mcp_base_url, codex_model,
		       default_reasoning_effort, allowed_reasoning_efforts, allow_user_reasoning_override, global_instructions,
		       max_history_messages, updated_by_user_id, created_at, updated_at
		FROM eros_settings
		WHERE id = 1
	`).Scan(
		&settings.ID, &settings.Enabled, &settings.Provider, &settings.BridgeURL, &settings.AuthMode,
		&settings.MCPBaseURL, &settings.CodexModel, &settings.DefaultReasoningEffort,
		&settings.AllowedReasoningEfforts, &settings.AllowUserReasoningOverride,
		&settings.GlobalInstructions, &settings.MaxHistoryMessages,
		&settings.UpdatedByUserID, &settings.CreatedAt, &settings.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return settings, nil
}

func (r *ErosSettingsRepository) Upsert(ctx context.Context, settings *domain.ErosSettings) error {
	if settings.Provider == "" {
		settings.Provider = "codex_bridge"
	}
	if settings.AuthMode == "" {
		settings.AuthMode = "chatgpt_subscription"
	}
	if settings.MaxHistoryMessages <= 0 {
		settings.MaxHistoryMessages = 20
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO eros_settings (
			id, enabled, provider, bridge_url, auth_mode, mcp_base_url,
			codex_model, default_reasoning_effort, allowed_reasoning_efforts, allow_user_reasoning_override,
			global_instructions, max_history_messages, updated_by_user_id, updated_at
		)
		VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
		ON CONFLICT (id) DO UPDATE SET
			enabled = EXCLUDED.enabled,
			provider = EXCLUDED.provider,
			bridge_url = EXCLUDED.bridge_url,
			auth_mode = EXCLUDED.auth_mode,
			mcp_base_url = EXCLUDED.mcp_base_url,
			codex_model = EXCLUDED.codex_model,
			default_reasoning_effort = EXCLUDED.default_reasoning_effort,
			allowed_reasoning_efforts = EXCLUDED.allowed_reasoning_efforts,
			allow_user_reasoning_override = EXCLUDED.allow_user_reasoning_override,
			global_instructions = EXCLUDED.global_instructions,
			max_history_messages = EXCLUDED.max_history_messages,
			updated_by_user_id = EXCLUDED.updated_by_user_id,
			updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, settings.Enabled, settings.Provider, settings.BridgeURL, settings.AuthMode, settings.MCPBaseURL,
		settings.CodexModel, settings.DefaultReasoningEffort, settings.AllowedReasoningEfforts,
		settings.AllowUserReasoningOverride, settings.GlobalInstructions, settings.MaxHistoryMessages,
		settings.UpdatedByUserID,
	).Scan(&settings.ID, &settings.CreatedAt, &settings.UpdatedAt)
}

// ListByUser returns conversations for a user, most recent first, limited to 50.
func (r *ErosConversationRepository) ListByUser(ctx context.Context, accountID, userID uuid.UUID) ([]domain.ErosConversation, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, user_id, title, COALESCE(provider, ''), COALESCE(codex_thread_id, ''),
		       COALESCE(last_status, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM eros_conversations
		WHERE account_id = $1 AND user_id = $2
		ORDER BY updated_at DESC
		LIMIT 50
	`, accountID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var convs []domain.ErosConversation
	for rows.Next() {
		var c domain.ErosConversation
		if err := rows.Scan(
			&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.Provider, &c.CodexThreadID,
			&c.LastStatus, &c.LastError, &c.CreatedAt, &c.UpdatedAt,
		); err != nil {
			return nil, err
		}
		convs = append(convs, c)
	}
	return convs, nil
}

// GetWithMessages returns a conversation with its messages.
func (r *ErosConversationRepository) GetWithMessages(ctx context.Context, accountID, userID, convID uuid.UUID) (*domain.ErosConversation, error) {
	var c domain.ErosConversation
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, user_id, title, COALESCE(provider, ''), COALESCE(codex_thread_id, ''),
		       COALESCE(last_status, ''), COALESCE(last_error, ''), created_at, updated_at
		FROM eros_conversations
		WHERE id = $1 AND account_id = $2 AND user_id = $3
	`, convID, accountID, userID).Scan(
		&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.Provider, &c.CodexThreadID,
		&c.LastStatus, &c.LastError, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}

	msgRows, err := r.db.Query(ctx, `
		SELECT id, conversation_id, role, content,
		       COALESCE(codex_model, ''), COALESCE(reasoning_effort, ''), COALESCE(duration_ms, 0),
		       COALESCE(metadata, '{}'::jsonb), COALESCE(tool_calls, '[]'::jsonb), created_at
		FROM eros_messages
		WHERE conversation_id = $1
		ORDER BY created_at ASC
	`, convID)
	if err != nil {
		return nil, err
	}
	defer msgRows.Close()

	for msgRows.Next() {
		var m domain.ErosMessage
		var metadata []byte
		var toolCalls []byte
		if err := msgRows.Scan(
			&m.ID, &m.ConversationID, &m.Role, &m.Content,
			&m.CodexModel, &m.ReasoningEffort, &m.DurationMS,
			&metadata, &toolCalls, &m.CreatedAt,
		); err != nil {
			return nil, err
		}
		m.Metadata = json.RawMessage(metadata)
		m.ToolCalls = json.RawMessage(toolCalls)
		c.Messages = append(c.Messages, m)
	}
	if err := msgRows.Err(); err != nil {
		return nil, err
	}
	if len(c.Messages) > 0 {
		attachmentsByMessage, err := r.listFilesByConversation(ctx, accountID, userID, convID)
		if err != nil {
			return nil, err
		}
		for i := range c.Messages {
			c.Messages[i].Attachments = attachmentsByMessage[c.Messages[i].ID]
		}
	}
	return &c, nil
}

// Create creates a new conversation.
func (r *ErosConversationRepository) Create(ctx context.Context, accountID, userID uuid.UUID, title string) (*domain.ErosConversation, error) {
	var c domain.ErosConversation
	err := r.db.QueryRow(ctx, `
		INSERT INTO eros_conversations (account_id, user_id, title, provider, last_status)
		VALUES ($1, $2, $3, 'codex_bridge', 'created')
		RETURNING id, account_id, user_id, title, COALESCE(provider, ''), COALESCE(codex_thread_id, ''),
		          COALESCE(last_status, ''), COALESCE(last_error, ''), created_at, updated_at
	`, accountID, userID, title).Scan(
		&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.Provider, &c.CodexThreadID,
		&c.LastStatus, &c.LastError, &c.CreatedAt, &c.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// AddMessage adds a message to a conversation and updates its updated_at.
func (r *ErosConversationRepository) AddMessage(ctx context.Context, convID uuid.UUID, role, content string) (*domain.ErosMessage, error) {
	return r.AddMessageWithMetadata(ctx, convID, role, content, "", "", 0, nil, nil)
}

// AddMessageWithMetadata adds a message with optional per-call Eros execution metadata.
func (r *ErosConversationRepository) AddMessageWithMetadata(ctx context.Context, convID uuid.UUID, role, content, codexModel, reasoningEffort string, durationMS int64, metadata, toolCalls json.RawMessage) (*domain.ErosMessage, error) {
	var m domain.ErosMessage
	metadataJSON := normalizedJSONRaw(metadata, "{}")
	toolCallsJSON := normalizedJSONRaw(toolCalls, "[]")
	var savedMetadata []byte
	var savedToolCalls []byte
	err := r.db.QueryRow(ctx, `
		INSERT INTO eros_messages (
			conversation_id, role, content, codex_model, reasoning_effort, duration_ms, metadata, tool_calls
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
		RETURNING id, conversation_id, role, content, codex_model, reasoning_effort, duration_ms,
		          metadata, tool_calls, created_at
	`, convID, role, content, codexModel, reasoningEffort, durationMS, metadataJSON, toolCallsJSON).Scan(
		&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.CodexModel, &m.ReasoningEffort,
		&m.DurationMS, &savedMetadata, &savedToolCalls, &m.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	m.Metadata = json.RawMessage(savedMetadata)
	m.ToolCalls = json.RawMessage(savedToolCalls)

	// Touch conversation updated_at
	_, _ = r.db.Exec(ctx, `UPDATE eros_conversations SET updated_at = $1 WHERE id = $2`, time.Now(), convID)

	return &m, nil
}

func normalizedJSONRaw(raw json.RawMessage, fallback string) string {
	if len(raw) == 0 || !json.Valid(raw) {
		return fallback
	}
	return string(raw)
}

// Delete removes a conversation (cascade deletes messages).
func (r *ErosConversationRepository) Delete(ctx context.Context, accountID, userID, convID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM eros_conversations WHERE id = $1 AND account_id = $2 AND user_id = $3`, convID, accountID, userID)
	return err
}

// UpdateTitle updates a conversation title.
func (r *ErosConversationRepository) UpdateTitle(ctx context.Context, accountID, userID, convID uuid.UUID, title string) error {
	_, err := r.db.Exec(ctx, `UPDATE eros_conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND account_id = $3 AND user_id = $4`, title, convID, accountID, userID)
	return err
}

func (r *ErosConversationRepository) UpdateBridgeState(ctx context.Context, accountID, userID, convID uuid.UUID, codexThreadID, status, lastError string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE eros_conversations
		SET codex_thread_id = COALESCE(NULLIF($4, ''), codex_thread_id),
		    last_status = $5,
		    last_error = $6,
		    updated_at = NOW()
		WHERE id = $1 AND account_id = $2 AND user_id = $3
	`, convID, accountID, userID, codexThreadID, status, lastError)
	return err
}

// CountByUser returns the number of conversations for a user.
func (r *ErosConversationRepository) CountByUser(ctx context.Context, accountID, userID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*) FROM eros_conversations WHERE account_id = $1 AND user_id = $2`, accountID, userID).Scan(&count)
	return count, err
}

func (r *ErosConversationRepository) listFilesByConversation(ctx context.Context, accountID, userID, convID uuid.UUID) (map[uuid.UUID][]domain.ErosFile, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, user_id, conversation_id, message_id, filename, format, content_type,
		       status, size_bytes, checksum, generation_spec, expires_at, delivered_at, created_at, updated_at
		FROM eros_files
		WHERE account_id = $1 AND user_id = $2 AND conversation_id = $3
		ORDER BY created_at ASC
	`, accountID, userID, convID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[uuid.UUID][]domain.ErosFile{}
	for rows.Next() {
		file, err := scanErosFile(rows)
		if err != nil {
			return nil, err
		}
		out[file.MessageID] = append(out[file.MessageID], *file)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *ErosFileRepository) Create(ctx context.Context, file *domain.ErosFile) (*domain.ErosFile, error) {
	if file.ID == uuid.Nil {
		file.ID = uuid.New()
	}
	spec := normalizedJSONRaw(file.GenerationSpec, "{}")
	var savedSpec []byte
	var out domain.ErosFile
	err := r.db.QueryRow(ctx, `
		INSERT INTO eros_files (
			id, account_id, user_id, conversation_id, message_id, filename, format, content_type,
			status, size_bytes, checksum, generation_spec, expires_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE(NULLIF($9, ''), 'ready'), $10, $11, $12::jsonb, $13)
		RETURNING id, account_id, user_id, conversation_id, message_id, filename, format, content_type,
		          status, size_bytes, checksum, generation_spec, expires_at, delivered_at, created_at, updated_at
	`, file.ID, file.AccountID, file.UserID, file.ConversationID, file.MessageID, file.Filename,
		file.Format, file.ContentType, file.Status, file.SizeBytes, file.Checksum, spec, file.ExpiresAt,
	).Scan(
		&out.ID, &out.AccountID, &out.UserID, &out.ConversationID, &out.MessageID, &out.Filename,
		&out.Format, &out.ContentType, &out.Status, &out.SizeBytes, &out.Checksum, &savedSpec,
		&out.ExpiresAt, &out.DeliveredAt, &out.CreatedAt, &out.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	out.GenerationSpec = json.RawMessage(savedSpec)
	return &out, nil
}

func (r *ErosFileRepository) GetForDownload(ctx context.Context, accountID, userID, fileID uuid.UUID) (*domain.ErosFile, string, error) {
	var file domain.ErosFile
	var spec []byte
	var sourceContent string
	err := r.db.QueryRow(ctx, `
		SELECT f.id, f.account_id, f.user_id, f.conversation_id, f.message_id, f.filename, f.format, f.content_type,
		       f.status, f.size_bytes, f.checksum, f.generation_spec, f.expires_at, f.delivered_at, f.created_at, f.updated_at,
		       m.content
		FROM eros_files f
		JOIN eros_messages m ON m.id = f.message_id
		JOIN eros_conversations c ON c.id = f.conversation_id
		WHERE f.id = $1 AND f.account_id = $2 AND f.user_id = $3 AND c.account_id = $2 AND c.user_id = $3
	`, fileID, accountID, userID).Scan(
		&file.ID, &file.AccountID, &file.UserID, &file.ConversationID, &file.MessageID, &file.Filename,
		&file.Format, &file.ContentType, &file.Status, &file.SizeBytes, &file.Checksum, &spec,
		&file.ExpiresAt, &file.DeliveredAt, &file.CreatedAt, &file.UpdatedAt, &sourceContent,
	)
	if err != nil {
		return nil, "", err
	}
	file.GenerationSpec = json.RawMessage(spec)
	return &file, sourceContent, nil
}

func (r *ErosFileRepository) MarkDelivered(ctx context.Context, accountID, userID, fileID uuid.UUID, sizeBytes int64, checksum string) error {
	_, err := r.db.Exec(ctx, `
		UPDATE eros_files
		SET delivered_at = NOW(),
		    size_bytes = CASE WHEN $4 > 0 THEN $4 ELSE size_bytes END,
		    checksum = COALESCE(NULLIF($5, ''), checksum),
		    updated_at = NOW()
		WHERE id = $1 AND account_id = $2 AND user_id = $3
	`, fileID, accountID, userID, sizeBytes, checksum)
	return err
}

type erosFileScanner interface {
	Scan(dest ...any) error
}

func scanErosFile(scanner erosFileScanner) (*domain.ErosFile, error) {
	var file domain.ErosFile
	var spec []byte
	err := scanner.Scan(
		&file.ID, &file.AccountID, &file.UserID, &file.ConversationID, &file.MessageID, &file.Filename,
		&file.Format, &file.ContentType, &file.Status, &file.SizeBytes, &file.Checksum, &spec,
		&file.ExpiresAt, &file.DeliveredAt, &file.CreatedAt, &file.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	file.GenerationSpec = json.RawMessage(spec)
	return &file, nil
}
