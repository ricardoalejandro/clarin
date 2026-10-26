package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// GetByReference resolves either the local UUID or the WhatsApp message ID,
// always inside the selected account and chat.
func (r *MessageRepository) GetByReference(ctx context.Context, accountID, chatID uuid.UUID, reference string) (*domain.Message, error) {
	canonical, ids, err := r.conversationScope(ctx, accountID, chatID)
	if err != nil {
		return nil, err
	}
	if _, parseErr := uuid.Parse(reference); parseErr != nil {
		var count int
		if err = r.db.QueryRow(ctx, logicalMessageReferenceCountSQL, accountID, canonical, reference).Scan(&count); err != nil {
			return nil, err
		}
		if count > 1 {
			return nil, ErrMessageIdentityAmbiguous
		}
	}
	row := r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size, media_asset_id,
		       is_from_me, is_read, status, delivered_at, read_at, COALESCE(is_edited,false), provider, template_name, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender, quoted_is_from_me,
		       COALESCE(is_revoked,false), COALESCE(is_view_once,false), COALESCE(media_deleted,false),
		       latitude, longitude, contact_name, contact_phone, contact_vcard, sender,link_preview,link_preview_media_asset_id,link_preview_version,forwarding,audio_ptt,sharing_limits
		FROM messages
		WHERE account_id=$1 AND chat_id=ANY($2::uuid[]) AND (message_id=$3 OR id::text=$3)
		ORDER BY CASE WHEN id::text=$3 THEN 0 ELSE 1 END, CASE WHEN chat_id=$4 THEN 0 ELSE 1 END, id
		LIMIT 1
	`, accountID, ids, reference, canonical)
	return scanContextMessage(row)
}

// GetWindowByChatID returns a chronological page while preserving the
// account boundary. Offset is measured from newest to oldest, as in the chat
// history endpoint.
func (r *MessageRepository) GetWindowByChatID(ctx context.Context, accountID, chatID uuid.UUID, limit, offset int) ([]*domain.Message, error) {
	canonical, ids, err := r.conversationScope(ctx, accountID, chatID)
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size, media_asset_id,
		       is_from_me, is_read, status, delivered_at, read_at, COALESCE(is_edited,false), provider, template_name, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender, quoted_is_from_me,
		       COALESCE(is_revoked,false), COALESCE(is_view_once,false), COALESCE(media_deleted,false),
		       latitude, longitude, contact_name, contact_phone, contact_vcard, sender,link_preview,link_preview_media_asset_id,link_preview_version,forwarding,audio_ptt,sharing_limits
		FROM (
			SELECT * FROM messages WHERE account_id=$1 AND chat_id=ANY($2::uuid[]) AND NOT EXISTS(SELECT 1 FROM whatsapp_message_aliases aliases WHERE aliases.account_id=messages.account_id AND aliases.alias_message_id=messages.id)
			ORDER BY timestamp DESC, id DESC LIMIT $3 OFFSET $4
		) page
		ORDER BY timestamp ASC, id ASC
	`, accountID, ids, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]*domain.Message, 0, limit)
	for rows.Next() {
		message, scanErr := scanContextMessage(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		messages = append(messages, message)
	}
	if err = r.hydrateConversationMediaRemoval(ctx, accountID, messages); err != nil {
		return nil, err
	}
	projectConversationMessages(messages, canonical)
	return messages, rows.Err()
}

type messageScanner interface {
	Scan(dest ...any) error
}

func scanContextMessage(scanner messageScanner) (*domain.Message, error) {
	message := &domain.Message{}
	if err := scanner.Scan(
		&message.ID, &message.AccountID, &message.DeviceID, &message.ChatID, &message.MessageID,
		&message.FromJID, &message.FromName, &message.Body, &message.MessageType, &message.MediaURL,
		&message.MediaMimetype, &message.MediaFilename, &message.MediaSize, &message.MediaAssetID,
		&message.IsFromMe, &message.IsRead, &message.Status, &message.DeliveredAt, &message.ReadAt, &message.IsEdited,
		&message.Provider, &message.TemplateName,
		&message.Timestamp, &message.CreatedAt, &message.QuotedMessageID, &message.QuotedBody,
		&message.QuotedSender, &message.QuotedIsFromMe, &message.IsRevoked, &message.IsViewOnce, &message.MediaDeleted,
		&message.Latitude, &message.Longitude, &message.ContactName, &message.ContactPhone,
		&message.ContactVCard, &message.Sender, &message.LinkPreview, &message.LinkPreviewMediaAssetID, &message.LinkPreviewVersion, &message.Forwarding, &message.AudioPTT, &message.SharingLimits,
	); err != nil {
		return nil, err
	}
	return message, nil
}

var _ messageScanner = pgx.Row(nil)
