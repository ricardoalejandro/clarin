package repository

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// ListStorageCleanupMessages reuses the canonical message scanner and bounds
// each page. A foreign account's message id in a malformed backup cannot leak.
func (r *MessageRepository) ListStorageCleanupMessages(ctx context.Context, accountID uuid.UUID, keys []string, after uuid.UUID) ([]*domain.Message, error) {
	rows, err := r.db.Query(ctx, `
 SELECT m.id,m.account_id,m.device_id,m.chat_id,m.message_id,m.from_jid,m.from_name,m.body,
 m.message_type,m.media_url,m.media_mimetype,m.media_filename,m.media_size,m.media_asset_id,
 m.is_from_me,m.is_read,m.status,m.delivered_at,m.read_at,COALESCE(m.is_edited,false),m.provider,m.template_name,m.timestamp,m.created_at,
 m.quoted_message_id,m.quoted_body,m.quoted_sender,m.quoted_is_from_me,
 COALESCE(m.is_revoked,false),COALESCE(m.is_view_once,false),COALESCE(m.media_deleted,false),
 m.latitude,m.longitude,m.contact_name,m.contact_phone,m.contact_vcard,m.sender
 FROM messages m WHERE m.account_id=$1 AND m.id>$3 AND EXISTS(
 SELECT 1 FROM storage_media_trash t CROSS JOIN LATERAL jsonb_array_elements(t.message_backups) b
 WHERE t.account_id=$1 AND t.object_key=ANY($2::text[]) AND b->>'id'=m.id::text AND b->>'chat_id'=m.chat_id::text)
 ORDER BY m.id LIMIT 200`, accountID, keys, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]*domain.Message, 0)
	for rows.Next() {
		message, err := scanContextMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, message)
	}
	return messages, rows.Err()
}
