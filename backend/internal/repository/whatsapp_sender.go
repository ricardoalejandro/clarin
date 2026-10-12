package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrWhatsAppSenderConfirmation = errors.New("whatsapp sender confirmation required")
var ErrWhatsAppSenderUnavailable = errors.New("whatsapp sender unavailable")

// WhatsAppSenderConfirmation records the exact channel and history shown to
// the actor. It is an acknowledgement, never an authorization credential.
type WhatsAppSenderConfirmation struct {
	DeviceID        uuid.UUID `json:"device_id"`
	DevicePhone     string    `json:"device_phone"`
	HistoryRevision string    `json:"history_revision"`
}

type WhatsAppSenderContext struct {
	HistoricalPhone string `json:"historical_phone"`
	Revision        string `json:"history_revision"`
}

func senderContext(ctx context.Context, q contactIdentityQuerier, accountID, chatID uuid.UUID) (WhatsAppSenderContext, error) {
	var deviceID, devicePhone, deviceJID, fromJID, messageID string
	err := q.QueryRow(ctx, `
		SELECT COALESCE(c.device_id::text,''),COALESCE(d.phone,''),COALESCE(d.jid,''),
		       COALESCE(m.from_jid,''),COALESCE(m.id::text,'')
		FROM chats c LEFT JOIN devices d ON d.id=c.device_id AND d.account_id=c.account_id
		LEFT JOIN LATERAL (
			SELECT id,from_jid FROM messages WHERE account_id=c.account_id AND chat_id=c.id
			AND is_from_me=TRUE AND COALESCE(from_jid,'')<>''
			ORDER BY timestamp DESC,created_at DESC,id DESC LIMIT 1
		) m ON TRUE WHERE c.account_id=$1 AND c.id=$2
	`, accountID, chatID).Scan(&deviceID, &devicePhone, &deviceJID, &fromJID, &messageID)
	if err != nil {
		return WhatsAppSenderContext{}, err
	}
	phone := senderPhone(firstNonEmptyPlain(fromJID, devicePhone, deviceJID))
	sum := sha256.Sum256([]byte(chatID.String() + "|" + deviceID + "|" + messageID + "|" + phone))
	return WhatsAppSenderContext{HistoricalPhone: phone, Revision: hex.EncodeToString(sum[:])}, nil
}

func senderPhone(value string) string {
	return normalizeAliasValue("phone", strings.Split(strings.Split(value, "@")[0], ":")[0])
}

func (r *ChatRepository) WhatsAppSenderContext(ctx context.Context, accountID, chatID uuid.UUID) (WhatsAppSenderContext, error) {
	return senderContext(ctx, r.db, accountID, chatID)
}

func requiresSenderConfirmation(hasHistory bool, historicalPhone, devicePhone string) bool {
	return hasHistory && (historicalPhone == "" || devicePhone == "" || historicalPhone != devicePhone)
}

func senderConfirmationMatches(confirmation *WhatsAppSenderConfirmation, deviceID uuid.UUID, devicePhone string, history WhatsAppSenderContext) bool {
	return confirmation != nil && confirmation.DeviceID == deviceID && confirmation.DevicePhone == devicePhone && confirmation.HistoryRevision == history.Revision
}

// OpenManualWhatsAppChat serializes the history check with the channel update.
// Ingestion continues using GetOrCreate; no confirmation is applied to received
// messages. Contact precedes Chat in the lock order, matching ingestion's CTE.
// The later locked chat read revalidates ownership and the confirmation snapshot.
func (r *ChatRepository) OpenManualWhatsAppChat(ctx context.Context, accountID, deviceID uuid.UUID, selectedContactID *uuid.UUID, jid, phone, name string, confirmation *WhatsAppSenderConfirmation) (*domain.Chat, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var devicePhone, deviceJID, provider, status string
	var deleting bool
	if err = tx.QueryRow(ctx, `SELECT COALESCE(phone,''),COALESCE(jid,''),COALESCE(NULLIF(provider,''),'whatsapp_web'),delete_operation_id IS NOT NULL,COALESCE(status,'') FROM devices WHERE id=$1 AND account_id=$2 FOR SHARE`, deviceID, accountID).Scan(&devicePhone, &deviceJID, &provider, &deleting, &status); err != nil {
		return nil, err
	}
	if deleting || provider != domain.DeviceProviderWhatsAppWeb {
		return nil, pgx.ErrNoRows
	}
	if status != domain.DeviceStatusConnected {
		return nil, ErrWhatsAppSenderUnavailable
	}
	selectedPhone := senderPhone(firstNonEmptyPlain(devicePhone, deviceJID))
	// Read the current parent without taking a Chat lock. All Contact writes
	// below are rolled back if the later canonical history/ownership check fails.
	var linkedContactID *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT contact_id FROM chats WHERE account_id=$1 AND channel_key='whatsapp_web' AND jid=$2`, accountID, jid).Scan(&linkedContactID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	contactID := selectedContactID
	if contactID == nil {
		contactID = linkedContactID
	}
	if contactID != nil {
		if linkedContactID != nil && *linkedContactID != *contactID {
			return nil, ErrChatContactConflict
		}
	} else {
		contactID, err = findContactAliasID(ctx, tx, accountID, jid, phone)
		if err != nil {
			return nil, err
		}
		if contactID == nil {
			var id uuid.UUID
			if err = tx.QueryRow(ctx, `INSERT INTO contacts(account_id,device_id,jid,phone,name,push_name,is_group) VALUES($1,$2,$3,$4,NULLIF($5,''),NULLIF($5,''),FALSE) ON CONFLICT(account_id,jid) DO UPDATE SET updated_at=contacts.updated_at RETURNING id`, accountID, deviceID, jid, phone, name).Scan(&id); err != nil {
				return nil, err
			}
			contactID = &id
		}
	}
	var lockedContactID uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM contacts WHERE id=$1 AND account_id=$2 AND is_group=FALSE FOR UPDATE`, *contactID, accountID).Scan(&lockedContactID); err != nil {
		return nil, err
	}
	conflict, err := contactIdentityConflictsWithOwner(ctx, tx, accountID, *contactID, jid, phone)
	if err != nil {
		return nil, err
	}
	if conflict {
		return nil, ErrContactIdentityConflict
	}
	for _, alias := range []struct{ kind, value string }{{"jid", jid}, {"phone", phone}} {
		normalized := normalizeAliasValue(alias.kind, alias.value)
		if normalized == "" {
			continue
		}
		if _, err = tx.Exec(ctx, `INSERT INTO contact_aliases(account_id,contact_id,alias_type,alias_value,normalized_value) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,alias_type,normalized_value) DO NOTHING`, accountID, *contactID, alias.kind, alias.value, normalized); err != nil {
			return nil, err
		}
		var owner uuid.UUID
		if err = tx.QueryRow(ctx, `SELECT contact_id FROM contact_aliases WHERE account_id=$1 AND alias_type=$2 AND normalized_value=$3`, accountID, alias.kind, normalized).Scan(&owner); err != nil {
			return nil, err
		}
		if owner != *contactID {
			return nil, ErrContactIdentityConflict
		}
	}
	if _, err = applyDurableSuppressionToContact(ctx, tx, accountID, *contactID); err != nil {
		return nil, err
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO chats(account_id,device_id,jid,name,channel_key) VALUES($1,$2,$3,NULLIF($4,''),'whatsapp_web') ON CONFLICT(account_id,channel_key,jid) DO NOTHING`, accountID, deviceID, jid, name)
	if err != nil {
		return nil, err
	}
	var chatID uuid.UUID
	var currentContactID *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id,contact_id FROM chats WHERE account_id=$1 AND channel_key='whatsapp_web' AND jid=$2 FOR UPDATE`, accountID, jid).Scan(&chatID, &currentContactID); err != nil {
		return nil, err
	}
	if currentContactID != nil && *currentContactID != *contactID {
		return nil, ErrChatContactConflict
	}
	if linkedContactID != nil && currentContactID == nil {
		return nil, ErrChatContactConflict
	}
	if inserted.RowsAffected() == 0 {
		history, historyErr := senderContext(ctx, tx, accountID, chatID)
		if historyErr != nil {
			return nil, historyErr
		}
		if requiresSenderConfirmation(true, history.HistoricalPhone, selectedPhone) && !senderConfirmationMatches(confirmation, deviceID, selectedPhone, history) {
			return nil, ErrWhatsAppSenderConfirmation
		}
		if confirmation != nil && !senderConfirmationMatches(confirmation, deviceID, selectedPhone, history) {
			return nil, ErrWhatsAppSenderConfirmation
		}
	}
	chat := &domain.Chat{}
	err = tx.QueryRow(ctx, `UPDATE chats SET device_id=$3,contact_id=$4,name=COALESCE(NULLIF($5,''),name),updated_at=NOW() WHERE account_id=$1 AND id=$2 RETURNING id,account_id,device_id,contact_id,jid,name,last_message,last_message_at,unread_count,is_archived,is_pinned,created_at,updated_at`, accountID, chatID, deviceID, *contactID, name).Scan(&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name, &chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived, &chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	setChatIdentityState(chat)
	return chat, nil
}
