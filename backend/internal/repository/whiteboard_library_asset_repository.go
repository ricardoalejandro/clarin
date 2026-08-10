package repository

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

type whiteboardLibraryLinkedAsset struct {
	mediaAssetID uuid.UUID
	committed    bool
}

func classifyWhiteboardLibraryAssetReconciliation(liveFileIDs []string, linked map[string]whiteboardLibraryLinkedAsset) (map[uuid.UUID]struct{}, error) {
	live := make(map[string]struct{}, len(liveFileIDs))
	for _, fileID := range liveFileIDs {
		if _, exists := linked[fileID]; !exists {
			return nil, ErrWhiteboardInvalid
		}
		live[fileID] = struct{}{}
	}
	removed := make(map[uuid.UUID]struct{})
	for fileID, asset := range linked {
		if _, keep := live[fileID]; !keep && asset.committed {
			removed[asset.mediaAssetID] = struct{}{}
		}
	}
	return removed, nil
}

func whiteboardLibraryAssetDraftVisible(accessLevel string) bool {
	return whiteboardAccessRank(accessLevel) >= whiteboardAccessRank(domain.WhiteboardAccessEdit)
}

func reconcileWhiteboardLibraryAssetsTx(ctx context.Context, tx pgx.Tx, accountID, libraryID uuid.UUID, libraryJSON []byte) error {
	liveFileIDs, err := whiteboardcore.ReferencedLibraryFileIDs(libraryJSON)
	if err != nil {
		return ErrWhiteboardInvalid
	}
	rows, err := tx.Query(ctx, `SELECT file_id,media_asset_id,committed_at IS NOT NULL
		FROM whiteboard_assets WHERE account_id=$1 AND library_id=$2 AND kind='asset' FOR UPDATE`, accountID, libraryID)
	if err != nil {
		return err
	}
	linked := make(map[string]whiteboardLibraryLinkedAsset)
	for rows.Next() {
		var fileID string
		var mediaAssetID uuid.UUID
		var committed bool
		if err := rows.Scan(&fileID, &mediaAssetID, &committed); err != nil {
			rows.Close()
			return err
		}
		linked[fileID] = whiteboardLibraryLinkedAsset{mediaAssetID: mediaAssetID, committed: committed}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	removed, err := classifyWhiteboardLibraryAssetReconciliation(liveFileIDs, linked)
	if err != nil {
		return err
	}
	if len(liveFileIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_assets
			SET committed_at=COALESCE(committed_at,NOW()),draft_expires_at=NULL
			WHERE account_id=$1 AND library_id=$2 AND kind='asset' AND file_id=ANY($3::text[])`,
			accountID, libraryID, liveFileIDs); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
		WHERE account_id=$1 AND library_id=$2 AND kind='asset' AND committed_at IS NOT NULL
		AND NOT (file_id=ANY($3::text[]))`, accountID, libraryID, liveFileIDs); err != nil {
		return err
	}
	for mediaAssetID := range removed {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
			return err
		}
	}
	return nil
}

// AttachLibraryAsset registers a validated, already inventoried upload as a
// one-hour draft. UpdateLibrary is the only operation that can promote it to a
// durable library reference.
func (r *WhiteboardRepository) AttachLibraryAsset(ctx context.Context, accountID, actorID, libraryID, assetID uuid.UUID, fileID string) (*domain.WhiteboardAsset, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || libraryID == uuid.Nil || assetID == uuid.Nil || !whiteboardcore.ValidAssetFileID(fileID) {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state, err := requireWhiteboardLibraryMutationAccessTx(ctx, tx, accountID, actorID, libraryID, domain.WhiteboardAccessEdit)
	if err != nil {
		return nil, err
	}
	if state.ArchivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	var status, objectKey string
	if err := tx.QueryRow(ctx, `SELECT status,object_key FROM media_assets
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, assetID).Scan(&status, &objectKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if status != "active" && status != "whiteboard_upload_pending" {
		return nil, ErrWhiteboardInvalid
	}
	var existingLinkID, replacedAssetID uuid.UUID
	var existingCommitted bool
	existingErr := tx.QueryRow(ctx, `SELECT id,media_asset_id,committed_at IS NOT NULL
		FROM whiteboard_assets WHERE account_id=$1 AND library_id=$2 AND file_id=$3 AND kind='asset'
		FOR UPDATE`, accountID, libraryID, fileID).Scan(&existingLinkID, &replacedAssetID, &existingCommitted)
	if existingErr != nil && !errors.Is(existingErr, pgx.ErrNoRows) {
		return nil, existingErr
	}
	if existingErr == nil && replacedAssetID == assetID {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.getLibraryAssetRecord(ctx, accountID, libraryID, existingLinkID)
	}
	if existingErr == nil && existingCommitted {
		referenced, referenceErr := whiteboardcore.ReferencedLibraryFileIDs(state.LibraryJSON)
		if referenceErr != nil {
			return nil, ErrWhiteboardInvalid
		}
		for _, referencedFileID := range referenced {
			if referencedFileID == fileID {
				// Replacing bytes behind an already-live file ID would mutate the
				// published library before its optimistic JSON update commits.
				return nil, ErrWhiteboardConflict
			}
		}
	}
	if existingErr == nil {
		if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
			WHERE account_id=$1 AND library_id=$2 AND id=$3`, accountID, libraryID, existingLinkID); err != nil {
			return nil, err
		}
	}
	linkID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,library_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at
	) VALUES($1,$2,NULL,$3,$4,$5,'asset',$6,NULL,NOW()+INTERVAL '1 hour')`,
		linkID, accountID, libraryID, assetID, fileID, actorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, assetID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, objectKey); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs
		WHERE account_id=$1 AND media_asset_id=$2`, accountID, assetID); err != nil {
		return nil, err
	}
	if existingErr == nil && replacedAssetID != assetID {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, replacedAssetID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getLibraryAssetRecord(ctx, accountID, libraryID, linkID)
}

func (r *WhiteboardRepository) getLibraryAssetRecord(ctx context.Context, accountID, libraryID, assetLinkID uuid.UUID) (*domain.WhiteboardAsset, error) {
	item, err := scanWhiteboardAsset(r.db.QueryRow(ctx, `SELECT `+whiteboardAssetColumns+`
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.library_id=$2 AND link.id=$3`, accountID, libraryID, assetLinkID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) ListLibraryAssets(ctx context.Context, accountID, actorID, libraryID uuid.UUID, options WhiteboardAssetListOptions) ([]*domain.WhiteboardAsset, bool, error) {
	level, err := r.resolveLibraryAccess(ctx, accountID, actorID, libraryID)
	if err != nil {
		return nil, false, err
	}
	includeDrafts := whiteboardLibraryAssetDraftVisible(level)
	var libraryJSON json.RawMessage
	if options.ReferencedOnly {
		if err := r.db.QueryRow(ctx, `SELECT library_json FROM whiteboard_libraries
			WHERE account_id=$1 AND id=$2`, accountID, libraryID).Scan(&libraryJSON); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, false, ErrWhiteboardNotFound
			}
			return nil, false, err
		}
	}
	referencedFileIDs, err := whiteboardReferencedAssetFileIDs(libraryJSON, options.ReferencedOnly, true)
	if err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardAssetColumns+`
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.library_id=$2 AND link.kind='asset'
		AND ($3::boolean OR link.committed_at IS NOT NULL)
		AND ($4::timestamptz IS NULL OR (link.created_at,link.id)>($4::timestamptz,$5::uuid))
		AND ($6::boolean=FALSE OR link.file_id=ANY($7::text[]))
		ORDER BY link.created_at,link.id LIMIT $8`, accountID, libraryID, includeDrafts,
		options.AfterCreatedAt, options.AfterID, options.ReferencedOnly, referencedFileIDs, limit+1)
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

func (r *WhiteboardRepository) ResolveLibraryAssetDownload(ctx context.Context, accountID, actorID, libraryID, assetLinkID uuid.UUID) (*WhiteboardAssetDownload, error) {
	level, err := r.resolveLibraryAccess(ctx, accountID, actorID, libraryID)
	if err != nil {
		return nil, err
	}
	includeDrafts := whiteboardLibraryAssetDraftVisible(level)
	item := &WhiteboardAssetDownload{}
	err = r.db.QueryRow(ctx, `SELECT asset.object_key,asset.filename,asset.content_type
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.library_id=$2 AND link.id=$3 AND link.kind='asset'
		AND ($4::boolean OR link.committed_at IS NOT NULL)`, accountID, libraryID, assetLinkID, includeDrafts).Scan(
		&item.ObjectKey, &item.Filename, &item.ContentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) DeleteLibraryAsset(ctx context.Context, accountID, actorID, libraryID, assetLinkID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	state, err := requireWhiteboardLibraryMutationAccessTx(ctx, tx, accountID, actorID, libraryID, domain.WhiteboardAccessEdit)
	if err != nil {
		return err
	}
	if state.ArchivedAt != nil {
		return ErrWhiteboardConflict
	}
	var mediaAssetID uuid.UUID
	var fileID string
	if err := tx.QueryRow(ctx, `SELECT media_asset_id,file_id FROM whiteboard_assets
		WHERE account_id=$1 AND library_id=$2 AND id=$3 AND kind='asset' FOR UPDATE`,
		accountID, libraryID, assetLinkID).Scan(&mediaAssetID, &fileID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	referencedFileIDs, err := whiteboardcore.ReferencedLibraryFileIDs(state.LibraryJSON)
	if err != nil {
		return ErrWhiteboardInvalid
	}
	for _, referencedFileID := range referencedFileIDs {
		if referencedFileID == fileID {
			return ErrWhiteboardConflict
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
		WHERE account_id=$1 AND library_id=$2 AND id=$3`, accountID, libraryID, assetLinkID); err != nil {
		return err
	}
	if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
