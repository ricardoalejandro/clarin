package repository

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// ChatIdentityReconcileResult describes a single account/device-scoped merge
// from a WhatsApp private LID chat into its canonical phone-number chat.
type ChatIdentityReconcileResult struct {
	CanonicalChatID    uuid.UUID
	CanonicalContactID *uuid.UUID
	SourceChatID       *uuid.UUID
	SourceContactID    *uuid.UUID
	MovedMessageCount  int
}

// MappedLIDContactPair is an account-scoped duplicate Contact identity proven
// by WhatsApp's durable LID-to-phone mapping table.
type MappedLIDContactPair struct {
	AccountID          uuid.UUID
	SourceContactID    uuid.UUID
	CanonicalContactID uuid.UUID
	LIDJID             string
	PhoneJID           string
}

func (r *ContactRepository) GetMappedLIDContactPairs(ctx context.Context) ([]MappedLIDContactPair, error) {
	rows, err := r.db.Query(ctx, `
		SELECT lid_contact.account_id,lid_contact.id,phone_contact.id,
		       lid_contact.jid,phone_contact.jid
		FROM contacts lid_contact
		JOIN whatsmeow_lid_map mapping
		  ON LOWER(lid_contact.jid)=LOWER(mapping.lid || '@lid')
		JOIN contacts phone_contact
		  ON phone_contact.account_id=lid_contact.account_id
		 AND LOWER(phone_contact.jid)=LOWER(mapping.pn || '@s.whatsapp.net')
		WHERE lid_contact.id<>phone_contact.id
		ORDER BY lid_contact.account_id,lid_contact.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pairs := make([]MappedLIDContactPair, 0)
	for rows.Next() {
		var pair MappedLIDContactPair
		if err := rows.Scan(
			&pair.AccountID,
			&pair.SourceContactID,
			&pair.CanonicalContactID,
			&pair.LIDJID,
			&pair.PhoneJID,
		); err != nil {
			return nil, err
		}
		pairs = append(pairs, pair)
	}
	return pairs, rows.Err()
}

func validateChatIdentityPair(lidJID, phoneJID string) error {
	lidJID = strings.ToLower(strings.TrimSpace(lidJID))
	phoneJID = strings.ToLower(strings.TrimSpace(phoneJID))
	if !strings.HasSuffix(lidJID, "@lid") {
		return fmt.Errorf("source identity must be a WhatsApp LID")
	}
	if !strings.HasSuffix(phoneJID, "@s.whatsapp.net") {
		return fmt.Errorf("canonical identity must be a WhatsApp phone JID")
	}
	if lidJID == phoneJID {
		return fmt.Errorf("source and canonical identities must differ")
	}
	return nil
}

func (r *ChatRepository) GetPendingIdentitiesByDevice(ctx context.Context, accountID, deviceID uuid.UUID) ([]*domain.Chat, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id,account_id,device_id,contact_id,jid,name,last_message,last_message_at,
		       unread_count,is_archived,is_pinned,created_at,updated_at
		FROM chats
		WHERE account_id=$1 AND device_id=$2 AND channel_key='whatsapp_web' AND jid LIKE '%@lid'
		ORDER BY last_message_at DESC NULLS LAST,id
	`, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	chats := make([]*domain.Chat, 0)
	for rows.Next() {
		chat := &domain.Chat{IdentityPending: true}
		if err := rows.Scan(
			&chat.ID, &chat.AccountID, &chat.DeviceID, &chat.ContactID, &chat.JID, &chat.Name,
			&chat.LastMessage, &chat.LastMessageAt, &chat.UnreadCount, &chat.IsArchived,
			&chat.IsPinned, &chat.CreatedAt, &chat.UpdatedAt,
		); err != nil {
			return nil, err
		}
		chats = append(chats, chat)
	}
	return chats, rows.Err()
}

// ReconcileLIDChat moves a previously unresolved LID chat into an already
// created canonical phone-number chat. The transaction is deliberately scoped
// by account, device and WhatsApp Web channel so an identity learned by one
// session cannot join data owned by another session or provider.
func (r *ChatRepository) ReconcileLIDChat(
	ctx context.Context,
	accountID, deviceID, canonicalChatID uuid.UUID,
	lidJID, phoneJID string,
) (*ChatIdentityReconcileResult, error) {
	if err := validateChatIdentityPair(lidJID, phoneJID); err != nil {
		return nil, err
	}
	lidJID = strings.TrimSpace(lidJID)
	phoneJID = strings.TrimSpace(phoneJID)

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	result := &ChatIdentityReconcileResult{CanonicalChatID: canonicalChatID}
	var canonicalJID string
	if err := tx.QueryRow(ctx, `
		SELECT jid, contact_id
		FROM chats
		WHERE id=$1 AND account_id=$2 AND device_id=$3 AND channel_key='whatsapp_web'
		FOR UPDATE
	`, canonicalChatID, accountID, deviceID).Scan(&canonicalJID, &result.CanonicalContactID); err != nil {
		return nil, err
	}
	if !strings.EqualFold(strings.TrimSpace(canonicalJID), phoneJID) {
		return nil, fmt.Errorf("canonical chat identity mismatch")
	}

	var sourceChatID uuid.UUID
	err = tx.QueryRow(ctx, `
		SELECT id, contact_id
		FROM chats
		WHERE account_id=$1 AND device_id=$2 AND channel_key='whatsapp_web' AND LOWER(jid)=LOWER($3)
		FOR UPDATE
	`, accountID, deviceID, lidJID).Scan(&sourceChatID, &result.SourceContactID)
	if err == pgx.ErrNoRows {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return result, nil
	}
	if err != nil {
		return nil, err
	}
	if sourceChatID == canonicalChatID {
		return nil, fmt.Errorf("source and canonical chats must differ")
	}
	result.SourceChatID = &sourceChatID

	// Older Clarin versions copied the numeric LID user into phone fields. It
	// is not a callable number, so remove that projection before Contact merge
	// and make any retained WhatsApp opportunity reference the canonical peer.
	if result.SourceContactID != nil {
		if _, err := tx.Exec(ctx, `
			UPDATE contacts
			SET phone=NULL,updated_at=NOW()
			WHERE id=$1 AND account_id=$2
			  AND REGEXP_REPLACE(COALESCE(phone,''),'[^0-9]','','g')=SPLIT_PART($3::text,'@',1)
		`, *result.SourceContactID, accountID, lidJID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			UPDATE leads
			SET jid=$1::text,phone=SPLIT_PART($1::text,'@',1),updated_at=NOW()
			WHERE account_id=$2 AND contact_id=$3 AND LOWER(jid)=LOWER($4::text)
		`, phoneJID, accountID, *result.SourceContactID, lidJID); err != nil {
			return nil, err
		}
	}

	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE account_id=$1 AND chat_id=$2`, accountID, sourceChatID).Scan(&result.MovedMessageCount); err != nil {
		return nil, err
	}

	// Preserve chat classifications without duplicating a canonical tag.
	if _, err := tx.Exec(ctx, `
		INSERT INTO chat_tags (chat_id,tag_id)
		SELECT $1,tag_id FROM chat_tags WHERE chat_id=$2
		ON CONFLICT (chat_id,tag_id) DO NOTHING
	`, canonicalChatID, sourceChatID); err != nil {
		return nil, err
	}

	// Reactions are keyed by WhatsApp stanza rather than the local message UUID.
	// Keep the newest semantic value if both projections already contain it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO message_reactions (
			id,account_id,chat_id,target_message_id,sender_jid,sender_name,
			emoji,is_from_me,timestamp,created_at
		)
		SELECT id,account_id,$1,target_message_id,
			CASE WHEN LOWER(sender_jid)=LOWER($3::text) THEN $4::text ELSE sender_jid END,
			sender_name,emoji,is_from_me,timestamp,created_at
		FROM message_reactions
		WHERE account_id=$2 AND chat_id=$5
		ON CONFLICT (account_id,chat_id,target_message_id,sender_jid) DO UPDATE SET
			sender_name=COALESCE(EXCLUDED.sender_name,message_reactions.sender_name),
			emoji=EXCLUDED.emoji,
			is_from_me=EXCLUDED.is_from_me,
			timestamp=EXCLUDED.timestamp
		WHERE EXCLUDED.timestamp >= message_reactions.timestamp
	`, canonicalChatID, accountID, lidJID, phoneJID, sourceChatID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM message_reactions WHERE account_id=$1 AND chat_id=$2`, accountID, sourceChatID); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE bot_sessions SET chat_id=$1,updated_at=NOW()
		WHERE account_id=$2 AND chat_id=$3
	`, canonicalChatID, accountID, sourceChatID); err != nil {
		return nil, err
	}

	// A repeated provider event can exist in both chats. Retain the canonical
	// copy, then move every remaining message in one update.
	if _, err := tx.Exec(ctx, `
		DELETE FROM messages source
		USING messages canonical
		WHERE source.account_id=$1 AND source.chat_id=$2
		  AND canonical.account_id=$1 AND canonical.chat_id=$3
		  AND canonical.message_id=source.message_id
	`, accountID, sourceChatID, canonicalChatID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE messages
		SET chat_id=$1,
		    from_jid=CASE WHEN LOWER(COALESCE(from_jid,''))=LOWER($4::text) THEN $5::text ELSE from_jid END
		WHERE account_id=$2 AND chat_id=$3
	`, canonicalChatID, accountID, sourceChatID, lidJID, phoneJID); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, `
		UPDATE chats canonical SET
			name=COALESCE(NULLIF(canonical.name,''),source.name),
			last_message=CASE
				WHEN source.last_message_at IS NOT NULL AND (canonical.last_message_at IS NULL OR source.last_message_at>canonical.last_message_at)
				THEN source.last_message ELSE canonical.last_message END,
			last_message_at=CASE
				WHEN canonical.last_message_at IS NULL THEN source.last_message_at
				WHEN source.last_message_at IS NULL THEN canonical.last_message_at
				ELSE GREATEST(canonical.last_message_at,source.last_message_at) END,
			unread_count=canonical.unread_count+source.unread_count,
			is_archived=canonical.is_archived AND source.is_archived,
			is_pinned=canonical.is_pinned OR source.is_pinned,
			last_inbound_at=CASE
				WHEN canonical.last_inbound_at IS NULL THEN source.last_inbound_at
				WHEN source.last_inbound_at IS NULL THEN canonical.last_inbound_at
				ELSE GREATEST(canonical.last_inbound_at,source.last_inbound_at) END,
			last_outbound_at=CASE
				WHEN canonical.last_outbound_at IS NULL THEN source.last_outbound_at
				WHEN source.last_outbound_at IS NULL THEN canonical.last_outbound_at
				ELSE GREATEST(canonical.last_outbound_at,source.last_outbound_at) END,
			customer_service_window_expires_at=CASE
				WHEN canonical.customer_service_window_expires_at IS NULL THEN source.customer_service_window_expires_at
				WHEN source.customer_service_window_expires_at IS NULL THEN canonical.customer_service_window_expires_at
				ELSE GREATEST(canonical.customer_service_window_expires_at,source.customer_service_window_expires_at) END,
			last_message_provider=COALESCE(canonical.last_message_provider,source.last_message_provider),
			created_at=LEAST(canonical.created_at,source.created_at),updated_at=NOW()
		FROM chats source
		WHERE canonical.id=$1 AND canonical.account_id=$2 AND source.id=$3 AND source.account_id=$2
	`, canonicalChatID, accountID, sourceChatID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM chats WHERE id=$1 AND account_id=$2`, sourceChatID, accountID); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
