package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type WhiteboardRevisionAssetListOptions struct {
	AfterCreatedAt *time.Time
	AfterID        *uuid.UUID
	Limit          int
}

func (r *WhiteboardRepository) ListRevisionAssets(ctx context.Context, accountID, actorID, boardID, revisionID uuid.UUID, options WhiteboardRevisionAssetListOptions) ([]*domain.WhiteboardAsset, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT revision_asset.id,revision_asset.account_id,revision_asset.board_id,NULL::uuid,
		revision_asset.media_asset_id,revision_asset.file_id,'asset',asset.filename,asset.content_type,
		asset.media_type,asset.size_bytes,NULL::uuid,NULL::uuid,revision_asset.created_at,NULL::timestamptz,revision_asset.created_at
		FROM whiteboard_revision_assets revision_asset
		JOIN whiteboard_revisions revision ON revision.account_id=revision_asset.account_id
			AND revision.board_id=revision_asset.board_id AND revision.id=revision_asset.revision_id
		JOIN media_assets asset ON asset.account_id=revision_asset.account_id
			AND asset.id=revision_asset.media_asset_id AND asset.status<>'deleted'
		WHERE revision_asset.account_id=$1 AND revision_asset.board_id=$2 AND revision_asset.revision_id=$3
		AND ($4::timestamptz IS NULL OR (revision_asset.created_at,revision_asset.id)>($4::timestamptz,$5::uuid))
		ORDER BY revision_asset.created_at,revision_asset.id LIMIT $6`, accountID, boardID, revisionID,
		options.AfterCreatedAt, options.AfterID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardAsset, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardAsset(rows)
		if scanErr != nil {
			return nil, false, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return items, hasMore, nil
}

func (r *WhiteboardRepository) ResolveRevisionAssetDownload(ctx context.Context, accountID, actorID, boardID, revisionID, revisionAssetID uuid.UUID) (*WhiteboardAssetDownload, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item := &WhiteboardAssetDownload{}
	err := r.db.QueryRow(ctx, `SELECT asset.object_key,asset.filename,asset.content_type
		FROM whiteboard_revision_assets revision_asset
		JOIN whiteboard_revisions revision ON revision.account_id=revision_asset.account_id
			AND revision.board_id=revision_asset.board_id AND revision.id=revision_asset.revision_id
		JOIN media_assets asset ON asset.account_id=revision_asset.account_id
			AND asset.id=revision_asset.media_asset_id AND asset.status<>'deleted'
		WHERE revision_asset.account_id=$1 AND revision_asset.board_id=$2
			AND revision_asset.revision_id=$3 AND revision_asset.id=$4`, accountID, boardID, revisionID, revisionAssetID).Scan(
		&item.ObjectKey, &item.Filename, &item.ContentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}
