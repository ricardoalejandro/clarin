package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"go.mau.fi/whatsmeow/types"
)

// A provider envelope containing only key distribution is not a visible message.
// A later provider event may complete that same ID, but never another author's
// message or an edited/revoked/view-once message.
func groupPlaceholderCandidate(msg *domain.Message) (string, bool) {
	if msg == nil || msg.AccountID == uuid.Nil || msg.ChatID == uuid.Nil || msg.DeviceID == nil || *msg.DeviceID == uuid.Nil ||
		msg.MessageID == "" || msg.FromJID == nil || msg.MessageType == nil || msg.IsRevoked || msg.IsEdited || msg.IsViewOnce || msg.MediaDeleted {
		return "", false
	}
	if msg.Provider != nil && *msg.Provider != "" && *msg.Provider != "whatsapp_web" {
		return "", false
	}
	author, err := types.ParseJID(*msg.FromJID)
	if err != nil || author.User == "" || (author.Server != types.DefaultUserServer && author.Server != types.HiddenUserServer) {
		return "", false
	}
	visible := false
	switch *msg.MessageType {
	case domain.MessageTypeText:
		visible = msg.Body != nil && *msg.Body != ""
	case domain.MessageTypeImage, domain.MessageTypeVideo, domain.MessageTypeGIF, domain.MessageTypeAudio, domain.MessageTypeDocument, domain.MessageTypeSticker:
		// A provider attachment remains visible even if download failed or its
		// caption is empty. The caller already validated any media asset.
		visible = true
	case domain.MessageTypeLocation:
		visible = msg.Latitude != nil && msg.Longitude != nil
	case domain.MessageTypeContact:
		visible = nonemptyGroupPlaceholderField(msg.ContactName) || nonemptyGroupPlaceholderField(msg.ContactPhone) || nonemptyGroupPlaceholderField(msg.ContactVCard)
	case domain.MessageTypePoll:
		visible = nonemptyGroupPlaceholderField(msg.PollQuestion)
	}
	return author.ToNonAD().String(), visible
}

func nonemptyGroupPlaceholderField(value *string) bool {
	return value != nil && strings.TrimSpace(*value) != ""
}

// repairGroupPlaceholderTx is called only after Create's duplicate INSERT while
// the parent chat is locked. It completes content without replaying insertion,
// unread or attention effects. A true result must commit immediately, bypassing
// send-attribution and attention acknowledgement paths in Create.
func repairGroupPlaceholderTx(ctx context.Context, tx pgx.Tx, msg *domain.Message) (bool, error) {
	author, visible := groupPlaceholderCandidate(msg)
	if !visible {
		return false, nil
	}
	mentions := msg.Mentions
	if mentions == nil {
		mentions = []domain.MessageMention{}
	}
	canonical := &domain.Message{}
	var raw []byte
	err := tx.QueryRow(ctx, `UPDATE messages m SET
 body=$7,message_type=$8,media_url=$9,media_mimetype=$10,media_filename=$11,media_size=$12,media_asset_id=$13,
 quoted_message_id=$14,quoted_body=$15,quoted_sender=$16,quoted_is_from_me=$17,
 latitude=$18,longitude=$19,contact_name=$20,contact_phone=$21,contact_vcard=$22,
 poll_question=$23,poll_max_selections=$24,group_mentions=$25::jsonb,media_unavailable_reason=$26,link_preview=$27::jsonb,link_preview_media_asset_id=$28
 FROM chats c
 WHERE m.account_id=$1 AND m.chat_id=$2 AND m.message_id=$3 AND m.device_id=$4 AND m.is_from_me=$5
 AND c.account_id=m.account_id AND c.id=m.chat_id AND c.device_id=$4 AND c.jid LIKE '%@g.us'
 AND COALESCE(m.provider,'whatsapp_web')='whatsapp_web'
 AND COALESCE(m.message_type,'text')='text' AND COALESCE(m.body,'')=''
 AND NOT COALESCE(m.is_revoked,FALSE) AND NOT COALESCE(m.is_edited,FALSE) AND NOT COALESCE(m.is_view_once,FALSE) AND NOT COALESCE(m.media_deleted,FALSE)
 AND COALESCE(m.media_url,'')='' AND COALESCE(m.media_mimetype,'')='' AND COALESCE(m.media_filename,'')=''
 AND COALESCE(m.media_size,0)=0 AND m.media_asset_id IS NULL AND m.media_unavailable_reason=''
 AND m.latitude IS NULL AND m.longitude IS NULL
 AND COALESCE(m.contact_name,'')='' AND COALESCE(m.contact_phone,'')='' AND COALESCE(m.contact_vcard,'')=''
 AND COALESCE(m.poll_question,'')='' AND COALESCE(m.poll_max_selections,0)=0
 AND COALESCE(m.quoted_message_id,'')='' AND COALESCE(m.quoted_body,'')='' AND COALESCE(m.quoted_sender,'')=''
 AND m.group_mentions='[]'::jsonb
 AND NOT EXISTS (SELECT 1 FROM chat_group_message_state s WHERE s.account_id=m.account_id AND s.chat_id=m.chat_id AND s.message_id=m.message_id
                 AND (s.revoked OR s.edited_body IS NOT NULL OR s.edited_at IS NOT NULL))
 AND (m.from_jid=$6 OR EXISTS (
   SELECT 1 FROM chat_groups g CROSS JOIN LATERAL jsonb_array_elements(g.participants) p
   WHERE g.account_id=m.account_id AND g.chat_id=m.chat_id
     AND ((p->>'jid'=m.from_jid AND p->>'lid'=$6) OR (p->>'lid'=m.from_jid AND p->>'jid'=$6))))
 RETURNING to_jsonb(m)||jsonb_build_object('mentions',m.group_mentions),m.attention_through_at,m.attention_through_id,m.defer_attention,m.send_operation_id`,
		msg.AccountID, msg.ChatID, msg.MessageID, msg.DeviceID, msg.IsFromMe, author,
		msg.Body, msg.MessageType, msg.MediaURL, msg.MediaMimetype, msg.MediaFilename, msg.MediaSize, msg.MediaAssetID,
		msg.QuotedMessageID, msg.QuotedBody, msg.QuotedSender, msg.QuotedIsFromMe,
		msg.Latitude, msg.Longitude, msg.ContactName, msg.ContactPhone, msg.ContactVCard,
		msg.PollQuestion, msg.PollMaxSelections, mentions, msg.MediaUnavailableReason, msg.LinkPreview, msg.LinkPreviewMediaAssetID,
	).Scan(&raw, &canonical.AttentionThroughAt, &canonical.AttentionThroughID, &canonical.DeferAttention, &canonical.SendOperationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err = json.Unmarshal(raw, canonical); err != nil {
		return false, err
	}
	// Keep chronological identity and all attention/read counters untouched.
	// UUID is the existing history tie-breaker when timestamps are identical.
	_, err = tx.Exec(ctx, `UPDATE chats c SET last_message=COALESCE($4,''),state_version=state_version+1,updated_at=NOW()
 WHERE c.account_id=$1 AND c.id=$2 AND c.last_message_at=$3
 AND NOT EXISTS (SELECT 1 FROM messages newer WHERE newer.account_id=c.account_id AND newer.chat_id=c.id
                 AND (newer.timestamp,newer.id)>($3,$5))`,
		canonical.AccountID, canonical.ChatID, canonical.Timestamp, canonical.Body, canonical.ID)
	if err != nil {
		return false, err
	}
	*msg = *canonical
	return true, nil
}
