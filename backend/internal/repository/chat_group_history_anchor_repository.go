package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// GetGroupHistoryRecoveryAnchor selects a real newer message so WhatsApp can
// return an earlier empty transport placeholder in its normal history page.
// Without a proven newer anchor, callers keep the ordinary oldest-message path.
func (r *MessageRepository) GetGroupHistoryRecoveryAnchor(ctx context.Context, accountID, deviceID, chatID uuid.UUID) (*domain.Message, error) {
	message := &domain.Message{}
	err := r.db.QueryRow(ctx, `
 SELECT anchor.id,anchor.account_id,anchor.device_id,anchor.chat_id,anchor.message_id,
        anchor.from_jid,anchor.is_from_me,anchor.timestamp
 FROM messages anchor JOIN chats c ON c.account_id=anchor.account_id AND c.id=anchor.chat_id
 WHERE c.account_id=$1 AND c.device_id=$2 AND c.id=$3 AND c.jid LIKE '%@g.us'
 AND anchor.device_id=$2 AND anchor.provider='whatsapp_web' AND anchor.message_id<>''
 AND NOT COALESCE(anchor.is_revoked,FALSE)
 AND (COALESCE(anchor.body,'')<>'' OR COALESCE(anchor.message_type,'text')<>'text')
 AND EXISTS (
  SELECT 1 FROM messages gap
  WHERE gap.account_id=anchor.account_id AND gap.chat_id=anchor.chat_id AND gap.device_id=$2
  AND gap.provider='whatsapp_web' AND gap.message_id<>'' AND COALESCE(gap.from_jid,'')<>''
  AND gap.message_type='text' AND COALESCE(gap.body,'')=''
  AND COALESCE(gap.media_url,'')='' AND gap.media_asset_id IS NULL AND COALESCE(gap.media_filename,'')=''
  AND COALESCE(gap.media_mimetype,'')='' AND COALESCE(gap.media_size,0)=0
  AND NOT COALESCE(gap.media_deleted,FALSE) AND NOT COALESCE(gap.is_view_once,FALSE)
  AND NOT COALESCE(gap.is_edited,FALSE) AND NOT COALESCE(gap.is_revoked,FALSE)
  AND gap.media_unavailable_reason=''
  AND gap.latitude IS NULL AND gap.longitude IS NULL
  AND COALESCE(gap.contact_name,'')='' AND COALESCE(gap.contact_phone,'')='' AND COALESCE(gap.contact_vcard,'')=''
  AND COALESCE(gap.poll_question,'')='' AND COALESCE(gap.poll_max_selections,0)=0
  AND COALESCE(gap.quoted_message_id,'')='' AND COALESCE(gap.quoted_body,'')='' AND COALESCE(gap.quoted_sender,'')=''
  AND gap.group_mentions='[]'::jsonb
  AND NOT EXISTS (SELECT 1 FROM chat_group_message_state state
   WHERE state.account_id=gap.account_id AND state.chat_id=gap.chat_id AND state.message_id=gap.message_id
   AND (state.revoked OR state.edited_body IS NOT NULL OR state.edited_at IS NOT NULL))
  AND (gap.timestamp,gap.id)<(anchor.timestamp,anchor.id)
 )
 ORDER BY anchor.timestamp DESC,anchor.id DESC LIMIT 1`, accountID, deviceID, chatID).Scan(
		&message.ID, &message.AccountID, &message.DeviceID, &message.ChatID, &message.MessageID,
		&message.FromJID, &message.IsFromMe, &message.Timestamp,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return message, nil
}
