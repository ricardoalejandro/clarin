package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func hydrateMessageForwardingTx(ctx context.Context, tx pgx.Tx, msg *domain.Message) (bool, error) {
	var canonical domain.MessageForwarding
	var audio *bool
	var limits *domain.MessageSharingLimits
	var id uuid.UUID
	err := tx.QueryRow(ctx, `UPDATE messages AS m SET forwarding=clarin_merge_message_forwarding(forwarding,$4::jsonb),
 forwarding_source=CASE WHEN $4::jsonb->>'state'<>'unknown' THEN $5::text ELSE forwarding_source END,
 audio_ptt=COALESCE(audio_ptt,$6::boolean),sharing_limits=clarin_min_message_sharing_limits(sharing_limits,$10::jsonb)
 WHERE m.account_id=$1 AND m.chat_id=$2 AND m.message_id=$3 AND m.device_id IS NOT DISTINCT FROM $7::uuid AND m.is_from_me=$8
 AND (m.is_from_me OR NOT EXISTS(SELECT 1 FROM chats c WHERE c.account_id=m.account_id AND c.id=m.chat_id AND c.jid LIKE '%@g.us')
 OR (NULLIF(m.from_jid,'') IS NOT NULL AND NULLIF($9::text,'') IS NOT NULL AND (m.from_jid=$9::text OR EXISTS(
   SELECT 1 FROM chat_groups g CROSS JOIN LATERAL jsonb_array_elements(g.participants) member
   WHERE g.account_id=m.account_id AND g.chat_id=m.chat_id
   AND ((member->>'jid'=m.from_jid AND member->>'lid'=$9::text)
      OR(member->>'lid'=m.from_jid AND member->>'jid'=$9::text))))))
 AND (forwarding IS DISTINCT FROM clarin_merge_message_forwarding(forwarding,$4::jsonb) OR (audio_ptt IS NULL AND $6::boolean IS NOT NULL) OR sharing_limits IS DISTINCT FROM clarin_min_message_sharing_limits(sharing_limits,$10::jsonb))
 RETURNING id,forwarding,audio_ptt,sharing_limits`, msg.AccountID, msg.ChatID, msg.MessageID, msg.Forwarding, msg.ForwardingSource, msg.AudioPTT, msg.DeviceID, msg.IsFromMe, msg.FromJID, msg.SharingLimits).Scan(&id, &canonical, &audio, &limits)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	msg.ID = id
	msg.Forwarding = canonical
	msg.AudioPTT = audio
	msg.SharingLimits = limits
	return true, nil
}

// HydrateMessageForwarding enriches observed duplicate/history metadata without
// changing content, insertion timestamps, unread counts or author attribution.
// Incoming group duplicates must have the same author or a PN/LID pair
// verified in this account/group snapshot; another member cannot enrich them.
func (r *MessageRepository) HydrateMessageForwarding(ctx context.Context, msg *domain.Message) (bool, error) {
	if msg == nil {
		return false, nil
	}
	if msg.SharingLimits != nil && !msg.SharingLimits.Valid() {
		return false, fmt.Errorf("invalid message sharing limits")
	}
	msg.Forwarding = msg.Forwarding.Normalize()
	if msg.ForwardingSource == "" {
		msg.ForwardingSource = "provider"
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	changed, err := hydrateMessageForwardingTx(ctx, tx, msg)
	if err != nil {
		return false, err
	}
	return changed, tx.Commit(ctx)
}
