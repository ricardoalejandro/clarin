package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func (r *ChatRepository) State(ctx context.Context, accountID, chatID uuid.UUID) (*domain.ChatState, error) {
	state := &domain.ChatState{ChatID: chatID}
	err := r.db.QueryRow(ctx, `SELECT unread_count,waiting_since,waiting_since IS NOT NULL,state_version
	 FROM chats WHERE account_id=$1 AND id=$2`, accountID, chatID).Scan(&state.UnreadCount, &state.WaitingSince, &state.NeedsReply, &state.Version)
	return state, err
}

func (r *ChatRepository) IncomingBoundary(ctx context.Context, accountID, chatID uuid.UUID, messageID string) (*time.Time, *uuid.UUID, error) {
	return incomingBoundary(ctx, r.db, accountID, chatID, messageID)
}

func incomingBoundary(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, accountID, chatID uuid.UUID, messageID string) (*time.Time, *uuid.UUID, error) {
	var at time.Time
	var id uuid.UUID
	err := db.QueryRow(ctx, `SELECT timestamp,id FROM messages WHERE account_id=$1 AND chat_id=$2 AND NOT is_from_me
	 AND ($3::text<>'' OR NOT COALESCE(is_revoked,FALSE)) AND ($3::text='' OR id::text=$3 OR message_id=$3)
	 ORDER BY timestamp DESC,id DESC LIMIT 1`, accountID, chatID, messageID).Scan(&at, &id)
	if err == pgx.ErrNoRows && messageID == "" {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return &at, &id, nil
}

func acknowledgeAttentionTx(ctx context.Context, tx pgx.Tx, accountID, chatID uuid.UUID, at *time.Time, id *uuid.UUID) error {
	if at == nil || id == nil {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE messages SET is_read=TRUE,read_at=COALESCE(read_at,NOW()) WHERE account_id=$1 AND chat_id=$2 AND NOT is_from_me AND NOT is_read AND (timestamp,id)<=($3::timestamptz,$4::uuid)`, accountID, chatID, at, id); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE chats SET unread_count=(SELECT COUNT(*) FROM messages WHERE account_id=$1 AND chat_id=$2 AND NOT is_from_me AND NOT is_read AND NOT COALESCE(is_revoked,FALSE)), attention_through_at=$3::timestamptz,attention_through_id=$4::uuid,
	 waiting_since=(SELECT MIN(timestamp) FROM messages WHERE account_id=$1 AND chat_id=$2 AND NOT is_from_me
	 AND NOT COALESCE(is_revoked,FALSE) AND COALESCE(sender->>'origin','')<>'history' AND (timestamp,id)>($3::timestamptz,$4::uuid)),
	 state_version=state_version+1,updated_at=NOW()
	 WHERE account_id=$1 AND id=$2 AND (attention_through_at IS NULL OR (attention_through_at,attention_through_id)<($3::timestamptz,$4::uuid))`, accountID, chatID, at, id)
	return err
}

func (r *ChatRepository) AcknowledgeAttention(ctx context.Context, accountID, chatID uuid.UUID, messageID string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var locked uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, chatID).Scan(&locked); err != nil {
		return err
	}
	at, id, err := incomingBoundary(ctx, tx, accountID, chatID, messageID)
	if err != nil {
		return err
	}
	if err = acknowledgeAttentionTx(ctx, tx, accountID, chatID, at, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func applyMessageSendContext(ctx context.Context, msg *domain.Message) {
	if !msg.IsFromMe {
		return
	}
	if send, ok := domain.MessageSendContextFrom(ctx); ok && send.AccountID == msg.AccountID {
		msg.Sender = &send.Sender
		if send.ChatID == msg.ChatID {
			msg.AttentionThroughAt = send.ThroughAt
			msg.AttentionThroughID = send.ThroughID
		}
		msg.DeferAttention = send.DeferAttention
		msg.SendOperationID = send.OperationID
	} else if msg.Sender == nil {
		msg.Sender = &domain.MessageSender{Origin: "automation"}
	}
}
