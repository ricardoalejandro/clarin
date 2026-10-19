package repository

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func (r *ChatRepository) SetUserPin(ctx context.Context, accountID, userID, chatID uuid.UUID, pinned bool) (*domain.ChatPin, error) {
	item := &domain.ChatPin{ChatID: chatID}
	err := r.db.QueryRow(ctx, `WITH target AS (SELECT account_id,id FROM chats WHERE account_id=$1::uuid AND id=$3::uuid FOR UPDATE)
	 INSERT INTO chat_user_preferences(account_id,user_id,chat_id,is_pinned,pinned_at)
	 SELECT account_id,$2::uuid,id,$4::boolean,CASE WHEN $4::boolean THEN clock_timestamp() ELSE NULL END
	 FROM target WHERE TRUE
	 ON CONFLICT(account_id,user_id,chat_id) DO UPDATE SET
	 is_pinned=EXCLUDED.is_pinned,
	 pinned_at=CASE WHEN EXCLUDED.is_pinned=chat_user_preferences.is_pinned THEN chat_user_preferences.pinned_at ELSE EXCLUDED.pinned_at END,
	 version=chat_user_preferences.version+CASE WHEN EXCLUDED.is_pinned=chat_user_preferences.is_pinned THEN 0 ELSE 1 END
	 RETURNING is_pinned,pinned_at,version`, accountID, userID, chatID, pinned).Scan(&item.IsPinned, &item.PinnedAt, &item.PinVersion)
	return item, err
}

// Identity resolution coalesces two views of one direct conversation. Keep
// every actor's preference before the source chat's cascading deletion. The
// caller locks both chats; SetUserPin takes the same parent lock.
func mergeChatUserPreferencesTx(ctx context.Context, tx pgx.Tx, accountID, sourceID, canonicalID uuid.UUID) error {
	_, err := tx.Exec(ctx, `INSERT INTO chat_user_preferences(account_id,user_id,chat_id,is_pinned,pinned_at,version)
	 SELECT account_id,user_id,$3::uuid,is_pinned,pinned_at,version+1 FROM chat_user_preferences
	 WHERE account_id=$1::uuid AND chat_id=$2::uuid
	 ON CONFLICT(account_id,user_id,chat_id) DO UPDATE SET
	 is_pinned=chat_user_preferences.is_pinned OR EXCLUDED.is_pinned,
	 pinned_at=GREATEST(chat_user_preferences.pinned_at,EXCLUDED.pinned_at),
	 version=GREATEST(chat_user_preferences.version,EXCLUDED.version)+1`, accountID, sourceID, canonicalID)
	return err
}

func (r *ChatRepository) ApplyUserPins(ctx context.Context, accountID, userID uuid.UUID, chats []*domain.Chat) error {
	if len(chats) == 0 {
		return nil
	}
	byID := make(map[uuid.UUID]*domain.Chat, len(chats))
	ids := make([]uuid.UUID, 0, len(chats))
	for _, chat := range chats {
		if chat != nil && chat.AccountID == accountID {
			chat.IsPinned = false
			chat.PinnedAt = nil
			chat.PinVersion = 0
			byID[chat.ID] = chat
			ids = append(ids, chat.ID)
		}
	}
	rows, err := r.db.Query(ctx, `SELECT chat_id,is_pinned,pinned_at,version FROM chat_user_preferences WHERE account_id=$1 AND user_id=$2 AND chat_id=ANY($3::uuid[])`, accountID, userID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var pin domain.ChatPin
		if err := rows.Scan(&pin.ChatID, &pin.IsPinned, &pin.PinnedAt, &pin.PinVersion); err != nil {
			return err
		}
		if chat := byID[pin.ChatID]; chat != nil {
			chat.IsPinned = pin.IsPinned
			chat.PinnedAt = pin.PinnedAt
			chat.PinVersion = pin.PinVersion
		}
	}
	return rows.Err()
}

const chatPinOrderSQL = `COALESCE(cp.is_pinned,FALSE) DESC, CASE WHEN cp.is_pinned THEN cp.pinned_at ELSE c.last_message_at END DESC NULLS LAST,c.id`

// Cursor comparisons use the same expressions as ORDER BY. Pinned rows never
// move with message activity; null activity is explicitly the final partition.
func chatListCursorSQL(cursor *domain.ChatListCursor, arg int) (string, []any) {
	if cursor == nil {
		return "", nil
	}
	sortExpr := `CASE WHEN cp.is_pinned THEN cp.pinned_at ELSE c.last_message_at END`
	if cursor.SortAt == nil {
		return fmt.Sprintf(` AND (COALESCE(cp.is_pinned,FALSE)<$%d::boolean OR (COALESCE(cp.is_pinned,FALSE)=$%d::boolean AND (%s) IS NULL AND c.id>$%d::uuid))`, arg, arg, sortExpr, arg+1), []any{cursor.Pinned, cursor.ID}
	}
	return fmt.Sprintf(` AND (COALESCE(cp.is_pinned,FALSE)<$%d::boolean OR (COALESCE(cp.is_pinned,FALSE)=$%d::boolean AND ((%s)<$%d::timestamptz OR (%s) IS NULL OR ((%s)=$%d::timestamptz AND c.id>$%d::uuid))))`, arg, arg, sortExpr, arg+1, sortExpr, sortExpr, arg+1, arg+2), []any{cursor.Pinned, *cursor.SortAt, cursor.ID}
}
