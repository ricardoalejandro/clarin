package repository

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

// WhatsAppStatusRepository persists only statuses owned by the account's
// devices. Incoming contact statuses must never reach this repository.
type WhatsAppStatusRepository struct {
	db *pgxpool.Pool
}

type ExpiredWhatsAppStatusMedia struct {
	ID           uuid.UUID
	AccountID    uuid.UUID
	DeviceID     uuid.UUID
	MediaURL     string
	MediaAssetID *uuid.UUID
	ObjectKey    string
}

type PendingWhatsAppStatusMediaCleanup struct {
	AccountID uuid.UUID
	ObjectKey string
	Token     uuid.UUID
}

type WhatsAppStatusViewUpsert struct {
	AccountID   uuid.UUID
	DeviceID    uuid.UUID
	MessageID   string
	ViewerJID   string
	ContactID   *uuid.UUID
	ReceiptType string
	ViewedAt    time.Time
}

const (
	whatsappStatusMediaGCPending  = "status_gc_pending"
	whatsappStatusMediaGCDeleting = "status_gc_deleting"
	whatsappStatusMediaGCGrace    = 10 * time.Minute
	whatsappStatusMediaGCLease    = 5 * time.Minute
)

func scanWhatsAppStatus(row pgx.Row) (*domain.WhatsAppStatus, error) {
	status := &domain.WhatsAppStatus{}
	err := row.Scan(
		&status.ID, &status.AccountID, &status.DeviceID, &status.WhatsAppMessageID,
		&status.Source, &status.Kind, &status.Text, &status.Caption,
		&status.BackgroundARGB, &status.FontStyle, &status.MediaURL,
		&status.MediaMimetype, &status.MediaSize, &status.MediaAssetID,
		&status.Status, &status.ErrorMessage, &status.Privacy, &status.SentAt,
		&status.ExpiresAt, &status.CreatedAt, &status.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return status, nil
}

const whatsappStatusColumns = `
	id, account_id, device_id, whatsapp_message_id, source, kind, text, caption,
	background_argb, font_style, media_url, media_mimetype, media_size,
	media_asset_id, status, error_message, privacy, sent_at, expires_at,
	created_at, updated_at`

func (r *WhatsAppStatusRepository) Create(ctx context.Context, status *domain.WhatsAppStatus) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if status.MediaAssetID != nil {
		var assetStatus, contentHash, objectKey string
		if err := tx.QueryRow(ctx, `
			SELECT status,content_hash,object_key FROM media_assets
			WHERE id=$1 AND account_id=$2
			FOR UPDATE
		`, *status.MediaAssetID, status.AccountID).Scan(&assetStatus, &contentHash, &objectKey); err != nil {
			return err
		}
		if assetStatus != "active" || !strings.HasPrefix(contentHash, domain.MediaAssetHashWhatsAppStatusPrefix) || !storage.IsAccountPrivateStatusObjectKey(status.AccountID, objectKey) {
			return fmt.Errorf("media asset is not active")
		}
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO whatsapp_statuses (
			account_id, device_id, whatsapp_message_id, source, kind, text, caption,
			background_argb, font_style, media_url, media_mimetype, media_size,
			media_asset_id, status, error_message, privacy, sent_at, expires_at
		) VALUES (
			$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18
		)
		RETURNING id, created_at, updated_at
	`, status.AccountID, status.DeviceID, status.WhatsAppMessageID, status.Source,
		status.Kind, status.Text, status.Caption, status.BackgroundARGB,
		status.FontStyle, status.MediaURL, status.MediaMimetype, status.MediaSize,
		status.MediaAssetID, status.Status, status.ErrorMessage, status.Privacy,
		status.SentAt, status.ExpiresAt,
	).Scan(&status.ID, &status.CreatedAt, &status.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhatsAppStatusRepository) UpsertOwnDeviceStatus(ctx context.Context, status *domain.WhatsAppStatus) error {
	if status == nil || status.WhatsAppMessageID == nil || strings.TrimSpace(*status.WhatsAppMessageID) == "" {
		return fmt.Errorf("whatsapp message ID is required")
	}
	messageID := strings.TrimSpace(*status.WhatsAppMessageID)
	status.WhatsAppMessageID = &messageID

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhatsAppStatusMessage(ctx, tx, status.AccountID, status.DeviceID, messageID); err != nil {
		return err
	}
	if status.MediaAssetID != nil {
		var assetStatus, contentHash, objectKey string
		if err := tx.QueryRow(ctx, `
			SELECT status,content_hash,object_key FROM media_assets
			WHERE id=$1 AND account_id=$2
			FOR UPDATE
		`, *status.MediaAssetID, status.AccountID).Scan(&assetStatus, &contentHash, &objectKey); err != nil {
			return err
		}
		if assetStatus != "active" || !strings.HasPrefix(contentHash, domain.MediaAssetHashWhatsAppStatusPrefix) || !storage.IsAccountPrivateStatusObjectKey(status.AccountID, objectKey) {
			return fmt.Errorf("media asset is not active")
		}
	}
	var previousMediaAssetID *uuid.UUID
	previousErr := tx.QueryRow(ctx, `
		SELECT media_asset_id FROM whatsapp_statuses
		WHERE account_id=$1 AND device_id=$2 AND whatsapp_message_id=$3
	`, status.AccountID, status.DeviceID, messageID).Scan(&previousMediaAssetID)
	if previousErr != nil && previousErr != pgx.ErrNoRows {
		return previousErr
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO whatsapp_statuses (
			account_id, device_id, whatsapp_message_id, source, kind, text, caption,
			background_argb, font_style, media_url, media_mimetype, media_size,
			media_asset_id, status, privacy, sent_at, expires_at
		) VALUES ($1,$2,$3,'device',$4,$5,$6,$7,$8,$9,$10,$11,$12,'sent',$13,$14,$15)
		ON CONFLICT (account_id, device_id, whatsapp_message_id)
			WHERE whatsapp_message_id IS NOT NULL
		DO UPDATE SET
			kind=EXCLUDED.kind, text=EXCLUDED.text, caption=EXCLUDED.caption,
			background_argb=EXCLUDED.background_argb, font_style=EXCLUDED.font_style,
			media_url=COALESCE(EXCLUDED.media_url, whatsapp_statuses.media_url),
			media_mimetype=COALESCE(EXCLUDED.media_mimetype, whatsapp_statuses.media_mimetype),
			media_size=COALESCE(EXCLUDED.media_size, whatsapp_statuses.media_size),
			media_asset_id=COALESCE(EXCLUDED.media_asset_id, whatsapp_statuses.media_asset_id),
			status='sent', error_message=NULL, sent_at=EXCLUDED.sent_at,
			expires_at=EXCLUDED.expires_at, updated_at=NOW()
		RETURNING id, created_at, updated_at
	`, status.AccountID, status.DeviceID, status.WhatsAppMessageID, status.Kind,
		status.Text, status.Caption, status.BackgroundARGB, status.FontStyle,
		status.MediaURL, status.MediaMimetype, status.MediaSize, status.MediaAssetID,
		status.Privacy, status.SentAt, status.ExpiresAt,
	).Scan(&status.ID, &status.CreatedAt, &status.UpdatedAt); err != nil {
		return err
	}
	shouldSchedulePrevious := previousMediaAssetID != nil && status.MediaAssetID != nil && *previousMediaAssetID != *status.MediaAssetID
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	if shouldSchedulePrevious {
		_, _ = r.ScheduleMediaCleanup(ctx, status.AccountID, *previousMediaAssetID, time.Now())
	}
	return nil
}

func lockWhatsAppStatusMessage(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID, messageID string) error {
	lockScope := accountID.String() + ":" + deviceID.String()
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text), hashtext($2::text))`, lockScope, messageID)
	return err
}

func (r *WhatsAppStatusRepository) MarkMediaAssetOrphanedIfUnused(ctx context.Context, accountID, assetID uuid.UUID) error {
	_, err := r.ScheduleMediaCleanup(ctx, accountID, assetID, time.Now())
	return err
}

// PrepareMediaUpload creates the durable inventory row before MinIO is
// touched. A crash after object upload but before media_assets/status creation
// therefore leaves a discoverable GC job instead of an invisible orphan.
func (r *WhatsAppStatusRepository) PrepareMediaUpload(ctx context.Context, accountID uuid.UUID, objectKey, mediaType, contentType, filename string, sizeBytes int64, now time.Time) error {
	if !storage.IsAccountPrivateStatusObjectKey(accountID, objectKey) {
		return fmt.Errorf("status media key is outside the account private scope")
	}
	_, err := r.db.Exec(ctx, `
		INSERT INTO storage_objects (
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,
			delete_token,delete_attempts,delete_error,next_delete_at,deleted_at,updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,'whatsapp_status',$7,NULL,0,'',$8,NULL,NOW())
		ON CONFLICT (account_id,object_key) DO UPDATE SET
			media_type=EXCLUDED.media_type,content_type=EXCLUDED.content_type,
			filename=EXCLUDED.filename,size_bytes=EXCLUDED.size_bytes,
			source='whatsapp_status',status=EXCLUDED.status,delete_token=NULL,
			delete_attempts=0,delete_error='',next_delete_at=EXCLUDED.next_delete_at,
			deleted_at=NULL,updated_at=NOW()
	`, accountID, objectKey, mediaType, contentType, filename, sizeBytes,
		whatsappStatusMediaGCPending, now.Add(whatsappStatusMediaGCGrace))
	return err
}

func (r *WhatsAppStatusRepository) ActivateMediaUpload(ctx context.Context, accountID uuid.UUID, objectKey string) error {
	if !storage.IsAccountPrivateStatusObjectKey(accountID, objectKey) {
		return fmt.Errorf("status media key is outside the account private scope")
	}
	_, err := r.db.Exec(ctx, `UPDATE storage_objects
		SET status='active',delete_token=NULL,delete_error='',next_delete_at=NULL,
			deleted_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2 AND source='whatsapp_status'`, accountID, objectKey)
	return err
}

func (r *WhatsAppStatusRepository) GetByID(ctx context.Context, accountID, id uuid.UUID) (*domain.WhatsAppStatus, error) {
	return scanWhatsAppStatus(r.db.QueryRow(ctx, `SELECT `+whatsappStatusColumns+`
		FROM whatsapp_statuses WHERE account_id=$1 AND id=$2`, accountID, id))
}

func (r *WhatsAppStatusRepository) ListActive(ctx context.Context, accountID, deviceID uuid.UUID) ([]*domain.WhatsAppStatus, error) {
	rows, err := r.db.Query(ctx, `SELECT `+whatsappStatusColumns+`
		FROM whatsapp_statuses
		WHERE account_id=$1 AND device_id=$2 AND expires_at>NOW() AND status<>'expired'
		ORDER BY COALESCE(sent_at, created_at) DESC, id DESC`, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	statuses := make([]*domain.WhatsAppStatus, 0)
	for rows.Next() {
		status, err := scanWhatsAppStatus(rows)
		if err != nil {
			return nil, err
		}
		statuses = append(statuses, status)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if len(statuses) == 0 {
		return statuses, nil
	}
	statusIDs := make([]uuid.UUID, 0, len(statuses))
	byID := make(map[uuid.UUID]*domain.WhatsAppStatus, len(statuses))
	for _, status := range statuses {
		statusIDs = append(statusIDs, status.ID)
		byID[status.ID] = status
	}
	countRows, err := r.db.Query(ctx, `
		SELECT status_id,COUNT(*)::int
		FROM whatsapp_status_views
		WHERE account_id=$1 AND device_id=$2 AND status_id=ANY($3)
		GROUP BY status_id
	`, accountID, deviceID, statusIDs)
	if err != nil {
		return nil, err
	}
	defer countRows.Close()
	for countRows.Next() {
		var statusID uuid.UUID
		var count int
		if err := countRows.Scan(&statusID, &count); err != nil {
			return nil, err
		}
		if status := byID[statusID]; status != nil {
			status.ViewCount = count
		}
	}
	return statuses, countRows.Err()
}

// FindExistingContactForStatusViewer links a viewer to an existing Contact
// without ever creating CRM data from a status receipt. Matching stays inside
// the account and prefers the canonical JID over normalized phone aliases.
func (r *WhatsAppStatusRepository) FindExistingContactForStatusViewer(ctx context.Context, accountID uuid.UUID, viewerJID string) (*uuid.UUID, error) {
	viewerJID = strings.TrimSpace(viewerJID)
	if viewerJID == "" {
		return nil, nil
	}
	phone := strings.Map(func(value rune) rune {
		if value >= '0' && value <= '9' {
			return value
		}
		return -1
	}, strings.SplitN(viewerJID, "@", 2)[0])
	var contactID uuid.UUID
	err := r.db.QueryRow(ctx, `
		SELECT c.id
		FROM contacts c
		WHERE c.account_id=$1
		  AND (
			LOWER(BTRIM(c.jid))=LOWER(BTRIM($2))
			OR ($3<>'' AND REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')=$3)
			OR ($3<>'' AND EXISTS (
				SELECT 1 FROM contact_phones cp
				WHERE cp.contact_id=c.id
				  AND REGEXP_REPLACE(COALESCE(cp.phone,''),'[^0-9]','','g')=$3
			))
			OR EXISTS (
				SELECT 1 FROM contact_aliases ca
				WHERE ca.account_id=$1 AND ca.contact_id=c.id
				  AND ((LOWER(ca.alias_type)='jid' AND LOWER(BTRIM(ca.alias_value))=LOWER(BTRIM($2)))
				       OR ($3<>'' AND LOWER(ca.alias_type)='phone' AND ca.normalized_value=$3))
			)
		  )
		ORDER BY
		  CASE WHEN LOWER(BTRIM(c.jid))=LOWER(BTRIM($2)) THEN 0
		       WHEN $3<>'' AND REGEXP_REPLACE(COALESCE(c.phone,''),'[^0-9]','','g')=$3 THEN 1
		       ELSE 2 END,
		  c.updated_at DESC,c.id
		LIMIT 1
	`, accountID, viewerJID, phone).Scan(&contactID)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &contactID, nil
}

func scanWhatsAppStatusView(row pgx.Row) (*domain.WhatsAppStatusView, error) {
	view := &domain.WhatsAppStatusView{}
	err := row.Scan(
		&view.ID, &view.AccountID, &view.DeviceID, &view.StatusID,
		&view.ViewerJID, &view.ContactID, &view.ReceiptType, &view.ViewedAt,
		&view.CreatedAt, &view.UpdatedAt, &view.ViewerName,
		&view.ViewerPhone, &view.ViewerAvatar,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return view, nil
}

const whatsappStatusViewColumns = `
	v.id,v.account_id,v.device_id,v.status_id,v.viewer_jid,v.contact_id,
	v.receipt_type,v.viewed_at,v.created_at,v.updated_at,
	NULLIF(COALESCE(NULLIF(c.custom_name,''),NULLIF(CONCAT_WS(' ',NULLIF(c.name,''),NULLIF(c.last_name,'')),''),NULLIF(c.push_name,''),''),''),
	NULLIF(COALESCE(c.phone,SPLIT_PART(v.viewer_jid,'@',1)),''),NULLIF(c.avatar_url,'')`

// UpsertView accepts a receipt only when the referenced WhatsApp message is a
// still-active own status of the same account and device.
func (r *WhatsAppStatusRepository) UpsertView(ctx context.Context, input WhatsAppStatusViewUpsert) (*domain.WhatsAppStatusView, error) {
	input.MessageID = strings.TrimSpace(input.MessageID)
	input.ViewerJID = strings.TrimSpace(input.ViewerJID)
	if input.MessageID == "" || input.ViewerJID == "" || (input.ReceiptType != "read" && input.ReceiptType != "played") {
		return nil, fmt.Errorf("invalid status view")
	}
	if input.ViewedAt.IsZero() {
		input.ViewedAt = time.Now()
	}
	return scanWhatsAppStatusView(r.db.QueryRow(ctx, `
		WITH upserted AS (
			INSERT INTO whatsapp_status_views (
				account_id,device_id,status_id,viewer_jid,contact_id,receipt_type,viewed_at
			)
			SELECT ws.account_id,ws.device_id,ws.id,$4,$5,$6,$7
			FROM whatsapp_statuses ws
			WHERE ws.account_id=$1 AND ws.device_id=$2
			  AND ws.whatsapp_message_id=$3 AND ws.status='sent' AND ws.expires_at>NOW()
			ON CONFLICT (account_id,device_id,status_id,viewer_jid) DO UPDATE SET
				contact_id=COALESCE(EXCLUDED.contact_id,whatsapp_status_views.contact_id),
				receipt_type=CASE WHEN whatsapp_status_views.receipt_type='played' THEN 'played'
				                  ELSE EXCLUDED.receipt_type END,
				viewed_at=LEAST(whatsapp_status_views.viewed_at,EXCLUDED.viewed_at),
				updated_at=NOW()
			RETURNING *
		)
		SELECT `+whatsappStatusViewColumns+`
		FROM upserted v
		LEFT JOIN contacts c ON c.account_id=v.account_id AND c.id=v.contact_id
	`, input.AccountID, input.DeviceID, input.MessageID, input.ViewerJID,
		input.ContactID, input.ReceiptType, input.ViewedAt))
}

func (r *WhatsAppStatusRepository) ListViews(ctx context.Context, accountID, statusID uuid.UUID, limit, offset int) ([]*domain.WhatsAppStatusView, int, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	var total int
	if err := r.db.QueryRow(ctx, `
		SELECT COUNT(*)::int
		FROM whatsapp_status_views v
		JOIN whatsapp_statuses ws ON ws.account_id=v.account_id AND ws.device_id=v.device_id AND ws.id=v.status_id
		WHERE v.account_id=$1 AND v.status_id=$2
	`, accountID, statusID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT `+whatsappStatusViewColumns+`
		FROM whatsapp_status_views v
		JOIN whatsapp_statuses ws ON ws.account_id=v.account_id AND ws.device_id=v.device_id AND ws.id=v.status_id
		LEFT JOIN contacts c ON c.account_id=v.account_id AND c.id=v.contact_id
		WHERE v.account_id=$1 AND v.status_id=$2
		ORDER BY v.viewed_at DESC,v.id DESC
		LIMIT $3 OFFSET $4
	`, accountID, statusID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	views := make([]*domain.WhatsAppStatusView, 0)
	for rows.Next() {
		view, err := scanWhatsAppStatusView(rows)
		if err != nil {
			return nil, 0, err
		}
		views = append(views, view)
	}
	return views, total, rows.Err()
}

func (r *WhatsAppStatusRepository) CountViews(ctx context.Context, accountID, statusID uuid.UUID) (int, error) {
	var count int
	err := r.db.QueryRow(ctx, `SELECT COUNT(*)::int FROM whatsapp_status_views
		WHERE account_id=$1 AND status_id=$2`, accountID, statusID).Scan(&count)
	return count, err
}

func (r *WhatsAppStatusRepository) MarkSent(ctx context.Context, accountID, id uuid.UUID, messageID, privacy string, sentAt time.Time) error {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return fmt.Errorf("whatsapp message ID is required")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deviceID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT device_id FROM whatsapp_statuses WHERE account_id=$1 AND id=$2`, accountID, id).Scan(&deviceID); err != nil {
		return err
	}
	// Both the HTTP response and the from-me event use this same lock before
	// assigning a WhatsApp message ID. This prevents a unique-key race without
	// relying on which path happens to reach PostgreSQL first.
	if err := lockWhatsAppStatusMessage(ctx, tx, accountID, deviceID, messageID); err != nil {
		return err
	}
	// A from-me event can race the HTTP response and create the canonical row
	// first. Keep the row created by the request so the frontend's optimistic ID
	// remains stable. Preserve any exceptionally fast viewer receipts before
	// removing the same-account/device duplicate.
	if _, err := tx.Exec(ctx, `
		INSERT INTO whatsapp_status_views (
			account_id,device_id,status_id,viewer_jid,contact_id,receipt_type,viewed_at,created_at,updated_at
		)
		SELECT v.account_id,v.device_id,target.id,v.viewer_jid,v.contact_id,
		       v.receipt_type,v.viewed_at,v.created_at,v.updated_at
		FROM whatsapp_status_views v
		JOIN whatsapp_statuses duplicate
		  ON duplicate.account_id=v.account_id AND duplicate.device_id=v.device_id AND duplicate.id=v.status_id
		JOIN whatsapp_statuses target
		  ON target.account_id=duplicate.account_id AND target.device_id=duplicate.device_id
		WHERE target.account_id=$1 AND target.id=$2
		  AND duplicate.whatsapp_message_id=$3 AND duplicate.id<>target.id
		ON CONFLICT (account_id,device_id,status_id,viewer_jid) DO UPDATE SET
			contact_id=COALESCE(EXCLUDED.contact_id,whatsapp_status_views.contact_id),
			receipt_type=CASE WHEN whatsapp_status_views.receipt_type='played' OR EXCLUDED.receipt_type='played'
			                  THEN 'played' ELSE 'read' END,
			viewed_at=LEAST(whatsapp_status_views.viewed_at,EXCLUDED.viewed_at),
			updated_at=GREATEST(whatsapp_status_views.updated_at,EXCLUDED.updated_at)
	`, accountID, id, messageID); err != nil {
		return err
	}
	removedAssets := make([]uuid.UUID, 0, 1)
	removedRows, err := tx.Query(ctx, `DELETE FROM whatsapp_statuses duplicate
		USING whatsapp_statuses target
		WHERE target.account_id=$1 AND target.id=$2
		  AND duplicate.account_id=target.account_id
		  AND duplicate.device_id=target.device_id
		  AND duplicate.whatsapp_message_id=$3
		  AND duplicate.id<>target.id
		RETURNING duplicate.media_asset_id`, accountID, id, messageID)
	if err != nil {
		return err
	}
	for removedRows.Next() {
		var assetID *uuid.UUID
		if err := removedRows.Scan(&assetID); err != nil {
			removedRows.Close()
			return err
		}
		if assetID != nil {
			removedAssets = append(removedAssets, *assetID)
		}
	}
	if err := removedRows.Err(); err != nil {
		removedRows.Close()
		return err
	}
	removedRows.Close()
	cmd, err := tx.Exec(ctx, `
		UPDATE whatsapp_statuses
		SET whatsapp_message_id=$3, status='sent', error_message=NULL, privacy=$4,
			sent_at=$5::timestamptz, expires_at=$5::timestamptz + INTERVAL '24 hours', updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, id, messageID, privacy, sentAt)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	for _, assetID := range removedAssets {
		_, _ = r.ScheduleMediaCleanup(ctx, accountID, assetID, time.Now())
	}
	return nil
}

func (r *WhatsAppStatusRepository) MarkFailed(ctx context.Context, accountID, id uuid.UUID, message string) error {
	_, err := r.db.Exec(ctx, `UPDATE whatsapp_statuses
		SET status='failed', error_message=$3, updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, id, message)
	return err
}

func (r *WhatsAppStatusRepository) MarkPending(ctx context.Context, accountID, id uuid.UUID) error {
	cmd, err := r.db.Exec(ctx, `UPDATE whatsapp_statuses
		SET status='pending', error_message=NULL, updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND status='failed' AND expires_at>NOW()`, accountID, id)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return nil
}

// DeleteExpired removes metadata and returns the exact rows deleted. URL-only
// legacy media is queued atomically; all object-store I/O still happens later,
// outside database locks.
func (r *WhatsAppStatusRepository) DeleteExpired(ctx context.Context, now time.Time) ([]ExpiredWhatsAppStatusMedia, error) {
	return r.deleteStatuses(ctx, `
		DELETE FROM whatsapp_statuses
		WHERE expires_at <= $1 AND status <> 'expired'
		RETURNING id,account_id,device_id,COALESCE(media_url,''),media_asset_id
	`, now)
}

// DeleteStalePending removes local placeholders that never obtained a
// WhatsApp message ID. It never republishes them, because publication may have
// succeeded remotely even when the local confirmation was lost.
func (r *WhatsAppStatusRepository) DeleteStalePending(ctx context.Context, staleBefore time.Time) ([]ExpiredWhatsAppStatusMedia, error) {
	return r.deleteStatuses(ctx, `
		DELETE FROM whatsapp_statuses
		WHERE status='pending' AND whatsapp_message_id IS NULL AND updated_at <= $1
		RETURNING id,account_id,device_id,COALESCE(media_url,''),media_asset_id
	`, staleBefore)
}

func (r *WhatsAppStatusRepository) DeleteByID(ctx context.Context, accountID, statusID uuid.UUID) (*ExpiredWhatsAppStatusMedia, error) {
	deleted, err := r.deleteStatuses(ctx, `
		DELETE FROM whatsapp_statuses
		WHERE account_id=$1 AND id=$2 AND status<>'pending'
		RETURNING id,account_id,device_id,COALESCE(media_url,''),media_asset_id
	`, accountID, statusID)
	if err != nil || len(deleted) == 0 {
		return nil, err
	}
	return &deleted[0], nil
}

func (r *WhatsAppStatusRepository) DeleteByWhatsAppMessageID(ctx context.Context, accountID, deviceID uuid.UUID, messageID string) (*ExpiredWhatsAppStatusMedia, error) {
	messageID = strings.TrimSpace(messageID)
	if messageID == "" {
		return nil, nil
	}
	deleted, err := r.deleteStatuses(ctx, `
		DELETE FROM whatsapp_statuses
		WHERE account_id=$1 AND device_id=$2 AND whatsapp_message_id=$3
		RETURNING id,account_id,device_id,COALESCE(media_url,''),media_asset_id
	`, accountID, deviceID, messageID)
	if err != nil || len(deleted) == 0 {
		return nil, err
	}
	return &deleted[0], nil
}

func (r *WhatsAppStatusRepository) deleteStatuses(ctx context.Context, statement string, args ...interface{}) ([]ExpiredWhatsAppStatusMedia, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, statement, args...)
	if err != nil {
		return nil, err
	}
	deleted := make([]ExpiredWhatsAppStatusMedia, 0)
	for rows.Next() {
		var item ExpiredWhatsAppStatusMedia
		if err := rows.Scan(&item.ID, &item.AccountID, &item.DeviceID, &item.MediaURL, &item.MediaAssetID); err != nil {
			rows.Close()
			return nil, err
		}
		item.ObjectKey = legacyStatusObjectKeyFromMediaURL(item.MediaURL)
		deleted = append(deleted, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// URL-only legacy objects have no media_assets row for the periodic
	// reconciler to rediscover. Queue them in this same transaction so a crash
	// can never commit metadata deletion without also committing the GC claim.
	for _, item := range deleted {
		if item.MediaAssetID != nil || !storage.IsAccountLegacyStatusObjectKey(item.AccountID, item.ObjectKey) {
			continue
		}
		if _, err := scheduleLegacyObjectCleanupTx(ctx, tx, item.AccountID, item.ObjectKey, time.Now()); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return deleted, nil
}

func legacyStatusObjectKeyFromMediaURL(mediaURL string) string {
	mediaURL = strings.TrimSpace(mediaURL)
	if mediaURL == "" {
		return ""
	}
	if strings.HasPrefix(mediaURL, "/api/media/file/") {
		objectKey := strings.TrimPrefix(mediaURL, "/api/media/file/")
		if decoded, err := url.PathUnescape(objectKey); err == nil {
			return strings.TrimPrefix(decoded, "/")
		}
		return strings.TrimPrefix(objectKey, "/")
	}
	if index := strings.Index(mediaURL, "/clarin-media/"); index >= 0 {
		return strings.TrimPrefix(mediaURL[index+len("/clarin-media/"):], "/")
	}
	return ""
}

// ScheduleMediaCleanup transitions an unreferenced, status-private asset into
// the durable GC queue. FOR UPDATE is required: FOR KEY SHARE would still allow
// a concurrent status transition to mark the asset inactive.
func (r *WhatsAppStatusRepository) ScheduleMediaCleanup(ctx context.Context, accountID, assetID uuid.UUID, now time.Time) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var contentHash, objectKey, assetStatus, mediaType, contentType, filename string
	var sizeBytes int64
	var updatedAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT content_hash,object_key,status,media_type,content_type,filename,size_bytes,updated_at
		FROM media_assets
		WHERE account_id=$1 AND id=$2
		FOR UPDATE
	`, accountID, assetID).Scan(&contentHash, &objectKey, &assetStatus, &mediaType, &contentType, &filename, &sizeBytes, &updatedAt); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	if !storage.IsAccountStatusObjectKey(accountID, objectKey) {
		return false, tx.Commit(ctx)
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM whatsapp_statuses ws
		WHERE ws.account_id=$1 AND ws.media_asset_id=$2
		UNION ALL
		SELECT 1 FROM messages m
		WHERE m.account_id=$1 AND m.media_asset_id=$2
		  AND COALESCE(m.media_deleted,false)=false
	)`, accountID, assetID).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		if assetStatus != "active" {
			if _, err := tx.Exec(ctx, `UPDATE media_assets
				SET status='active',deleted_at=NULL,updated_at=NOW()
				WHERE account_id=$1 AND id=$2`, accountID, assetID); err != nil {
				return false, err
			}
		}
		return false, tx.Commit(ctx)
	}
	// A freshly uploaded asset may not have reached WhatsAppStatus.Create yet.
	// The periodic reconciliation will retry after the grace window.
	if updatedAt.After(now.Add(-whatsappStatusMediaGCGrace)) {
		return false, tx.Commit(ctx)
	}
	if assetStatus == "deleted" {
		return false, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets
		SET status=$3,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, assetID, whatsappStatusMediaGCPending); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,
			delete_token,delete_error,next_delete_at,deleted_at,updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,'whatsapp_status',$7,NULL,'',$8,NULL,NOW())
		ON CONFLICT (account_id,object_key) DO UPDATE SET
			media_type=EXCLUDED.media_type,content_type=EXCLUDED.content_type,
			filename=EXCLUDED.filename,size_bytes=EXCLUDED.size_bytes,
			source='whatsapp_status',status=EXCLUDED.status,delete_token=NULL,
			delete_error='',next_delete_at=EXCLUDED.next_delete_at,deleted_at=NULL,updated_at=NOW()
	`, accountID, objectKey, mediaType, contentType, filename, sizeBytes,
		whatsappStatusMediaGCPending, now.Add(whatsappStatusMediaGCGrace)); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

// ScheduleLegacyObjectCleanup covers historical status rows that stored only a
// public proxy URL and had no media_asset_id. The namespace and account prefix
// are validated before a durable job can be created.
func (r *WhatsAppStatusRepository) ScheduleLegacyObjectCleanup(ctx context.Context, accountID uuid.UUID, objectKey string, now time.Time) (bool, error) {
	if !storage.IsAccountLegacyStatusObjectKey(accountID, objectKey) {
		return false, nil
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	staged, err := scheduleLegacyObjectCleanupTx(ctx, tx, accountID, objectKey, now)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return staged, nil
}

func scheduleLegacyObjectCleanupTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, objectKey string, now time.Time) (bool, error) {
	if !storage.IsAccountLegacyStatusObjectKey(accountID, objectKey) {
		return false, nil
	}
	proxyURL := "/api/media/file/" + objectKey
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM whatsapp_statuses ws
		WHERE ws.account_id=$1
		  AND (ws.media_url=$2 OR RIGHT(COALESCE(ws.media_url,''),LENGTH($3)+1)='/' || $3)
		UNION ALL
		SELECT 1 FROM messages m
		WHERE m.account_id=$1 AND COALESCE(m.media_deleted,false)=false
		  AND (m.media_url=$2 OR RIGHT(COALESCE(m.media_url,''),LENGTH($3)+1)='/' || $3)
	)`, accountID, proxyURL, objectKey).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		return false, nil
	}
	filename := objectKey
	if index := strings.LastIndex(objectKey, "/"); index >= 0 && index+1 < len(objectKey) {
		filename = objectKey[index+1:]
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,
			delete_token,delete_error,next_delete_at,deleted_at,updated_at
		) VALUES ($1,$2,'other','application/octet-stream',$3,0,'whatsapp_status',$4,NULL,'',$5,NULL,NOW())
		ON CONFLICT (account_id,object_key) DO UPDATE SET
			source='whatsapp_status',status=EXCLUDED.status,delete_token=NULL,
			delete_error='',next_delete_at=EXCLUDED.next_delete_at,deleted_at=NULL,updated_at=NOW()
	`, accountID, objectKey, filename, whatsappStatusMediaGCPending, now); err != nil {
		return false, err
	}
	return true, nil
}

// ScheduleUnreferencedStatusMedia recovers the small crash window between
// metadata deletion and queueing. It only considers the private status hash
// namespace and leaves recently touched uploads alone.
func (r *WhatsAppStatusRepository) ScheduleUnreferencedStatusMedia(ctx context.Context, now time.Time, limit int) error {
	if limit <= 0 {
		limit = 200
	}
	rows, err := r.db.Query(ctx, `
		SELECT ma.account_id,ma.id
		FROM media_assets ma
		WHERE (
			ma.content_hash LIKE $1
			OR ma.object_key LIKE ma.account_id::text || '/statuses/%'
			OR ma.object_key LIKE ma.account_id::text || '/_private/statuses/%'
		)
		  AND ma.status IN ('active','orphaned')
		  AND ma.updated_at <= $2
		  AND NOT EXISTS (
			SELECT 1 FROM whatsapp_statuses ws
			WHERE ws.account_id=ma.account_id AND ws.media_asset_id=ma.id
		  )
		  AND NOT EXISTS (
			SELECT 1 FROM messages m
			WHERE m.account_id=ma.account_id AND m.media_asset_id=ma.id
			  AND COALESCE(m.media_deleted,false)=false
		  )
		ORDER BY ma.updated_at,ma.id
		LIMIT $3
	`, domain.MediaAssetHashWhatsAppStatusPrefix+"%", now.Add(-whatsappStatusMediaGCGrace), limit)
	if err != nil {
		return err
	}
	type candidate struct {
		accountID uuid.UUID
		assetID   uuid.UUID
	}
	candidates := make([]candidate, 0)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.accountID, &item.assetID); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, item := range candidates {
		if _, err := r.ScheduleMediaCleanup(ctx, item.accountID, item.assetID, now); err != nil {
			return err
		}
	}
	return nil
}

// ClaimPendingMediaCleanup creates a durable deletion token in a short
// transaction. The caller performs the idempotent object-store deletion only
// after this method commits.
func (r *WhatsAppStatusRepository) ClaimPendingMediaCleanup(ctx context.Context, now time.Time) (*PendingWhatsAppStatusMediaCleanup, error) {
	var accountID uuid.UUID
	var objectKey string
	for {
		err := r.db.QueryRow(ctx, `
			SELECT account_id,object_key
			FROM storage_objects
			WHERE source='whatsapp_status'
			  AND (
				(status=$1 AND COALESCE(next_delete_at,updated_at)<=$3)
				OR (status=$2 AND updated_at<=$4)
			  )
			ORDER BY COALESCE(next_delete_at,updated_at),id
			LIMIT 1
		`, whatsappStatusMediaGCPending, whatsappStatusMediaGCDeleting, now, now.Add(-whatsappStatusMediaGCLease)).Scan(&accountID, &objectKey)
		if err != nil {
			if err == pgx.ErrNoRows {
				return nil, nil
			}
			return nil, err
		}
		if storage.IsAccountStatusObjectKey(accountID, objectKey) {
			break
		}
		// A corrupted cross-account queue row must never block later jobs or be
		// retried into an unsafe deletion. Quarantine it durably for inspection.
		if _, err := r.db.Exec(ctx, `UPDATE storage_objects
			SET status='status_gc_rejected',delete_token=NULL,
				delete_error='object key is outside the account status scope',
				next_delete_at=NULL,updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND source='whatsapp_status'`, accountID, objectKey); err != nil {
			return nil, err
		}
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var assetID uuid.UUID
	assetExists := true
	if err := tx.QueryRow(ctx, `SELECT id FROM media_assets
		WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, objectKey).Scan(&assetID); err != nil {
		if err != pgx.ErrNoRows {
			return nil, err
		}
		assetExists = false
	}
	var currentStatus string
	if err := tx.QueryRow(ctx, `
		SELECT status FROM storage_objects
		WHERE account_id=$1 AND object_key=$2
		  AND source='whatsapp_status'
		  AND (
			(status=$3 AND COALESCE(next_delete_at,updated_at)<=$5)
			OR (status=$4 AND updated_at<=$6)
		  )
		FOR UPDATE
	`, accountID, objectKey, whatsappStatusMediaGCPending, whatsappStatusMediaGCDeleting,
		now, now.Add(-whatsappStatusMediaGCLease)).Scan(&currentStatus); err != nil {
		if err == pgx.ErrNoRows {
			return nil, tx.Commit(ctx)
		}
		return nil, err
	}
	proxyURL := "/api/media/file/" + objectKey
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM whatsapp_statuses ws
		WHERE ws.account_id=$1
		  AND (($3 AND ws.media_asset_id=$2) OR ws.media_url=$4
		       OR RIGHT(COALESCE(ws.media_url,''),LENGTH($5)+1)='/' || $5)
		UNION ALL
		SELECT 1 FROM messages m
		WHERE m.account_id=$1
		  AND (($3 AND m.media_asset_id=$2) OR m.media_url=$4
		       OR RIGHT(COALESCE(m.media_url,''),LENGTH($5)+1)='/' || $5)
		  AND COALESCE(m.media_deleted,false)=false
	)`, accountID, assetID, assetExists, proxyURL, objectKey).Scan(&referenced); err != nil {
		return nil, err
	}
	if referenced {
		if assetExists {
			if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
				WHERE account_id=$1 AND id=$2`, accountID, assetID); err != nil {
				return nil, err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects
			SET status='active',delete_token=NULL,delete_error='',next_delete_at=NULL,deleted_at=NULL,updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2`, accountID, objectKey); err != nil {
			return nil, err
		}
		return nil, tx.Commit(ctx)
	}
	token := uuid.New()
	if _, err := tx.Exec(ctx, `UPDATE storage_objects
		SET status=$3,delete_token=$4,delete_attempts=delete_attempts+1,
			delete_error='',next_delete_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2`, accountID, objectKey, whatsappStatusMediaGCDeleting, token); err != nil {
		return nil, err
	}
	if assetExists {
		if _, err := tx.Exec(ctx, `UPDATE media_assets SET status=$3,updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, accountID, assetID, whatsappStatusMediaGCDeleting); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &PendingWhatsAppStatusMediaCleanup{AccountID: accountID, ObjectKey: objectKey, Token: token}, nil
}

func (r *WhatsAppStatusRepository) FinalizeMediaCleanup(ctx context.Context, item PendingWhatsAppStatusMediaCleanup, deleteErr error, now time.Time) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var assetID uuid.UUID
	assetExists := true
	if err := tx.QueryRow(ctx, `SELECT id FROM media_assets
		WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, item.AccountID, item.ObjectKey).Scan(&assetID); err != nil {
		if err != pgx.ErrNoRows {
			return err
		}
		assetExists = false
	}
	var attempts int
	if err := tx.QueryRow(ctx, `SELECT delete_attempts FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 AND status=$3 AND delete_token=$4
		FOR UPDATE`, item.AccountID, item.ObjectKey, whatsappStatusMediaGCDeleting, item.Token).Scan(&attempts); err != nil {
		if err == pgx.ErrNoRows {
			return tx.Commit(ctx)
		}
		return err
	}
	if deleteErr != nil {
		retryDelay := time.Minute * time.Duration(1<<min(attempts, 6))
		if _, err := tx.Exec(ctx, `UPDATE storage_objects
			SET status=$3,delete_token=NULL,delete_error=$4,next_delete_at=$5,updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2`, item.AccountID, item.ObjectKey,
			whatsappStatusMediaGCPending, deleteErr.Error(), now.Add(retryDelay)); err != nil {
			return err
		}
		if assetExists {
			if _, err := tx.Exec(ctx, `UPDATE media_assets SET status=$3,updated_at=NOW()
				WHERE account_id=$1 AND id=$2`, item.AccountID, assetID, whatsappStatusMediaGCPending); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects
		SET status='deleted',delete_token=NULL,delete_error='',next_delete_at=NULL,
			deleted_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2`, item.AccountID, item.ObjectKey); err != nil {
		return err
	}
	if assetExists {
		if _, err := tx.Exec(ctx, `UPDATE media_assets
			SET status='deleted',deleted_at=NOW(),updated_at=NOW()
			WHERE account_id=$1 AND id=$2`, item.AccountID, assetID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
