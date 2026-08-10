package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func whiteboardAssetReservationBlocked(status string) bool {
	return status == "whiteboard_gc_deleting"
}

func whiteboardAssetReservationReusesObject(status string) bool {
	return status == "active" || status == "whiteboard_upload_pending" || status == "whiteboard_gc_pending"
}

func reconcileWhiteboardSceneAssetsTx(ctx context.Context, tx pgx.Tx, accountID, boardID uuid.UUID, scene []byte) error {
	liveFileIDs, err := whiteboardcore.ReferencedFileIDs(scene)
	if err != nil {
		return ErrWhiteboardInvalid
	}
	type linkedAsset struct {
		mediaAssetID uuid.UUID
		committed    bool
	}
	rows, err := tx.Query(ctx, `SELECT file_id,media_asset_id,committed_at IS NOT NULL FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset' FOR UPDATE`, accountID, boardID)
	if err != nil {
		return err
	}
	linked := make(map[string]linkedAsset)
	for rows.Next() {
		var fileID string
		var mediaAssetID uuid.UUID
		var committed bool
		if err := rows.Scan(&fileID, &mediaAssetID, &committed); err != nil {
			rows.Close()
			return err
		}
		linked[fileID] = linkedAsset{mediaAssetID: mediaAssetID, committed: committed}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	live := make(map[string]struct{}, len(liveFileIDs))
	for _, fileID := range liveFileIDs {
		if _, exists := linked[fileID]; !exists {
			return ErrWhiteboardInvalid
		}
		live[fileID] = struct{}{}
	}
	removed := make(map[uuid.UUID]struct{})
	for fileID, asset := range linked {
		if _, keep := live[fileID]; !keep && asset.committed {
			removed[asset.mediaAssetID] = struct{}{}
		}
	}
	if len(liveFileIDs) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE whiteboard_assets SET committed_at=COALESCE(committed_at,NOW()),draft_expires_at=NULL
			WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND file_id=ANY($3::text[])`, accountID, boardID, liveFileIDs); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND committed_at IS NOT NULL
		AND ($3::text[] IS NULL OR NOT (file_id=ANY($3::text[])))`, accountID, boardID, liveFileIDs); err != nil {
		return err
	}
	for mediaAssetID := range removed {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
			return err
		}
	}
	return nil
}

func (r *WhiteboardRepository) ReserveWhiteboardAsset(ctx context.Context, input MediaAssetUpsert) (*domain.MediaAsset, bool, error) {
	if !strings.HasPrefix(input.ContentHash, domain.MediaAssetHashWhiteboardPrefix) ||
		!storage.IsAccountWhiteboardObjectKey(input.AccountID, input.ObjectKey) || input.SizeBytes <= 0 {
		return nil, false, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var existingStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM media_assets
		WHERE account_id=$1 AND content_hash=$2 FOR UPDATE`, input.AccountID, input.ContentHash).Scan(&existingStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, false, err
	}
	if whiteboardAssetReservationBlocked(existingStatus) {
		return nil, false, ErrWhiteboardUploadInProgress
	}
	asset := &domain.MediaAsset{}
	err = tx.QueryRow(ctx, `INSERT INTO media_assets(
		account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at
	) VALUES($1,$2,$3,$4,$5,$6,$7,'whiteboard_upload_pending',NOW())
	ON CONFLICT(account_id,content_hash) DO UPDATE SET
		object_key=CASE WHEN media_assets.status IN ('active','whiteboard_upload_pending','whiteboard_gc_pending') THEN media_assets.object_key ELSE EXCLUDED.object_key END,
		media_type=CASE WHEN media_assets.status IN ('active','whiteboard_upload_pending','whiteboard_gc_pending') THEN media_assets.media_type ELSE EXCLUDED.media_type END,
		content_type=CASE WHEN media_assets.status IN ('active','whiteboard_upload_pending','whiteboard_gc_pending') THEN media_assets.content_type ELSE EXCLUDED.content_type END,
		filename=CASE WHEN media_assets.status IN ('active','whiteboard_upload_pending','whiteboard_gc_pending') THEN media_assets.filename ELSE EXCLUDED.filename END,
		size_bytes=CASE WHEN media_assets.status IN ('active','whiteboard_upload_pending','whiteboard_gc_pending') THEN media_assets.size_bytes ELSE EXCLUDED.size_bytes END,
		status=CASE WHEN media_assets.status='active' THEN 'active' ELSE 'whiteboard_upload_pending' END,
		deleted_at=NULL,updated_at=NOW()
	WHERE media_assets.status<>'whiteboard_gc_deleting'
	RETURNING id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,
		created_at,updated_at,deleted_at`, input.AccountID, input.ContentHash, input.ObjectKey,
		input.MediaType, input.ContentType, input.Filename, input.SizeBytes).Scan(
		&asset.ID, &asset.AccountID, &asset.ContentHash, &asset.ObjectKey, &asset.MediaType,
		&asset.ContentType, &asset.Filename, &asset.SizeBytes, &asset.Status,
		&asset.CreatedAt, &asset.UpdatedAt, &asset.DeletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		// Never reuse an object while a claimed worker may still be deleting its
		// bytes. Complete/retry will move it out of deleting first.
		return nil, false, ErrWhiteboardUploadInProgress
	}
	if err != nil {
		return nil, false, err
	}
	if asset.Status == "active" {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return asset, false, nil
	}
	if asset.ObjectKey != input.ObjectKey && existingStatus != "whiteboard_gc_pending" {
		return nil, false, ErrWhiteboardUploadInProgress
	}
	// A pending object may have been removed despite an ambiguous MinIO error.
	// Preserve its inventoried key but require a fresh upload before attachment.
	if err := reserveWhiteboardStorageQuotaTx(ctx, tx, input.AccountID, asset.ObjectKey, input.SizeBytes); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO storage_objects(
		account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at
	) VALUES($1,$2,$3,$4,$5,$6,'whiteboard_asset','whiteboard_upload_pending',NOW()+INTERVAL '1 hour',NOW())
	ON CONFLICT(account_id,object_key) DO UPDATE SET media_type=EXCLUDED.media_type,
		content_type=EXCLUDED.content_type,filename=EXCLUDED.filename,size_bytes=EXCLUDED.size_bytes,
		source='whiteboard_asset',status='whiteboard_upload_pending',deleted_at=NULL,
		next_delete_at=NOW()+INTERVAL '1 hour',updated_at=NOW()`, input.AccountID, asset.ObjectKey,
		asset.MediaType, asset.ContentType, asset.Filename, asset.SizeBytes); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_media_gc_jobs(account_id,media_asset_id,object_key,available_at,updated_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour',NOW())
		ON CONFLICT(account_id,media_asset_id) DO UPDATE SET object_key=EXCLUDED.object_key,
		status='pending',claim_token=NULL,last_error='',available_at=NOW()+INTERVAL '1 hour',updated_at=NOW()`,
		input.AccountID, asset.ID, asset.ObjectKey); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return asset, true, nil
}

func (r *WhiteboardRepository) MarkWhiteboardAssetUploadFailed(ctx context.Context, accountID, assetID uuid.UUID, cause string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_media_gc_jobs SET status='pending',claim_token=NULL,
		last_error=$3,available_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND media_asset_id=$2`,
		accountID, assetID, cause); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET next_delete_at=NOW(),delete_error=$3,updated_at=NOW()
		WHERE account_id=$1 AND object_key=(SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2)`,
		accountID, assetID, cause); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scheduleWhiteboardAssetGCTx(ctx context.Context, tx pgx.Tx, accountID, assetID uuid.UUID) error {
	var objectKey string
	err := tx.QueryRow(ctx, `SELECT asset.object_key FROM media_assets asset
		WHERE asset.account_id=$1 AND asset.id=$2
		AND NOT EXISTS(SELECT 1 FROM whiteboard_assets link WHERE link.account_id=asset.account_id AND link.media_asset_id=asset.id)
		AND NOT EXISTS(SELECT 1 FROM whiteboard_revision_assets revision_asset
			WHERE revision_asset.account_id=asset.account_id AND revision_asset.media_asset_id=asset.id)
		AND NOT EXISTS(SELECT 1 FROM whiteboards board WHERE board.account_id=asset.account_id AND board.thumbnail_media_asset_id=asset.id)
		FOR UPDATE`, accountID, assetID).Scan(&objectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Legacy/account media rows may predate storage_objects inventory. Backfill
	// the exact account-scoped key before creating the GC job so the composite
	// FK remains a guard instead of making scene reconciliation fail. No bytes
	// are deleted here; the worker still re-proves every live reference.
	if _, err := tx.Exec(ctx, `INSERT INTO storage_objects(
		account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at
	) SELECT asset.account_id,asset.object_key,
		COALESCE(NULLIF(asset.media_type,''),'other'),COALESCE(asset.content_type,''),COALESCE(asset.filename,''),
		GREATEST(COALESCE(asset.size_bytes,0),0),'whiteboard_asset','whiteboard_gc_pending',NOW()+INTERVAL '1 hour',NOW()
		FROM media_assets asset WHERE asset.account_id=$1 AND asset.id=$2 AND asset.object_key=$3
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='whiteboard_gc_pending',
		next_delete_at=NOW()+INTERVAL '1 hour',deleted_at=NULL,delete_token=NULL,delete_error='',updated_at=NOW()`,
		accountID, assetID, objectKey); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_media_gc_jobs(account_id,media_asset_id,object_key,available_at,updated_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour',NOW()) ON CONFLICT(account_id,media_asset_id)
		DO UPDATE SET object_key=EXCLUDED.object_key,status='pending',claim_token=NULL,last_error='',
		available_at=NOW()+INTERVAL '1 hour',updated_at=NOW()`, accountID, assetID, objectKey); err != nil {
		return err
	}
	return nil
}

func (r *WhiteboardRepository) AttachBoardAsset(ctx context.Context, accountID, actorID, boardID, assetID uuid.UUID, fileID, kind string, guestSessionID *uuid.UUID) (*domain.WhiteboardAsset, error) {
	if guestSessionID != nil {
		return nil, ErrWhiteboardInvalid
	}
	return r.attachBoardAsset(ctx, accountID, boardID, &actorID, "", assetID, fileID, kind, time.Now().UTC())
}

func (r *WhiteboardRepository) AttachBoardAssetAsGuest(ctx context.Context, tokenHash string, assetID uuid.UUID, fileID, kind string, now time.Time) (*domain.WhiteboardAsset, *domain.WhiteboardGuestContext, error) {
	item, guest, err := r.attachBoardAssetAsGuest(ctx, tokenHash, assetID, fileID, kind, now)
	return item, guest, err
}

func (r *WhiteboardRepository) attachBoardAssetAsGuest(ctx context.Context, tokenHash string, assetID uuid.UUID, fileID, kind string, now time.Time) (*domain.WhiteboardAsset, *domain.WhiteboardGuestContext, error) {
	guest, err := r.ResolveGuestSession(ctx, tokenHash, domain.WhiteboardAccessEdit, now)
	if err != nil {
		return nil, nil, err
	}
	item, err := r.attachBoardAsset(ctx, guest.Session.AccountID, guest.Session.BoardID, nil, tokenHash, assetID, fileID, kind, now)
	return item, guest, err
}

func (r *WhiteboardRepository) attachBoardAsset(ctx context.Context, accountID, boardID uuid.UUID, actorID *uuid.UUID, guestTokenHash string, assetID uuid.UUID, fileID, kind string, now time.Time) (*domain.WhiteboardAsset, error) {
	if fileID == "" || (kind != "asset" && kind != "thumbnail") {
		return nil, ErrWhiteboardInvalid
	}
	if guestTokenHash == "" && (actorID == nil || *actorID == uuid.Nil || accountID == uuid.Nil || boardID == uuid.Nil) {
		return nil, ErrWhiteboardInvalid
	}
	if guestTokenHash != "" && kind != "asset" {
		// Guests may insert scene images, but never replace a board thumbnail.
		return nil, ErrWhiteboardForbidden
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var guestSessionID *uuid.UUID
	if guestTokenHash != "" {
		guest, err := resolveGuestSessionWith(ctx, tx, guestTokenHash, domain.WhiteboardAccessEdit, now)
		if err != nil {
			return nil, err
		}
		if guest.Session.AccountID != accountID || guest.Session.BoardID != boardID {
			return nil, ErrWhiteboardSessionUnavailable
		}
		guestID := guest.Session.ID
		guestSessionID = &guestID
	} else {
		if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, *actorID, boardID, domain.WhiteboardAccessEdit, false); err != nil {
			return nil, err
		}
	}
	var lockedBoardID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM whiteboards WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, boardID).Scan(&lockedBoardID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
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
	var replacedAssetID *uuid.UUID
	if kind == "thumbnail" {
		_ = tx.QueryRow(ctx, `SELECT media_asset_id FROM whiteboard_assets
			WHERE account_id=$1 AND board_id=$2 AND kind='thumbnail' FOR UPDATE`, accountID, boardID).Scan(&replacedAssetID)
		if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2 AND kind='thumbnail'`, accountID, boardID); err != nil {
			return nil, err
		}
	} else {
		_ = tx.QueryRow(ctx, `SELECT media_asset_id FROM whiteboard_assets
			WHERE account_id=$1 AND board_id=$2 AND file_id=$3 AND kind='asset' FOR UPDATE`, accountID, boardID, fileID).Scan(&replacedAssetID)
		if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
			WHERE account_id=$1 AND board_id=$2 AND file_id=$3 AND kind='asset'`, accountID, boardID, fileID); err != nil {
			return nil, err
		}
	}
	linkID := uuid.New()
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,guest_session_id,committed_at,draft_expires_at
	) VALUES($1,$2,$3,$4,$5,$6::varchar,$7,$8,
		CASE WHEN $6::varchar='thumbnail' THEN $9::timestamptz ELSE NULL::timestamptz END,
		CASE WHEN $6::varchar='asset' THEN $9::timestamptz+INTERVAL '1 hour' ELSE NULL::timestamptz END)`, linkID, accountID, boardID, assetID, fileID, kind,
		actorID, guestSessionID, now); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if kind == "thumbnail" {
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET thumbnail_media_asset_id=$3,
			version=version+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, boardID, assetID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, assetID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, objectKey); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountID, assetID); err != nil {
		return nil, err
	}
	if replacedAssetID != nil && *replacedAssetID != assetID {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, *replacedAssetID); err != nil {
			return nil, err
		}
	}
	activityAction := WhiteboardActivityAssetUploaded
	if kind == "thumbnail" {
		activityAction = WhiteboardActivityThumbnailUpdated
	}
	details, _ := json.Marshal(map[string]any{"asset_id": linkID, "file_id": fileID, "kind": kind})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: actorID, GuestSessionID: guestSessionID,
		Action: activityAction, Details: details,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.getBoardAssetRecord(ctx, accountID, boardID, linkID)
}

func scanWhiteboardAsset(scanner whiteboardRowScanner) (*domain.WhiteboardAsset, error) {
	item := &domain.WhiteboardAsset{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.LibraryID,
		&item.MediaAssetID, &item.FileID, &item.Kind, &item.Filename, &item.ContentType,
		&item.MediaType, &item.SizeBytes, &item.UploadedBy, &item.GuestSessionID,
		&item.CommittedAt, &item.DraftExpiresAt, &item.CreatedAt)
	return item, err
}

const whiteboardAssetColumns = `link.id,link.account_id,link.board_id,link.library_id,link.media_asset_id,
	link.file_id,link.kind,asset.filename,asset.content_type,asset.media_type,asset.size_bytes,
	link.uploaded_by,link.guest_session_id,link.committed_at,link.draft_expires_at,link.created_at`

func (r *WhiteboardRepository) GetBoardAsset(ctx context.Context, accountID, actorID, boardID, assetLinkID uuid.UUID) (*domain.WhiteboardAsset, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	return r.getBoardAssetRecord(ctx, accountID, boardID, assetLinkID)
}

func (r *WhiteboardRepository) getBoardAssetRecord(ctx context.Context, accountID, boardID, assetLinkID uuid.UUID) (*domain.WhiteboardAsset, error) {
	item, err := scanWhiteboardAsset(r.db.QueryRow(ctx, `SELECT `+whiteboardAssetColumns+`
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.board_id=$2 AND link.id=$3`, accountID, boardID, assetLinkID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

type WhiteboardAssetListOptions struct {
	AfterCreatedAt *time.Time
	AfterID        *uuid.UUID
	Limit          int
	ReferencedOnly bool
}

func (r *WhiteboardRepository) ListBoardAssetsAsGuest(ctx context.Context, tokenHash string, options WhiteboardAssetListOptions, now time.Time) ([]*domain.WhiteboardAsset, bool, *domain.WhiteboardGuestContext, error) {
	guest, err := r.ResolveGuestSession(ctx, tokenHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return nil, false, nil, err
	}
	// A public session can hydrate only assets referenced by the canonical live
	// scene. It must never enumerate thumbnails, removed links or edit drafts,
	// regardless of query parameters supplied by the browser.
	options.ReferencedOnly = true
	items, hasMore, err := r.listBoardAssets(ctx, guest.Session.AccountID, guest.Session.BoardID, options)
	return items, hasMore, guest, err
}

func (r *WhiteboardRepository) ListBoardAssets(ctx context.Context, accountID, actorID, boardID uuid.UUID, options WhiteboardAssetListOptions) ([]*domain.WhiteboardAsset, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	return r.listBoardAssets(ctx, accountID, boardID, options)
}

func (r *WhiteboardRepository) listBoardAssets(ctx context.Context, accountID, boardID uuid.UUID, options WhiteboardAssetListOptions) ([]*domain.WhiteboardAsset, bool, error) {
	var scene json.RawMessage
	if options.ReferencedOnly {
		if err := r.db.QueryRow(ctx, `SELECT scene_json FROM whiteboards
			WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&scene); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return nil, false, ErrWhiteboardNotFound
			}
			return nil, false, err
		}
	}
	referencedFileIDs, err := whiteboardReferencedAssetFileIDs(scene, options.ReferencedOnly, false)
	if err != nil {
		return nil, false, err
	}
	limit := whiteboardGCLimit(options.Limit)
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardAssetColumns+`
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.board_id=$2
		AND ($3::timestamptz IS NULL OR (link.created_at,link.id)>($3::timestamptz,$4::uuid))
		AND ($5::boolean=FALSE OR (link.kind='asset' AND link.file_id=ANY($6::text[])))
		ORDER BY link.created_at,link.id LIMIT $7`, accountID, boardID, options.AfterCreatedAt, options.AfterID,
		options.ReferencedOnly, referencedFileIDs, limit+1)
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

type WhiteboardAssetDownload struct {
	ObjectKey   string
	Filename    string
	ContentType string
}

func (r *WhiteboardRepository) ResolveBoardAssetDownload(ctx context.Context, accountID, actorID, boardID, assetLinkID uuid.UUID) (*WhiteboardAssetDownload, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item := &WhiteboardAssetDownload{}
	err := r.db.QueryRow(ctx, `SELECT asset.object_key,asset.filename,asset.content_type
		FROM whiteboard_assets link JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
		WHERE link.account_id=$1 AND link.board_id=$2 AND link.id=$3`, accountID, boardID, assetLinkID).Scan(
		&item.ObjectKey, &item.Filename, &item.ContentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

const whiteboardGuestAssetDownloadQuery = `SELECT asset.object_key,asset.filename,asset.content_type
	FROM whiteboard_assets link
	JOIN media_assets asset ON asset.account_id=link.account_id
		AND asset.id=link.media_asset_id AND asset.status='active'
	JOIN whiteboards board ON board.account_id=link.account_id AND board.id=link.board_id
	WHERE link.account_id=$1 AND link.board_id=$2 AND link.id=$3
		AND link.kind='asset' AND link.committed_at IS NOT NULL
		AND EXISTS (
			SELECT 1 FROM jsonb_array_elements(
				CASE WHEN jsonb_typeof(board.scene_json->'elements')='array'
					THEN board.scene_json->'elements' ELSE '[]'::jsonb END
			) AS element
			WHERE element->>'fileId'=link.file_id
				AND COALESCE(element->'isDeleted','false'::jsonb)<>'true'::jsonb
		)`

func (r *WhiteboardRepository) ResolveBoardAssetDownloadAsGuest(ctx context.Context, tokenHash string, assetLinkID uuid.UUID, now time.Time) (*WhiteboardAssetDownload, error) {
	guest, err := r.ResolveGuestSession(ctx, tokenHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return nil, err
	}
	item := &WhiteboardAssetDownload{}
	// Guest authority follows the current canonical scene, not possession of an
	// old opaque asset URL. Keep the reference, committed state and media lookup
	// in one SQL snapshot so a concurrent scene removal cannot race the check.
	err = r.db.QueryRow(ctx, whiteboardGuestAssetDownloadQuery, guest.Session.AccountID,
		guest.Session.BoardID, assetLinkID).Scan(&item.ObjectKey, &item.Filename, &item.ContentType)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) DeleteBoardAsset(ctx context.Context, accountID, actorID, boardID, assetLinkID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var scene []byte
	if err := tx.QueryRow(ctx, `SELECT scene_json FROM whiteboards
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, boardID).Scan(&scene); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessEdit, false); err != nil {
		return err
	}
	var mediaAssetID uuid.UUID
	var kind, fileID string
	if err := tx.QueryRow(ctx, `SELECT media_asset_id,kind,file_id FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND id=$3 FOR UPDATE`, accountID, boardID, assetLinkID).Scan(&mediaAssetID, &kind, &fileID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if kind == "asset" {
		referencedFileIDs, err := whiteboardcore.ReferencedFileIDs(scene)
		if err != nil {
			return ErrWhiteboardInvalid
		}
		for _, referencedFileID := range referencedFileIDs {
			if referencedFileID == fileID {
				return ErrWhiteboardConflict
			}
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, assetLinkID); err != nil {
		return err
	}
	if kind == "thumbnail" {
		if _, err := tx.Exec(ctx, `UPDATE whiteboards SET thumbnail_media_asset_id=NULL,version=version+1,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND thumbnail_media_asset_id=$3`, accountID, boardID, mediaAssetID); err != nil {
			return err
		}
	}
	if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
		return err
	}
	details, _ := json.Marshal(map[string]any{"asset_id": assetLinkID, "file_id": fileID, "kind": kind})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityAssetDeleted, Details: details,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
