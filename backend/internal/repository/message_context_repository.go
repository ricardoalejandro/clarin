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
	row := r.db.QueryRow(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size, media_asset_id,
		       is_from_me, is_read, status, delivered_at, read_at, COALESCE(is_edited,false), provider, template_name, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender, quoted_is_from_me,
		       COALESCE(is_revoked,false), COALESCE(is_view_once,false), COALESCE(media_deleted,false),
		       latitude, longitude, contact_name, contact_phone, contact_vcard
		FROM messages
		WHERE account_id=$1 AND chat_id=$2 AND (message_id=$3 OR id::text=$3)
		ORDER BY CASE WHEN message_id=$3 THEN 0 ELSE 1 END
		LIMIT 1
	`, accountID, chatID, reference)
	return scanContextMessage(row)
}

// GetWindowByChatID returns a chronological page while preserving the
// account boundary. Offset is measured from newest to oldest, as in the chat
// history endpoint.
func (r *MessageRepository) GetWindowByChatID(ctx context.Context, accountID, chatID uuid.UUID, limit, offset int) ([]*domain.Message, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, device_id, chat_id, message_id, from_jid, from_name, body,
		       message_type, media_url, media_mimetype, media_filename, media_size, media_asset_id,
		       is_from_me, is_read, status, delivered_at, read_at, COALESCE(is_edited,false), provider, template_name, timestamp, created_at,
		       quoted_message_id, quoted_body, quoted_sender, quoted_is_from_me,
		       COALESCE(is_revoked,false), COALESCE(is_view_once,false), COALESCE(media_deleted,false),
		       latitude, longitude, contact_name, contact_phone, contact_vcard
		FROM (
			SELECT * FROM messages WHERE account_id=$1 AND chat_id=$2
			ORDER BY timestamp DESC, id DESC LIMIT $3 OFFSET $4
		) page
		ORDER BY timestamp ASC, id ASC
	`, accountID, chatID, limit, offset)
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
		&message.ContactVCard,
	); err != nil {
		return nil, err
	}
	return message, nil
}

var _ messageScanner = pgx.Row(nil)
