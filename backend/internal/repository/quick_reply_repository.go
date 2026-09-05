package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrQuickReplyNotFound     = errors.New("quick reply not found")
	ErrQuickReplyConflict     = errors.New("quick reply conflict")
	ErrQuickReplyShortcut     = errors.New("quick reply shortcut already exists")
	ErrQuickReplyInvalidMedia = errors.New("quick reply media does not belong to account")
)

type QuickReplyListFilter struct {
	Search        string
	Kind          string
	Limit         int
	AfterShortcut string
	AfterID       uuid.UUID
}

type QuickReplyListResult struct {
	Replies []*domain.QuickReply
	Total   int
	HasMore bool
}

func (r *QuickReplyRepository) List(ctx context.Context, accountID uuid.UUID, filter QuickReplyListFilter) (*QuickReplyListResult, error) {
	search := strings.TrimSpace(filter.Search)
	kind := strings.TrimSpace(strings.ToLower(filter.Kind))
	if kind == "" {
		kind = "all"
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}

	var total int
	if err := r.db.QueryRow(ctx, `
		SELECT COUNT(*)
		FROM quick_replies qr
		WHERE qr.account_id = $1
		  AND ($2 = '' OR qr.shortcut ILIKE '%' || $2 || '%' OR qr.title ILIKE '%' || $2 || '%' OR qr.body ILIKE '%' || $2 || '%')
		  AND (
			$3 = 'all'
			OR ($3 = 'text' AND NOT EXISTS (SELECT 1 FROM quick_reply_attachments qra WHERE qra.quick_reply_id = qr.id AND qra.account_id = qr.account_id))
			OR ($3 = 'media' AND EXISTS (SELECT 1 FROM quick_reply_attachments qra WHERE qra.quick_reply_id = qr.id AND qra.account_id = qr.account_id))
		  )
	`, accountID, search, kind).Scan(&total); err != nil {
		return nil, fmt.Errorf("count quick replies: %w", err)
	}

	rows, err := r.db.Query(ctx, `
		SELECT qr.id, qr.account_id, qr.shortcut, qr.title, qr.body,
		       qr.media_url, qr.media_type, qr.media_filename, qr.created_at, qr.updated_at
		FROM quick_replies qr
		WHERE qr.account_id = $1
		  AND ($2 = '' OR qr.shortcut ILIKE '%' || $2 || '%' OR qr.title ILIKE '%' || $2 || '%' OR qr.body ILIKE '%' || $2 || '%')
		  AND (
			$3 = 'all'
			OR ($3 = 'text' AND NOT EXISTS (SELECT 1 FROM quick_reply_attachments qra WHERE qra.quick_reply_id = qr.id AND qra.account_id = qr.account_id))
			OR ($3 = 'media' AND EXISTS (SELECT 1 FROM quick_reply_attachments qra WHERE qra.quick_reply_id = qr.id AND qra.account_id = qr.account_id))
		  )
		  AND ($4 = '' OR (LOWER(qr.shortcut), qr.id) > (LOWER($4), $5))
		ORDER BY LOWER(qr.shortcut), qr.id
		LIMIT $6
	`, accountID, search, kind, filter.AfterShortcut, filter.AfterID, limit+1)
	if err != nil {
		return nil, fmt.Errorf("list quick replies: %w", err)
	}
	defer rows.Close()

	replies := make([]*domain.QuickReply, 0, limit+1)
	for rows.Next() {
		quickReply := &domain.QuickReply{}
		if err := rows.Scan(
			&quickReply.ID,
			&quickReply.AccountID,
			&quickReply.Shortcut,
			&quickReply.Title,
			&quickReply.Body,
			&quickReply.MediaURL,
			&quickReply.MediaType,
			&quickReply.MediaFilename,
			&quickReply.CreatedAt,
			&quickReply.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan quick reply: %w", err)
		}
		replies = append(replies, quickReply)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate quick replies: %w", err)
	}

	hasMore := len(replies) > limit
	if hasMore {
		replies = replies[:limit]
	}
	attachmentsByReply, err := r.loadAttachmentsForReplies(ctx, accountID, replies)
	if err != nil {
		return nil, err
	}
	for _, quickReply := range replies {
		quickReply.Attachments = attachmentsByReply[quickReply.ID]
	}

	return &QuickReplyListResult{Replies: replies, Total: total, HasMore: hasMore}, nil
}

func (r *QuickReplyRepository) GetByID(ctx context.Context, accountID, id uuid.UUID) (*domain.QuickReply, error) {
	quickReply := &domain.QuickReply{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, shortcut, title, body,
		       media_url, media_type, media_filename, created_at, updated_at
		FROM quick_replies
		WHERE account_id = $1 AND id = $2
	`, accountID, id).Scan(
		&quickReply.ID,
		&quickReply.AccountID,
		&quickReply.Shortcut,
		&quickReply.Title,
		&quickReply.Body,
		&quickReply.MediaURL,
		&quickReply.MediaType,
		&quickReply.MediaFilename,
		&quickReply.CreatedAt,
		&quickReply.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrQuickReplyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get quick reply: %w", err)
	}

	quickReply.Attachments, err = r.loadAttachments(ctx, accountID, id)
	if err != nil {
		return nil, err
	}
	return quickReply, nil
}

func (r *QuickReplyRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) ([]*domain.QuickReply, error) {
	result, err := r.List(ctx, accountID, QuickReplyListFilter{Limit: 200})
	if err != nil {
		return nil, err
	}
	return result.Replies, nil
}

func (r *QuickReplyRepository) Create(ctx context.Context, quickReply *domain.QuickReply) (*domain.QuickReply, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin quick reply create: %w", err)
	}
	defer tx.Rollback(ctx)

	quickReply.ID = uuid.New()
	if err := tx.QueryRow(ctx, `
		INSERT INTO quick_replies (id, account_id, shortcut, title, body, media_url, media_type, media_filename)
		VALUES ($1, $2, $3, $4, $5, '', '', '')
		RETURNING created_at, updated_at
	`, quickReply.ID, quickReply.AccountID, quickReply.Shortcut, quickReply.Title, quickReply.Body).Scan(&quickReply.CreatedAt, &quickReply.UpdatedAt); err != nil {
		return nil, mapQuickReplyWriteError("insert quick reply", err)
	}

	canonical, err := r.replaceAttachmentsTx(ctx, tx, quickReply, nil)
	if err != nil {
		return nil, err
	}
	quickReply.Attachments = canonical
	applyLegacyMediaMirror(quickReply)
	if err := updateLegacyMediaMirrorTx(ctx, tx, quickReply); err != nil {
		return nil, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, mapQuickReplyWriteError("commit quick reply create", err)
	}
	return quickReply, nil
}

func (r *QuickReplyRepository) Update(ctx context.Context, accountID uuid.UUID, expectedUpdatedAt time.Time, quickReply *domain.QuickReply) (*domain.QuickReply, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin quick reply update: %w", err)
	}
	defer tx.Rollback(ctx)

	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
		SELECT updated_at
		FROM quick_replies
		WHERE account_id = $1 AND id = $2
		FOR UPDATE
	`, accountID, quickReply.ID).Scan(&currentUpdatedAt); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrQuickReplyNotFound
	} else if err != nil {
		return nil, fmt.Errorf("lock quick reply: %w", err)
	}
	if !sameDatabaseTime(currentUpdatedAt, expectedUpdatedAt) {
		return nil, ErrQuickReplyConflict
	}

	oldAssetIDs, err := quickReplyAssetIDsTx(ctx, tx, accountID, quickReply.ID)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE quick_replies
		SET shortcut = $3, title = $4, body = $5, updated_at = NOW()
		WHERE account_id = $1 AND id = $2
	`, accountID, quickReply.ID, quickReply.Shortcut, quickReply.Title, quickReply.Body); err != nil {
		return nil, mapQuickReplyWriteError("update quick reply", err)
	}

	quickReply.AccountID = accountID
	canonical, err := r.replaceAttachmentsTx(ctx, tx, quickReply, oldAssetIDs)
	if err != nil {
		return nil, err
	}
	quickReply.Attachments = canonical
	applyLegacyMediaMirror(quickReply)
	if err := updateLegacyMediaMirrorTx(ctx, tx, quickReply); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
		SELECT created_at, updated_at
		FROM quick_replies
		WHERE account_id = $1 AND id = $2
	`, accountID, quickReply.ID).Scan(&quickReply.CreatedAt, &quickReply.UpdatedAt); err != nil {
		return nil, fmt.Errorf("reload quick reply timestamps: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, mapQuickReplyWriteError("commit quick reply update", err)
	}
	return quickReply, nil
}

func (r *QuickReplyRepository) Delete(ctx context.Context, accountID, id uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin quick reply delete: %w", err)
	}
	defer tx.Rollback(ctx)

	assetIDs, err := quickReplyAssetIDsTx(ctx, tx, accountID, id)
	if err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `DELETE FROM quick_replies WHERE account_id = $1 AND id = $2`, accountID, id)
	if err != nil {
		return fmt.Errorf("delete quick reply: %w", err)
	}
	if command.RowsAffected() == 0 {
		return ErrQuickReplyNotFound
	}
	if err := scheduleUnreferencedDraftsTx(ctx, tx, accountID, assetIDs); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit quick reply delete: %w", err)
	}
	return nil
}

func (r *QuickReplyRepository) GetAttachmentForSend(ctx context.Context, accountID, quickReplyID, attachmentID uuid.UUID) (*domain.QuickReplyAttachment, error) {
	attachment := &domain.QuickReplyAttachment{}
	err := r.db.QueryRow(ctx, `
		SELECT qra.id, qra.quick_reply_id, qra.account_id, qra.media_asset_id,
		       '/api/media/file/' || ma.object_key, qra.media_type, qra.media_filename, qra.caption, qra.position
		FROM quick_reply_attachments qra
		JOIN quick_replies qr ON qr.id = qra.quick_reply_id AND qr.account_id = qra.account_id
		JOIN media_assets ma ON ma.id = qra.media_asset_id AND ma.account_id = qra.account_id AND ma.status = 'active'
		WHERE qra.account_id = $1 AND qra.quick_reply_id = $2 AND qra.id = $3
	`, accountID, quickReplyID, attachmentID).Scan(
		&attachment.ID,
		&attachment.QuickReplyID,
		&attachment.AccountID,
		&attachment.MediaAssetID,
		&attachment.MediaURL,
		&attachment.MediaType,
		&attachment.MediaFilename,
		&attachment.Caption,
		&attachment.Position,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrQuickReplyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("resolve quick reply attachment: %w", err)
	}
	return attachment, nil
}

func (r *QuickReplyRepository) ReleaseDraftMedia(ctx context.Context, accountID, assetID uuid.UUID) error {
	command, err := r.db.Exec(ctx, `
		UPDATE storage_objects so
		SET source = 'quick-reply-drafts', next_delete_at = NOW(), updated_at = NOW()
		FROM media_assets ma
		WHERE ma.id = $2
		  AND ma.account_id = $1
		  AND ma.object_key = so.object_key
		  AND NOT EXISTS (
			SELECT 1 FROM quick_reply_attachments qra
			WHERE qra.account_id = $1 AND qra.media_asset_id = $2
		  )
	`, accountID, assetID)
	if err != nil {
		return fmt.Errorf("release quick reply draft: %w", err)
	}
	if command.RowsAffected() == 0 {
		var exists bool
		if err := r.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM media_assets WHERE account_id = $1 AND id = $2)`, accountID, assetID).Scan(&exists); err != nil {
			return fmt.Errorf("check quick reply draft: %w", err)
		}
		if !exists {
			return ErrQuickReplyInvalidMedia
		}
	}
	return nil
}

func (r *QuickReplyRepository) loadAttachments(ctx context.Context, accountID, quickReplyID uuid.UUID) ([]domain.QuickReplyAttachment, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, quick_reply_id, account_id, media_asset_id, media_url, media_type, media_filename, caption, position
		FROM quick_reply_attachments
		WHERE account_id = $1 AND quick_reply_id = $2
		ORDER BY position, id
	`, accountID, quickReplyID)
	if err != nil {
		return nil, fmt.Errorf("list quick reply attachments: %w", err)
	}
	defer rows.Close()

	attachments := make([]domain.QuickReplyAttachment, 0)
	for rows.Next() {
		attachment := domain.QuickReplyAttachment{}
		if err := rows.Scan(
			&attachment.ID,
			&attachment.QuickReplyID,
			&attachment.AccountID,
			&attachment.MediaAssetID,
			&attachment.MediaURL,
			&attachment.MediaType,
			&attachment.MediaFilename,
			&attachment.Caption,
			&attachment.Position,
		); err != nil {
			return nil, fmt.Errorf("scan quick reply attachment: %w", err)
		}
		attachments = append(attachments, attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate quick reply attachments: %w", err)
	}
	return attachments, nil
}

func (r *QuickReplyRepository) loadAttachmentsForReplies(ctx context.Context, accountID uuid.UUID, quickReplies []*domain.QuickReply) (map[uuid.UUID][]domain.QuickReplyAttachment, error) {
	attachmentsByReply := make(map[uuid.UUID][]domain.QuickReplyAttachment, len(quickReplies))
	if len(quickReplies) == 0 {
		return attachmentsByReply, nil
	}

	quickReplyIDs := make([]uuid.UUID, 0, len(quickReplies))
	for _, quickReply := range quickReplies {
		quickReplyIDs = append(quickReplyIDs, quickReply.ID)
		attachmentsByReply[quickReply.ID] = make([]domain.QuickReplyAttachment, 0)
	}

	rows, err := r.db.Query(ctx, `
		SELECT id, quick_reply_id, account_id, media_asset_id, media_url, media_type, media_filename, caption, position
		FROM quick_reply_attachments
		WHERE account_id = $1 AND quick_reply_id = ANY($2)
		ORDER BY quick_reply_id, position, id
	`, accountID, quickReplyIDs)
	if err != nil {
		return nil, fmt.Errorf("list quick reply attachments: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		attachment := domain.QuickReplyAttachment{}
		if err := rows.Scan(
			&attachment.ID,
			&attachment.QuickReplyID,
			&attachment.AccountID,
			&attachment.MediaAssetID,
			&attachment.MediaURL,
			&attachment.MediaType,
			&attachment.MediaFilename,
			&attachment.Caption,
			&attachment.Position,
		); err != nil {
			return nil, fmt.Errorf("scan quick reply attachment: %w", err)
		}
		attachmentsByReply[attachment.QuickReplyID] = append(attachmentsByReply[attachment.QuickReplyID], attachment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate quick reply attachments: %w", err)
	}
	return attachmentsByReply, nil
}

func (r *QuickReplyRepository) replaceAttachmentsTx(ctx context.Context, tx pgx.Tx, quickReply *domain.QuickReply, oldAssetIDs []uuid.UUID) ([]domain.QuickReplyAttachment, error) {
	canonical := make([]domain.QuickReplyAttachment, 0, len(quickReply.Attachments))
	for position, requested := range quickReply.Attachments {
		attachment, err := canonicalizeQuickReplyAttachmentTx(ctx, tx, quickReply.AccountID, quickReply.ID, requested, position)
		if err != nil {
			return nil, err
		}
		canonical = append(canonical, attachment)
	}

	if _, err := tx.Exec(ctx, `DELETE FROM quick_reply_attachments WHERE account_id = $1 AND quick_reply_id = $2`, quickReply.AccountID, quickReply.ID); err != nil {
		return nil, fmt.Errorf("delete old quick reply attachments: %w", err)
	}
	for _, attachment := range canonical {
		if _, err := tx.Exec(ctx, `
			INSERT INTO quick_reply_attachments (
				id, quick_reply_id, account_id, media_asset_id, media_url, media_type, media_filename, caption, position
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		`, attachment.ID, attachment.QuickReplyID, attachment.AccountID, attachment.MediaAssetID, attachment.MediaURL, attachment.MediaType, attachment.MediaFilename, attachment.Caption, attachment.Position); err != nil {
			return nil, mapQuickReplyWriteError("insert quick reply attachment", err)
		}
		if attachment.MediaAssetID != nil {
			if _, err := tx.Exec(ctx, `
				UPDATE storage_objects so
				SET source = 'quick_reply', status = 'active', next_delete_at = NULL, updated_at = NOW()
				FROM media_assets ma
				WHERE ma.account_id = $1 AND ma.id = $2 AND ma.object_key = so.object_key
			`, quickReply.AccountID, *attachment.MediaAssetID); err != nil {
				return nil, fmt.Errorf("promote quick reply media: %w", err)
			}
		}
	}
	if err := scheduleUnreferencedDraftsTx(ctx, tx, quickReply.AccountID, oldAssetIDs); err != nil {
		return nil, err
	}
	return canonical, nil
}

func canonicalizeQuickReplyAttachmentTx(ctx context.Context, tx pgx.Tx, accountID, quickReplyID uuid.UUID, requested domain.QuickReplyAttachment, position int) (domain.QuickReplyAttachment, error) {
	if requested.MediaAssetID == nil || *requested.MediaAssetID == uuid.Nil {
		if requested.ID == uuid.Nil {
			return domain.QuickReplyAttachment{}, ErrQuickReplyInvalidMedia
		}
		legacy := domain.QuickReplyAttachment{}
		if err := tx.QueryRow(ctx, `
			SELECT id, quick_reply_id, account_id, media_asset_id, media_url, media_type, media_filename
			FROM quick_reply_attachments
			WHERE account_id = $1 AND quick_reply_id = $2 AND id = $3
			FOR SHARE
		`, accountID, quickReplyID, requested.ID).Scan(
			&legacy.ID,
			&legacy.QuickReplyID,
			&legacy.AccountID,
			&legacy.MediaAssetID,
			&legacy.MediaURL,
			&legacy.MediaType,
			&legacy.MediaFilename,
		); errors.Is(err, pgx.ErrNoRows) {
			return domain.QuickReplyAttachment{}, ErrQuickReplyInvalidMedia
		} else if err != nil {
			return domain.QuickReplyAttachment{}, fmt.Errorf("resolve legacy quick reply media: %w", err)
		}
		legacy.Caption = strings.TrimSpace(requested.Caption)
		legacy.Position = position
		return legacy, nil
	}

	var objectKey, mediaType, filename string
	if err := tx.QueryRow(ctx, `
		SELECT object_key, media_type, filename
		FROM media_assets
		WHERE account_id = $1 AND id = $2 AND status = 'active'
		FOR SHARE
	`, accountID, *requested.MediaAssetID).Scan(&objectKey, &mediaType, &filename); errors.Is(err, pgx.ErrNoRows) {
		return domain.QuickReplyAttachment{}, ErrQuickReplyInvalidMedia
	} else if err != nil {
		return domain.QuickReplyAttachment{}, fmt.Errorf("resolve quick reply media: %w", err)
	}

	attachmentID := requested.ID
	if attachmentID == uuid.Nil {
		attachmentID = uuid.New()
	}
	if strings.TrimSpace(requested.MediaType) != "" {
		mediaType = strings.TrimSpace(requested.MediaType)
	}
	if strings.TrimSpace(requested.MediaFilename) != "" {
		filename = strings.TrimSpace(requested.MediaFilename)
	}
	return domain.QuickReplyAttachment{
		ID:            attachmentID,
		QuickReplyID:  quickReplyID,
		AccountID:     accountID,
		MediaAssetID:  requested.MediaAssetID,
		MediaURL:      "/api/media/file/" + strings.TrimPrefix(objectKey, "/"),
		MediaType:     mediaType,
		MediaFilename: filename,
		Caption:       requested.Caption,
		Position:      position,
	}, nil
}

func quickReplyAssetIDsTx(ctx context.Context, tx pgx.Tx, accountID, quickReplyID uuid.UUID) ([]uuid.UUID, error) {
	rows, err := tx.Query(ctx, `
		SELECT media_asset_id
		FROM quick_reply_attachments
		WHERE account_id = $1 AND quick_reply_id = $2 AND media_asset_id IS NOT NULL
	`, accountID, quickReplyID)
	if err != nil {
		return nil, fmt.Errorf("list quick reply media ids: %w", err)
	}
	defer rows.Close()

	ids := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan quick reply media id: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate quick reply media ids: %w", err)
	}
	return ids, nil
}

func scheduleUnreferencedDraftsTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, assetIDs []uuid.UUID) error {
	if len(assetIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE storage_objects so
		SET source = 'quick-reply-drafts', next_delete_at = NOW() + INTERVAL '24 hours', updated_at = NOW()
		FROM media_assets ma
		WHERE ma.account_id = $1
		  AND ma.id = ANY($2)
		  AND ma.object_key = so.object_key
		  AND NOT EXISTS (
			SELECT 1 FROM quick_reply_attachments qra
			WHERE qra.account_id = $1 AND qra.media_asset_id = ma.id
		  )
	`, accountID, assetIDs); err != nil {
		return fmt.Errorf("schedule detached quick reply media: %w", err)
	}
	return nil
}

func applyLegacyMediaMirror(quickReply *domain.QuickReply) {
	quickReply.MediaURL = ""
	quickReply.MediaType = ""
	quickReply.MediaFilename = ""
	if len(quickReply.Attachments) == 0 {
		return
	}
	first := quickReply.Attachments[0]
	quickReply.MediaURL = first.MediaURL
	quickReply.MediaType = first.MediaType
	quickReply.MediaFilename = first.MediaFilename
}

func updateLegacyMediaMirrorTx(ctx context.Context, tx pgx.Tx, quickReply *domain.QuickReply) error {
	if _, err := tx.Exec(ctx, `
		UPDATE quick_replies
		SET media_url = $3, media_type = $4, media_filename = $5
		WHERE account_id = $1 AND id = $2
	`, quickReply.AccountID, quickReply.ID, quickReply.MediaURL, quickReply.MediaType, quickReply.MediaFilename); err != nil {
		return fmt.Errorf("update quick reply media mirror: %w", err)
	}
	return nil
}

func mapQuickReplyWriteError(operation string, err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" && postgresError.ConstraintName == "uq_quick_replies_account_shortcut_ci" {
		return ErrQuickReplyShortcut
	}
	return fmt.Errorf("%s: %w", operation, err)
}

func sameDatabaseTime(current, expected time.Time) bool {
	return current.UTC().Truncate(time.Microsecond).Equal(expected.UTC().Truncate(time.Microsecond))
}
