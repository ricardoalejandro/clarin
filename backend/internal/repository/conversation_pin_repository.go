package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"time"
)

// An explicit canonical preference, including false, wins. Only a missing
// canonical row can inherit an old alias preference; no OR resurrects unpin.
const effectiveChatUserPreferenceJoinSQL = `LEFT JOIN LATERAL (
 SELECT preference.is_pinned,preference.pinned_at,preference.version
 FROM chat_user_preferences preference JOIN chats preference_chat ON preference_chat.account_id=preference.account_id AND preference_chat.id=preference.chat_id
 WHERE preference.account_id=c.account_id AND preference.user_id=$2::uuid
 AND COALESCE(preference_chat.canonical_chat_id,preference_chat.id)=COALESCE(c.canonical_chat_id,c.id)
 ORDER BY (preference.chat_id=COALESCE(c.canonical_chat_id,c.id)) DESC,preference.version DESC,preference.pinned_at DESC NULLS LAST,preference.chat_id LIMIT 1
 ) cp ON TRUE`

func (r *ChatRepository) setConversationUserPin(ctx context.Context, accountID, userID, chatID uuid.UUID, pinned bool) (*domain.ChatPin, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	canonical, _, err := lockConversationChatsTx(ctx, tx, accountID, chatID)
	if err != nil {
		return nil, err
	}
	var old bool
	var oldAt *time.Time
	var version int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(cp.is_pinned,FALSE),cp.pinned_at,COALESCE(cp.version,0) FROM chats c `+effectiveChatUserPreferenceJoinSQL+` WHERE c.account_id=$1 AND c.id=$3`, accountID, userID, canonical).Scan(&old, &oldAt, &version); err != nil {
		return nil, err
	}
	if old != pinned || version == 0 {
		version++
	}
	var at *time.Time
	if pinned {
		at = oldAt
		if !old || at == nil {
			now := time.Now().UTC()
			at = &now
		}
	}
	item := &domain.ChatPin{ChatID: canonical}
	if err = tx.QueryRow(ctx, `INSERT INTO chat_user_preferences(account_id,user_id,chat_id,is_pinned,pinned_at,version) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(account_id,user_id,chat_id) DO UPDATE SET is_pinned=EXCLUDED.is_pinned,pinned_at=EXCLUDED.pinned_at,version=EXCLUDED.version
 RETURNING is_pinned,pinned_at,version`, accountID, userID, canonical, pinned, at, version).Scan(&item.IsPinned, &item.PinnedAt, &item.PinVersion); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}
