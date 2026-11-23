package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// Physical rows stay in their original chat. Only the authorized conversation
// projection spans retired aliases; immutable forwarding fingerprints stay intact.
func (r *MessageRepository) conversationScope(ctx context.Context, accountID, chatID uuid.UUID) (uuid.UUID, []uuid.UUID, error) {
	repo := &ChatRepository{db: r.db}
	canonical, err := repo.ResolveCanonicalChatID(ctx, accountID, chatID)
	if err != nil {
		return uuid.Nil, nil, err
	}
	ids, err := repo.ConversationChatIDs(ctx, accountID, canonical)
	return canonical, ids, err
}

func (r *MessageRepository) conversationScopeByID(ctx context.Context, chatID uuid.UUID) (uuid.UUID, uuid.UUID, []uuid.UUID, error) {
	var account uuid.UUID
	if err := r.db.QueryRow(ctx, `SELECT account_id FROM chats WHERE id=$1`, chatID).Scan(&account); err != nil {
		return uuid.Nil, uuid.Nil, nil, err
	}
	canonical, ids, err := r.conversationScope(ctx, account, chatID)
	return account, canonical, ids, err
}

// MessageDeviceAllowed never rewrites the source row. A retired source is usable
// only through its proven same-owner group binding and the exact current device.
func (r *MessageRepository) MessageDeviceAllowed(ctx context.Context, accountID, chatID, deviceID uuid.UUID, message *domain.Message) (bool, error) {
	if message == nil || message.AccountID != accountID {
		return false, nil
	}
	var allowed bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM chats requested
 JOIN chats current ON current.account_id=requested.account_id AND current.id=COALESCE(requested.canonical_chat_id,requested.id)
 JOIN messages physical ON physical.account_id=current.account_id AND physical.id=$4
 JOIN chats source ON source.account_id=current.account_id AND source.id=physical.chat_id
 JOIN devices d ON d.account_id=current.account_id AND d.id=current.device_id
 WHERE requested.account_id=$1 AND requested.id=$2 AND current.device_id=$3
 AND d.status='connected' AND d.delete_operation_id IS NULL
 AND COALESCE(NULLIF(d.provider,''),'whatsapp_web')='whatsapp_web'
 AND COALESCE(source.canonical_chat_id,source.id)=current.id
 AND ((current.jid NOT LIKE '%@g.us' AND physical.device_id=$3) OR
 (current.jid LIKE '%@g.us' AND (
 (current.whatsapp_owner_id IS NULL AND source.id=current.id AND physical.device_id=$3) OR
 (current.binding_state='verified_continuity' AND current.whatsapp_owner_id IS NOT NULL AND source.whatsapp_owner_id=current.whatsapp_owner_id)))))`, accountID, chatID, deviceID, message.ID).Scan(&allowed)
	return allowed, err
}

// projectConversationMessages changes only the response identity. Source fields
// used by immutable operations are always loaded through GetByReference instead.
func projectConversationMessages(messages []*domain.Message, canonical uuid.UUID) {
	for _, message := range messages {
		if message != nil {
			message.ChatID = canonical
			if message.IsRevoked {
				message.Body = nil
				message.MediaURL = nil
				message.LinkPreview = nil
				message.LinkPreviewMediaAssetID = nil
			}
		}
	}
}

// A display/reference action resolves a retired message UUID to its visible
// representative. Immutable sharing operations deliberately use GetByReference.
func (r *MessageRepository) GetVisibleByReference(ctx context.Context, accountID, chatID uuid.UUID, reference string) (*domain.Message, error) {
	message, err := r.GetByReference(ctx, accountID, chatID, reference)
	if err != nil {
		return nil, err
	}
	var id uuid.UUID
	if err = r.db.QueryRow(ctx, `SELECT COALESCE((SELECT canonical_message_id FROM whatsapp_message_aliases WHERE account_id=$1 AND alias_message_id=$2),$2::uuid)`, accountID, message.ID).Scan(&id); err != nil {
		return nil, err
	}
	if id != message.ID {
		message, err = r.GetByReference(ctx, accountID, chatID, id.String())
		if err != nil {
			return nil, err
		}
	}
	canonical, err := (&ChatRepository{db: r.db}).ResolveCanonicalChatID(ctx, accountID, chatID)
	if err != nil {
		return nil, err
	}
	if err = r.hydrateConversationMediaRemoval(ctx, accountID, []*domain.Message{message}); err != nil {
		return nil, err
	}
	projectConversationMessages([]*domain.Message{message}, canonical)
	return message, nil
}

// The caller has already authorized one logical conversation. A provider ID
// alone does not join different authors whose messages remained distinct.
const logicalMessageIDsSQL = `WITH target AS (
 SELECT COALESCE(a.canonical_message_id,m.id) keeper FROM messages m
 LEFT JOIN whatsapp_message_aliases a ON a.account_id=m.account_id AND a.alias_message_id=m.id
 WHERE m.account_id=$1 AND m.chat_id IN(SELECT id FROM chats WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2)) AND m.message_id=$3
 ORDER BY (m.chat_id=$2) DESC,m.id LIMIT 1)
 SELECT keeper FROM target UNION SELECT a.alias_message_id FROM whatsapp_message_aliases a JOIN target t ON t.keeper=a.canonical_message_id WHERE a.account_id=$1`

var ErrMessageIdentityAmbiguous = errors.New("message identity is ambiguous")

const logicalMessageReferenceCountSQL = `SELECT COUNT(DISTINCT COALESCE(a.canonical_message_id,m.id)) FROM messages m
 LEFT JOIN whatsapp_message_aliases a ON a.account_id=m.account_id AND a.alias_message_id=m.id
 WHERE m.account_id=$1 AND m.chat_id IN(SELECT id FROM chats WHERE account_id=$1 AND (id=$2 OR canonical_chat_id=$2)) AND m.message_id=$3`

func requireLogicalMessageReferenceTx(ctx context.Context, tx pgx.Tx, accountID, chatID uuid.UUID, reference string) error {
	var count int
	if err := tx.QueryRow(ctx, logicalMessageReferenceCountSQL, accountID, chatID, reference).Scan(&count); err != nil {
		return err
	}
	if count > 1 {
		return ErrMessageIdentityAmbiguous
	}
	return nil
}

// This check reads the visible keeper's removal/restriction truth without
// changing the immutable raw source used by an operation fingerprint.
func (r *MessageRepository) SharingSourceAvailable(ctx context.Context, accountID, chatID uuid.UUID, source *domain.Message) (bool, error) {
	if source == nil || source.AccountID != accountID {
		return false, nil
	}
	visible, err := r.GetVisibleByReference(ctx, accountID, chatID, source.ID.String())
	if err != nil {
		return false, err
	}
	return !visible.IsRevoked && !visible.IsViewOnce && !visible.MediaDeleted, nil
}

// Storage tombstones retain their original UUID/snapshot. Derive their effect
// for the logical message instead of copying flags that Restore cannot undo.
func (r *MessageRepository) hydrateConversationMediaRemoval(ctx context.Context, accountID uuid.UUID, messages []*domain.Message) error {
	byID := map[uuid.UUID][]*domain.Message{}
	ids := []uuid.UUID{}
	for _, m := range messages {
		if m != nil && m.AccountID == accountID {
			byID[m.ID] = append(byID[m.ID], m)
			ids = append(ids, m.ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := r.db.Query(ctx, `SELECT m.id FROM messages m WHERE m.account_id=$1 AND m.id=ANY($2::uuid[]) AND
 (COALESCE(m.media_deleted,FALSE) OR EXISTS(SELECT 1 FROM whatsapp_message_aliases a JOIN messages original ON original.account_id=a.account_id AND original.id=a.alias_message_id WHERE a.account_id=m.account_id AND a.canonical_message_id=m.id AND COALESCE(original.media_deleted,FALSE)))`, accountID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		if err = rows.Scan(&id); err != nil {
			return err
		}
		for _, m := range byID[id] {
			m.MediaDeleted = true
			m.MediaURL = nil
		}
	}
	return rows.Err()
}
