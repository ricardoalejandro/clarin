package repository

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Lock the physical tree in stable ID order. Message creation locks its owning
// Chat too; no message can slip between the displayed watermark and recount.
func lockConversationChatsTx(ctx context.Context, tx pgx.Tx, accountID, requested uuid.UUID) (uuid.UUID, []uuid.UUID, error) {
	var canonical uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT COALESCE(canonical_chat_id,id) FROM chats WHERE account_id=$1 AND id=$2`, accountID, requested).Scan(&canonical); err != nil {
		return uuid.Nil, nil, err
	}
	if err := LockMessageConversationTx(ctx, tx, accountID, canonical); err != nil {
		return uuid.Nil, nil, err
	}
	rows, err := tx.Query(ctx, `SELECT id FROM chats WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2) ORDER BY id FOR UPDATE`, accountID, canonical)
	if err != nil {
		return uuid.Nil, nil, err
	}
	ids := []uuid.UUID{}
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return uuid.Nil, nil, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return uuid.Nil, nil, err
	}
	if len(ids) == 0 {
		return uuid.Nil, nil, pgx.ErrNoRows
	}
	var current uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT COALESCE(canonical_chat_id,id) FROM chats WHERE account_id=$1 AND id=$2`, accountID, requested).Scan(&current); err != nil {
		return uuid.Nil, nil, err
	}
	if current != canonical {
		return uuid.Nil, nil, ErrChatBindingChanged
	}
	var retired bool
	if err = tx.QueryRow(ctx, `SELECT canonical_chat_id IS NOT NULL FROM chats WHERE account_id=$1 AND id=$2`, accountID, canonical).Scan(&retired); err != nil {
		return uuid.Nil, nil, err
	}
	if retired {
		return uuid.Nil, nil, ErrChatBindingChanged
	}
	return canonical, ids, nil
}

func (r *ChatRepository) markConversationAsRead(ctx context.Context, accountID, chatID uuid.UUID, through string) (int, string, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, "", err
	}
	defer tx.Rollback(ctx)
	_, ids, err := lockConversationChatsTx(ctx, tx, accountID, chatID)
	if err != nil {
		return 0, "", err
	}
	var at time.Time
	var id uuid.UUID
	var providerID string
	query := `SELECT visible.id,visible.timestamp,visible.message_id FROM messages source
 LEFT JOIN whatsapp_message_aliases a ON a.account_id=source.account_id AND a.alias_message_id=source.id
 JOIN messages visible ON visible.account_id=source.account_id AND visible.id=COALESCE(a.canonical_message_id,source.id)
 WHERE source.account_id=$1 AND source.chat_id=ANY($2::uuid[])`
	args := []any{accountID, ids}
	if strings.TrimSpace(through) != "" {
		query += ` AND (source.id::text=$3 OR source.message_id=$3) ORDER BY (source.id::text=$3) DESC,visible.timestamp DESC,visible.id DESC LIMIT 1`
		args = append(args, strings.TrimSpace(through))
	} else {
		query += ` AND source.is_from_me=FALSE ORDER BY visible.timestamp DESC,visible.id DESC LIMIT 1`
	}
	err = tx.QueryRow(ctx, query, args...).Scan(&id, &at, &providerID)
	if err != nil && (strings.TrimSpace(through) != "" || !errors.Is(err, pgx.ErrNoRows)) {
		return 0, "", err
	}
	if err == nil {
		if _, err = tx.Exec(ctx, `UPDATE messages m SET is_read=TRUE,read_at=COALESCE(m.read_at,NOW())
 WHERE m.account_id=$1 AND m.chat_id=ANY($2::uuid[]) AND m.is_from_me=FALSE AND m.is_read=FALSE
 AND ((m.timestamp,m.id)<=($3::timestamptz,$4::uuid) OR EXISTS(
 SELECT 1 FROM whatsapp_message_aliases a JOIN messages original ON original.account_id=a.account_id AND original.id=a.canonical_message_id
 WHERE a.account_id=m.account_id AND a.alias_message_id=m.id AND (original.timestamp,original.id)<=($3::timestamptz,$4::uuid)))`, accountID, ids, at, id); err != nil {
			return 0, "", err
		}
	}
	// Physical counters remain per Chat. The projection counts logical messages.
	if _, err = tx.Exec(ctx, `UPDATE chats c SET unread_count=(SELECT COUNT(*) FROM messages m WHERE m.account_id=c.account_id AND m.chat_id=c.id AND m.is_from_me=FALSE AND m.is_read=FALSE AND COALESCE(m.is_revoked,FALSE)=FALSE),state_version=state_version+1,updated_at=NOW() WHERE c.account_id=$1 AND c.id=ANY($2::uuid[])`, accountID, ids); err != nil {
		return 0, "", err
	}
	var unread int
	if err = tx.QueryRow(ctx, `SELECT COUNT(*)::int FROM messages m WHERE m.account_id=$1 AND m.chat_id=ANY($2::uuid[]) AND m.is_from_me=FALSE AND m.is_read=FALSE AND COALESCE(m.is_revoked,FALSE)=FALSE AND NOT EXISTS(SELECT 1 FROM whatsapp_message_aliases a WHERE a.account_id=m.account_id AND a.alias_message_id=m.id)`, accountID, ids).Scan(&unread); err != nil {
		return 0, "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, "", err
	}
	return unread, providerID, nil
}

func (r *ChatRepository) HydrateConversationState(ctx context.Context, accountID uuid.UUID, chats []*domain.Chat) error {
	ids := []uuid.UUID{}
	byID := map[uuid.UUID]*domain.Chat{}
	for _, chat := range chats {
		if chat != nil && chat.AccountID == accountID {
			ids = append(ids, chat.ID)
			byID[chat.ID] = chat
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT c.id,COUNT(m.id) FILTER(WHERE NOT m.is_from_me AND NOT m.is_read AND NOT COALESCE(m.is_revoked,FALSE))::int,
 (SELECT SUM(state_version)::bigint FROM chats state WHERE state.account_id=c.account_id AND (state.id=c.id OR state.canonical_chat_id=c.id))
 FROM chats c JOIN chats physical ON physical.account_id=c.account_id AND (physical.id=c.id OR physical.canonical_chat_id=c.id)
 LEFT JOIN messages m ON m.account_id=physical.account_id AND m.chat_id=physical.id AND NOT EXISTS(SELECT 1 FROM whatsapp_message_aliases a WHERE a.account_id=m.account_id AND a.alias_message_id=m.id)
 WHERE c.account_id=$1 AND c.id=ANY($2::uuid[]) AND EXISTS(SELECT 1 FROM chats alias WHERE alias.account_id=c.account_id AND alias.canonical_chat_id=c.id)
 GROUP BY c.id`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var unread int
		var version int64
		if err = rows.Scan(&id, &unread, &version); err != nil {
			return err
		}
		if chat := byID[id]; chat != nil {
			chat.UnreadCount = unread
			chat.StateVersion = version
		}
	}
	return rows.Err()
}

var ErrChatContinuityDeleteRequiresReview = errors.New("chat_continuity_delete_requires_review")

// Do not broaden a user's physical deletion into an irreversible alias-tree
// purge. Linked histories require a separately authorized review first.
func requireUnlinkedChatDeletion(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, ids []uuid.UUID, all bool) error {
	var linked bool
	err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM chats c WHERE c.account_id=$1 AND ($3::bool OR c.id=ANY($2::uuid[]))
 AND ((c.canonical_chat_id IS NOT NULL AND c.canonical_chat_id<>c.id) OR EXISTS(SELECT 1 FROM chats alias WHERE alias.account_id=c.account_id AND alias.canonical_chat_id=c.id AND alias.id<>c.id)))`, accountID, ids, all).Scan(&linked)
	if err != nil {
		return err
	}
	if linked {
		return ErrChatContinuityDeleteRequiresReview
	}
	return nil
}
