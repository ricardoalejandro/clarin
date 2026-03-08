package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ErosConversationRepository struct {
	db *pgxpool.Pool
}

// ListByUser returns conversations for a user, most recent first, limited to 50.
func (r *ErosConversationRepository) ListByUser(ctx context.Context, accountID, userID uuid.UUID) ([]domain.ErosConversation, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, user_id, title, created_at, updated_at
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
		if err := rows.Scan(&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		convs = append(convs, c)
	}
	return convs, nil
}

// GetWithMessages returns a conversation with its messages.
func (r *ErosConversationRepository) GetWithMessages(ctx context.Context, accountID, convID uuid.UUID) (*domain.ErosConversation, error) {
	var c domain.ErosConversation
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, user_id, title, created_at, updated_at
		FROM eros_conversations
		WHERE id = $1 AND account_id = $2
	`, convID, accountID).Scan(&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}

	msgRows, err := r.db.Query(ctx, `
		SELECT id, conversation_id, role, content, created_at
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
		if err := msgRows.Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.CreatedAt); err != nil {
			return nil, err
		}
		c.Messages = append(c.Messages, m)
	}
	return &c, nil
}

// Create creates a new conversation.
func (r *ErosConversationRepository) Create(ctx context.Context, accountID, userID uuid.UUID, title string) (*domain.ErosConversation, error) {
	var c domain.ErosConversation
	err := r.db.QueryRow(ctx, `
		INSERT INTO eros_conversations (account_id, user_id, title)
		VALUES ($1, $2, $3)
		RETURNING id, account_id, user_id, title, created_at, updated_at
	`, accountID, userID, title).Scan(&c.ID, &c.AccountID, &c.UserID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

// AddMessage adds a message to a conversation and updates its updated_at.
func (r *ErosConversationRepository) AddMessage(ctx context.Context, convID uuid.UUID, role, content string) (*domain.ErosMessage, error) {
	var m domain.ErosMessage
	err := r.db.QueryRow(ctx, `
		INSERT INTO eros_messages (conversation_id, role, content)
		VALUES ($1, $2, $3)
		RETURNING id, conversation_id, role, content, created_at
	`, convID, role, content).Scan(&m.ID, &m.ConversationID, &m.Role, &m.Content, &m.CreatedAt)
	if err != nil {
		return nil, err
	}

	// Touch conversation updated_at
	_, _ = r.db.Exec(ctx, `UPDATE eros_conversations SET updated_at = $1 WHERE id = $2`, time.Now(), convID)

	return &m, nil
}

// Delete removes a conversation (cascade deletes messages).
func (r *ErosConversationRepository) Delete(ctx context.Context, accountID, convID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM eros_conversations WHERE id = $1 AND account_id = $2`, convID, accountID)
	return err
}

// UpdateTitle updates a conversation title.
func (r *ErosConversationRepository) UpdateTitle(ctx context.Context, convID uuid.UUID, title string) error {
	_, err := r.db.Exec(ctx, `UPDATE eros_conversations SET title = $1, updated_at = NOW() WHERE id = $2`, title, convID)
	return err
}
