package repository

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var linkPreviewObjectFilename = regexp.MustCompile(`^[a-f0-9]{64}(?:-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?\.jpg$`)

func validLinkPreviewObjectKey(accountID uuid.UUID, key string) bool {
	prefix := accountID.String() + "/link-previews/"
	return accountID != uuid.Nil && strings.HasPrefix(key, prefix) && linkPreviewObjectFilename.MatchString(strings.TrimPrefix(key, prefix))
}

func lockLinkPreviewReferenceWrite(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:'||$1::text,0))`, accountID)
	return err
}

// Attachment races or an unavailable thumbnail must not discard message text.
// Lock the same asset row used by storage cleanup until its reference commits.
func validateMessageLinkPreviewTx(ctx context.Context, tx pgx.Tx, msg *domain.Message) error {
	if msg.LinkPreview == nil || msg.Body == nil || msg.IsRevoked || msg.IsViewOnce {
		msg.LinkPreview, msg.LinkPreviewMediaAssetID = nil, nil
		return nil
	}
	preview := domain.ReceivedMessageLinkPreview(*msg.Body, msg.LinkPreview.URL, msg.LinkPreview.Title, msg.LinkPreview.Description)
	if preview == nil {
		msg.LinkPreview, msg.LinkPreviewMediaAssetID = nil, nil
		return nil
	}
	if msg.LinkPreviewMediaAssetID != nil {
		var key string
		err := tx.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2 AND status='active' AND content_hash LIKE 'link_preview:%' FOR UPDATE`, msg.AccountID, *msg.LinkPreviewMediaAssetID).Scan(&key)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err == nil && validLinkPreviewObjectKey(msg.AccountID, key) {
			path := "/api/media/file/" + key
			preview.ThumbnailURL = &path
		} else {
			msg.LinkPreviewMediaAssetID = nil
		}
	}
	msg.LinkPreview = preview
	return nil
}

// A deliberate thumbnail removal survives provider re-delivery, including after
// physical purge. Compare the removed content revision, not a reusable URL/key.
const removedLinkPreviewReplaySQL = `SELECT EXISTS (
 SELECT 1 FROM storage_removed_references rr JOIN (
   SELECT id::text source_id,'message' slot FROM messages WHERE account_id=$1 AND chat_id=$2 AND message_id=$3
   UNION ALL SELECT id::text,'group_edit' FROM chat_group_message_state WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND $6::boolean
 ) source ON source.source_id=rr.snapshot->>'source_id' AND source.slot=rr.snapshot->>'slot'
 WHERE rr.account_id=$1 AND rr.adapter='link_preview' AND rr.state IN ('removed','purging','purged')
 AND rr.snapshot->'after'->>'body'=$4::text
 AND (rr.snapshot->'after'->'preview'-'thumbnail_url')=($5::jsonb-'thumbnail_url'))`

func removedLinkPreviewReplayTx(ctx context.Context, tx pgx.Tx, accountID, chatID uuid.UUID, messageID string, msg *domain.Message, includePending bool) (bool, error) {
	if msg.LinkPreview == nil || msg.LinkPreview.ThumbnailURL == nil || msg.Body == nil {
		return false, nil
	}
	var removed bool
	err := tx.QueryRow(ctx, removedLinkPreviewReplaySQL, accountID, chatID, messageID, *msg.Body, msg.LinkPreview, includePending).Scan(&removed)
	return removed, err
}

func clearLinkPreviewThumbnail(msg *domain.Message) {
	if msg.LinkPreview != nil {
		msg.LinkPreview.ThumbnailURL = nil
	}
	msg.LinkPreviewMediaAssetID = nil
}

// EnrichLinkPreview adds only missing provider display data to the exact
// unchanged message. It never replays insertion/attention/CRM side effects.
func (r *MessageRepository) EnrichLinkPreview(ctx context.Context, msg *domain.Message) (bool, error) {
	if msg == nil || msg.LinkPreview == nil || msg.Body == nil || msg.DeviceID == nil || msg.FromJID == nil || *msg.FromJID == "" || msg.IsRevoked || msg.IsViewOnce || msg.IsEdited {
		return false, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err = lockLinkPreviewReferenceWrite(ctx, tx, msg.AccountID); err != nil {
		return false, err
	}
	var chat uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 AND device_id=$3 FOR UPDATE`, msg.AccountID, msg.ChatID, msg.DeviceID).Scan(&chat); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	if err = validateMessageLinkPreviewTx(ctx, tx, msg); err != nil {
		return false, err
	}
	if msg.LinkPreview == nil {
		return false, nil
	}
	removed, err := removedLinkPreviewReplayTx(ctx, tx, msg.AccountID, msg.ChatID, msg.MessageID, msg, false)
	if err != nil || removed {
		return false, err
	}
	err = tx.QueryRow(ctx, `UPDATE messages SET link_preview=$8::jsonb,link_preview_media_asset_id=$9
 WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND device_id=$4 AND body=$5::text AND is_from_me=$6 AND COALESCE(is_edited,FALSE)=$7
 AND NOT COALESCE(is_revoked,FALSE) AND NOT COALESCE(is_view_once,FALSE)
 AND (link_preview IS NULL OR ((link_preview-'thumbnail_url')=($8::jsonb-'thumbnail_url') AND link_preview->>'thumbnail_url' IS NULL))
 AND (from_jid=$10 OR EXISTS (SELECT 1 FROM chat_groups g CROSS JOIN LATERAL jsonb_array_elements(g.participants) p
 WHERE g.account_id=messages.account_id AND g.chat_id=messages.chat_id
 AND ((p->>'jid'=messages.from_jid AND p->>'lid'=$10) OR (p->>'lid'=messages.from_jid AND p->>'jid'=$10))))
 AND link_preview IS DISTINCT FROM $8::jsonb RETURNING id,link_preview_version`, msg.AccountID, msg.ChatID, msg.MessageID, msg.DeviceID, *msg.Body, msg.IsFromMe, msg.IsEdited, msg.LinkPreview, msg.LinkPreviewMediaAssetID, *msg.FromJID).Scan(&msg.ID, &msg.LinkPreviewVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func (r *MessageRepository) EditInChatWithLinkPreview(ctx context.Context, accountID, chatID uuid.UUID, messageID, body string, preview *domain.MessageLinkPreview, assetID *uuid.UUID, snapshot ...*domain.Message) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockLinkPreviewReferenceWrite(ctx, tx, accountID); err != nil {
		return err
	}
	var locked uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, chatID).Scan(&locked); err != nil {
		return err
	}
	msg := &domain.Message{AccountID: accountID, Body: &body, LinkPreview: preview, LinkPreviewMediaAssetID: assetID}
	if err = validateMessageLinkPreviewTx(ctx, tx, msg); err != nil {
		return err
	}
	removed, err := removedLinkPreviewReplayTx(ctx, tx, accountID, chatID, messageID, msg, false)
	if err != nil {
		return err
	}
	if removed {
		clearLinkPreviewThumbnail(msg)
	}
	if preview != nil && msg.LinkPreview != nil {
		*preview = *msg.LinkPreview
	}
	err = tx.QueryRow(ctx, `UPDATE messages SET body=$4::text,is_edited=TRUE,group_mentions=COALESCE($5::jsonb,group_mentions),link_preview=$6::jsonb,link_preview_media_asset_id=$7 WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND NOT COALESCE(is_revoked,FALSE) RETURNING link_preview_version`, accountID, chatID, messageID, body, domain.MessageMentionsFrom(ctx), msg.LinkPreview, msg.LinkPreviewMediaAssetID).Scan(&msg.LinkPreviewVersion)
	if err != nil {
		return err
	}
	if len(snapshot) > 0 && snapshot[0] != nil {
		snapshot[0].LinkPreview = msg.LinkPreview
		snapshot[0].LinkPreviewMediaAssetID = msg.LinkPreviewMediaAssetID
		snapshot[0].LinkPreviewVersion = msg.LinkPreviewVersion
	}
	return tx.Commit(ctx)
}

// Group edits may arrive before the original history row. Preserve their
// preview under the existing edited_at ordering and replay it on INSERT.
func (r *MessageRepository) ApplyGroupMessageEdit(ctx context.Context, accountID, chatID uuid.UUID, messageID, body string, mentions []domain.MessageMention, editedAt time.Time, preview *domain.MessageLinkPreview, assetID *uuid.UUID, snapshot ...*domain.Message) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err = lockLinkPreviewReferenceWrite(ctx, tx, accountID); err != nil {
		return false, err
	}
	var locked uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM chats WHERE account_id=$1 AND id=$2 AND jid LIKE '%@g.us' FOR UPDATE`, accountID, chatID).Scan(&locked); err != nil {
		return false, err
	}
	msg := &domain.Message{AccountID: accountID, Body: &body, LinkPreview: preview, LinkPreviewMediaAssetID: assetID}
	if err = validateMessageLinkPreviewTx(ctx, tx, msg); err != nil {
		return false, err
	}
	// A real provider timestamp orders edits. A timestamp-free replay cannot
	// override a manual thumbnail removal merely by arriving again later.
	if editedAt.IsZero() {
		removed, e := removedLinkPreviewReplayTx(ctx, tx, accountID, chatID, messageID, msg, true)
		if e != nil {
			return false, e
		}
		if removed {
			clearLinkPreviewThumbnail(msg)
		}
		editedAt = time.Now()
	}
	if preview != nil && msg.LinkPreview != nil {
		*preview = *msg.LinkPreview
	}
	result, err := tx.Exec(ctx, `INSERT INTO chat_group_message_state(account_id,chat_id,message_id,edited_body,edited_at,edited_mentions,edited_link_preview,edited_link_preview_media_asset_id) VALUES($1,$2,$3,$4::text,$5,$6::jsonb,$7::jsonb,$8)
 ON CONFLICT(account_id,chat_id,message_id) DO UPDATE SET edited_body=EXCLUDED.edited_body,edited_at=EXCLUDED.edited_at,edited_mentions=EXCLUDED.edited_mentions,edited_link_preview=EXCLUDED.edited_link_preview,edited_link_preview_media_asset_id=EXCLUDED.edited_link_preview_media_asset_id
 WHERE NOT chat_group_message_state.revoked AND (chat_group_message_state.edited_at IS NULL OR chat_group_message_state.edited_at<EXCLUDED.edited_at)`, accountID, chatID, messageID, body, editedAt, mentions, msg.LinkPreview, msg.LinkPreviewMediaAssetID)
	if err != nil {
		return false, err
	}
	if result.RowsAffected() == 0 {
		return false, nil
	}
	err = tx.QueryRow(ctx, `UPDATE messages SET body=$4::text,is_edited=TRUE,group_mentions=$5::jsonb,link_preview=$6::jsonb,link_preview_media_asset_id=$7 WHERE account_id=$1 AND chat_id=$2 AND message_id=$3 AND NOT COALESCE(is_revoked,FALSE) RETURNING link_preview_version`, accountID, chatID, messageID, body, mentions, msg.LinkPreview, msg.LinkPreviewMediaAssetID).Scan(&msg.LinkPreviewVersion)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	if len(snapshot) > 0 && snapshot[0] != nil {
		snapshot[0].LinkPreview = msg.LinkPreview
		snapshot[0].LinkPreviewMediaAssetID = msg.LinkPreviewMediaAssetID
		snapshot[0].LinkPreviewVersion = msg.LinkPreviewVersion
	}
	return true, tx.Commit(ctx)
}

// HydrateLinkPreviews also replaces old cached snapshots with current durable
// state. Duplicate target/window projections each receive their own copy.
func (r *MessageRepository) HydrateLinkPreviews(ctx context.Context, accountID, chatID uuid.UUID, messages []*domain.Message) error {
	ids, byID := groupMessageProjections(accountID, chatID, messages)
	if len(ids) == 0 {
		return nil
	}
	for _, projections := range byID {
		for _, message := range projections {
			message.LinkPreview = nil
			message.LinkPreviewMediaAssetID = nil
		}
	}
	rows, err := r.db.Query(ctx, `SELECT m.id,m.link_preview,m.link_preview_media_asset_id,COALESCE(m.is_revoked,FALSE),COALESCE(m.is_view_once,FALSE),m.body,m.link_preview_version,
 CASE WHEN a.status='active' AND a.content_hash LIKE 'link_preview:%' THEN a.object_key ELSE NULL END
 FROM messages m LEFT JOIN media_assets a ON a.account_id=m.account_id AND a.id=m.link_preview_media_asset_id
 WHERE m.account_id=$1 AND m.chat_id=$2 AND m.id=ANY($3::uuid[])`, accountID, chatID, ids)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var asset *uuid.UUID
		var raw []byte
		var revoked, viewOnce bool
		var version int64
		var body, key *string
		if err = rows.Scan(&id, &raw, &asset, &revoked, &viewOnce, &body, &version, &key); err != nil {
			return err
		}
		var preview *domain.MessageLinkPreview
		if len(raw) > 0 && !revoked && !viewOnce && body != nil {
			var stored domain.MessageLinkPreview
			if json.Unmarshal(raw, &stored) == nil {
				preview = domain.ReceivedMessageLinkPreview(*body, stored.URL, stored.Title, stored.Description)
			}
			if preview != nil && key != nil && validLinkPreviewObjectKey(accountID, *key) {
				path := "/api/media/file/" + *key
				preview.ThumbnailURL = &path
			}
		}
		for _, msg := range byID[id] {
			msg.LinkPreview = nil
			if (msg.Body == nil && body == nil) || (msg.Body != nil && body != nil && *msg.Body == *body) {
				msg.LinkPreview = domain.CloneMessageLinkPreview(preview)
				msg.LinkPreviewVersion = version
			}
			msg.LinkPreviewMediaAssetID = asset
		}
	}
	return rows.Err()
}
