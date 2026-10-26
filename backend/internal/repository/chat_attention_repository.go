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
	err := r.db.QueryRow(ctx, `WITH root AS(SELECT COALESCE(canonical_chat_id,id) id FROM chats WHERE account_id=$1 AND id=$2),scope AS(SELECT c.id,c.unread_count,c.waiting_since,c.state_version FROM chats c,root WHERE c.account_id=$1 AND (c.id=root.id OR c.canonical_chat_id=root.id))
 SELECT root.id,CASE WHEN (SELECT COUNT(*) FROM scope)>1 THEN (SELECT COUNT(*)::int FROM messages m WHERE m.account_id=$1 AND m.chat_id IN(SELECT id FROM scope) AND NOT m.is_from_me AND NOT m.is_read AND NOT COALESCE(m.is_revoked,FALSE) AND NOT EXISTS(SELECT 1 FROM whatsapp_message_aliases a WHERE a.account_id=m.account_id AND a.alias_message_id=m.id)) ELSE c.unread_count END,
 (SELECT MIN(waiting_since) FROM scope),(SELECT MIN(waiting_since) FROM scope) IS NOT NULL,(SELECT SUM(state_version)::bigint FROM scope),incoming.id,incoming.timestamp
 FROM root JOIN chats c ON c.account_id=$1 AND c.id=root.id LEFT JOIN LATERAL(
 SELECT m.id,m.timestamp FROM messages m WHERE m.account_id=$1 AND m.chat_id IN(SELECT id FROM scope) AND NOT m.is_from_me AND NOT COALESCE(m.is_revoked,FALSE)
 AND NOT EXISTS(SELECT 1 FROM whatsapp_message_aliases a WHERE a.account_id=m.account_id AND a.alias_message_id=m.id)
 ORDER BY m.timestamp DESC,m.id DESC LIMIT 1) incoming ON TRUE`, accountID, chatID).Scan(&state.ChatID,
		&state.UnreadCount, &state.WaitingSince, &state.NeedsReply, &state.Version, &state.LastIncomingMessageID, &state.LastIncomingAt)
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
	err := db.QueryRow(ctx, `WITH root AS(SELECT COALESCE(canonical_chat_id,id) id FROM chats WHERE account_id=$1 AND id=$2)
 SELECT visible.timestamp,visible.id FROM messages source
 JOIN chats physical ON physical.account_id=source.account_id AND physical.id=source.chat_id
 LEFT JOIN whatsapp_message_aliases a ON a.account_id=source.account_id AND a.alias_message_id=source.id
 JOIN messages visible ON visible.account_id=source.account_id AND visible.id=COALESCE(a.canonical_message_id,source.id),root
 WHERE source.account_id=$1 AND COALESCE(physical.canonical_chat_id,physical.id)=root.id AND NOT source.is_from_me
 AND ($3::text<>'' OR NOT COALESCE(visible.is_revoked,FALSE)) AND ($3::text='' OR source.id::text=$3 OR source.message_id=$3)
 ORDER BY (source.id::text=$3) DESC,visible.timestamp DESC,visible.id DESC LIMIT 1`, accountID, chatID, messageID).Scan(&at, &id)
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
	_, ids, err := lockConversationChatsTx(ctx, tx, accountID, chatID)
	if err != nil {
		return err
	}
	at, id, err := incomingBoundary(ctx, tx, accountID, chatID, messageID)
	if err != nil {
		return err
	}
	for _, physicalID := range ids {
		if err = acknowledgeAttentionTx(ctx, tx, accountID, physicalID, at, id); err != nil {
			return err
		}
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
