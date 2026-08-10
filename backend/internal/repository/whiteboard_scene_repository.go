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
)

type WhiteboardSceneWriteInput struct {
	ExpectedSequence    int64
	OperationID         uuid.UUID
	Scene               json.RawMessage
	Patch               json.RawMessage
	SceneSchemaVersion  string
	EditorVersion       string
	WriteKind           string
	RevisionKind        string
	SourceRevisionID    *uuid.UUID
	RequestPayloadHash  string
	ResultSceneHash     string
	SnapshotObjectKey   string
	SnapshotContentHash string
	SnapshotSizeBytes   int64
}

func whiteboardSnapshotReservationBlocked(status string) bool {
	return status == "whiteboard_snapshot_uploading" || status == "whiteboard_snapshot_deleting"
}

func (r *WhiteboardRepository) ReserveRevisionSnapshot(ctx context.Context, accountID uuid.UUID, objectKey, contentHash string, sizeBytes int64) (bool, error) {
	if accountID == uuid.Nil || !storage.IsAccountWhiteboardObjectKey(accountID, objectKey) || contentHash == "" || sizeBytes <= 0 {
		return false, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := reserveWhiteboardStorageQuotaTx(ctx, tx, accountID, objectKey, sizeBytes); err != nil {
		return false, err
	}
	var status string
	err = tx.QueryRow(ctx, `SELECT status FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, objectKey).Scan(&status)
	reserved := true
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx, `INSERT INTO storage_objects(
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at
		) VALUES($1,$2,'document','application/gzip','scene.excalidraw.json.gz',$3,'whiteboard_revision',
			'whiteboard_snapshot_uploading',NOW()+INTERVAL '1 hour',NOW())`, accountID, objectKey, sizeBytes); err != nil {
			return false, err
		}
	} else if err != nil {
		return false, err
	} else if status == "active" {
		reserved = false
	} else if whiteboardSnapshotReservationBlocked(status) {
		return false, ErrWhiteboardUploadInProgress
	} else if _, err := tx.Exec(ctx, `UPDATE storage_objects SET size_bytes=$3,
		content_type='application/gzip',source='whiteboard_revision',status='whiteboard_snapshot_uploading',
		deleted_at=NULL,next_delete_at=NOW()+INTERVAL '1 hour',updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2`, accountID, objectKey, sizeBytes); err != nil {
		return false, err
	}
	if reserved {
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_uploading'
			WHERE account_id=$1 AND object_key=$2`, accountID, objectKey); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_snapshot_gc_jobs(account_id,object_key,available_at,updated_at)
		VALUES($1,$2,NOW()+INTERVAL '1 hour',NOW())
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='pending',claim_token=NULL,
		last_error='',available_at=NOW()+INTERVAL '1 hour',updated_at=NOW()`, accountID, objectKey); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return reserved, nil
}

func (r *WhiteboardRepository) MarkRevisionSnapshotFailed(ctx context.Context, accountID uuid.UUID, objectKey, cause string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_snapshot_gc_jobs SET status='pending',claim_token=NULL,
		last_error=$3,available_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, objectKey, cause); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET next_delete_at=NOW(),delete_error=$3,updated_at=NOW()
		,status='whiteboard_snapshot_pending' WHERE account_id=$1 AND object_key=$2
		AND status<>'active'`, accountID, objectKey, cause); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// GetScene authorizes through the repository/query layer and is ready to be
// called by REST or a future authenticated board-room WebSocket endpoint.
func (r *WhiteboardRepository) GetScene(ctx context.Context, accountID, userID, boardID uuid.UUID, requiredLevel string) (*domain.WhiteboardScene, error) {
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, requiredLevel); err != nil {
		return nil, err
	}
	item := &domain.WhiteboardScene{BoardID: boardID}
	if err := r.db.QueryRow(ctx, `SELECT scene_json,scene_schema_version,editor_version,scene_sequence,updated_at
		FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(
		&item.Scene, &item.SceneSchemaVersion, &item.EditorVersion, &item.Sequence, &item.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	return item, nil
}

// UpdateScene atomically advances scene_sequence, records an idempotent
// operation, and commits the compressed private snapshot as a durable revision.
func (r *WhiteboardRepository) UpdateScene(ctx context.Context, accountID, userID, boardID uuid.UUID, input WhiteboardSceneWriteInput) (*domain.WhiteboardSceneWriteResult, error) {
	if input.WriteKind == "" {
		input.WriteKind = "snapshot"
	}
	if input.WriteKind != "snapshot" && input.WriteKind != "restore" {
		return nil, ErrWhiteboardInvalid
	}
	if input.RevisionKind == "" {
		input.RevisionKind = "automatic"
	}
	if input.RevisionKind != "automatic" && input.RevisionKind != "manual" && input.RevisionKind != "system" {
		return nil, ErrWhiteboardInvalid
	}
	if (input.WriteKind == "restore") != (input.SourceRevisionID != nil) {
		return nil, ErrWhiteboardInvalid
	}
	return r.writeScene(ctx, accountID, userID, boardID, input, false)
}

// ApplyScenePatch persists both the client operation and its materialized
// canonical scene. Patch reconciliation itself intentionally lives outside the
// repository; callers must provide the validated resulting scene.
func (r *WhiteboardRepository) ApplyScenePatch(ctx context.Context, accountID, userID, boardID uuid.UUID, input WhiteboardSceneWriteInput) (*domain.WhiteboardSceneWriteResult, error) {
	if len(input.Patch) == 0 || !json.Valid(input.Patch) {
		return nil, ErrWhiteboardInvalid
	}
	input.WriteKind = "patch"
	return r.writeScene(ctx, accountID, userID, boardID, input, true)
}

func (r *WhiteboardRepository) FindSceneOperation(ctx context.Context, accountID, userID, boardID, operationID uuid.UUID, requestPayloadHash string) (*domain.WhiteboardSceneWriteResult, bool, error) {
	if operationID == uuid.Nil || len(requestPayloadHash) != 64 {
		return nil, false, ErrWhiteboardInvalid
	}
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessEdit); err != nil {
		return nil, false, err
	}
	var sequence int64
	var actorID *uuid.UUID
	var guestSessionID *uuid.UUID
	var storedHash *string
	var kind string
	err := r.db.QueryRow(ctx, `SELECT sequence,actor_id,guest_session_id,request_payload_hash,operation_kind
		FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`,
		accountID, boardID, operationID).Scan(&sequence, &actorID, &guestSessionID, &storedHash, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if actorID == nil || *actorID != userID || guestSessionID != nil || storedHash == nil || !strings.EqualFold(*storedHash, requestPayloadHash) {
		return nil, true, ErrWhiteboardConflict
	}
	scene, err := r.GetScene(ctx, accountID, userID, boardID, domain.WhiteboardAccessView)
	if err != nil {
		return nil, true, err
	}
	result := &domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: sequence, Idempotent: true}
	if kind == "snapshot" || kind == "restore" {
		result.Revision, err = r.GetRevisionByOperation(ctx, accountID, userID, boardID, operationID)
	}
	return result, true, err
}

func (r *WhiteboardRepository) writeScene(ctx context.Context, accountID, userID, boardID uuid.UUID, input WhiteboardSceneWriteInput, patch bool) (*domain.WhiteboardSceneWriteResult, error) {
	if input.OperationID == uuid.Nil || !json.Valid(input.Scene) || input.ResultSceneHash == "" {
		return nil, ErrWhiteboardInvalid
	}
	if !patch && (input.SnapshotObjectKey == "" || input.SnapshotContentHash == "" || input.SnapshotSizeBytes <= 0) {
		return nil, ErrWhiteboardInvalid
	}
	if input.RequestPayloadHash == "" {
		input.RequestPayloadHash = input.ResultSceneHash
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentSequence int64
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT scene_sequence,archived_at FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).Scan(&currentSequence, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, userID, boardID, domain.WhiteboardAccessEdit, false); err != nil {
		return nil, err
	}
	if archivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	var existingSequence int64
	var existingHash string
	var existingPayloadHash *string
	err = tx.QueryRow(ctx, `SELECT sequence,request_payload_hash,result_scene_hash FROM whiteboard_operations
		WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`, accountID, boardID, input.OperationID).Scan(&existingSequence, &existingPayloadHash, &existingHash)
	if err == nil {
		if existingPayloadHash != nil && !strings.EqualFold(*existingPayloadHash, input.RequestPayloadHash) {
			return nil, ErrWhiteboardConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		scene, sceneErr := r.GetScene(ctx, accountID, userID, boardID, domain.WhiteboardAccessView)
		if sceneErr != nil {
			return nil, sceneErr
		}
		var revision *domain.WhiteboardRevision
		if !patch {
			revision, err = r.GetRevisionByOperation(ctx, accountID, userID, boardID, input.OperationID)
			if err != nil {
				return nil, err
			}
		}
		return &domain.WhiteboardSceneWriteResult{Scene: scene, Revision: revision, OperationSequence: existingSequence, Idempotent: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if input.ExpectedSequence != currentSequence {
		return nil, &WhiteboardConflictError{CurrentSequence: currentSequence}
	}
	if input.WriteKind == "restore" {
		if err := restoreWhiteboardRevisionAssetsTx(ctx, tx, accountID, boardID, userID, *input.SourceRevisionID, input.Scene); err != nil {
			return nil, err
		}
	} else if err := reconcileWhiteboardSceneAssetsTx(ctx, tx, accountID, boardID, input.Scene); err != nil {
		return nil, err
	}
	newSequence := currentSequence + 1
	operationKind := input.WriteKind
	if patch {
		operationKind = "patch"
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET scene_json=$3::jsonb,scene_schema_version=$4,
		editor_version=$5,scene_sequence=$6,version=version+1,updated_by=$7,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, boardID, input.Scene, input.SceneSchemaVersion,
		input.EditorVersion, newSequence, userID); err != nil {
		return nil, err
	}
	var patchJSON any
	if patch {
		patchJSON = input.Patch
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,patch_json,
		request_payload_hash,result_scene_hash,actor_id
	) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`, accountID, boardID, currentSequence,
		newSequence, input.OperationID, operationKind, patchJSON, input.RequestPayloadHash, input.ResultSceneHash, userID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if !patch {
		var revisionID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO whiteboard_revisions(
			account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
			snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
			scene_schema_version,editor_version,actor_id
		) VALUES($1,$2,$3,$4,$5,$6::varchar,$7::varchar,CASE WHEN $7::varchar='automatic' THEN NOW()+INTERVAL '30 days' ELSE NULL::timestamptz END,
			$8,$9,$10,'gzip',$11,$12,$13) RETURNING id`, accountID, boardID,
			newSequence+1, newSequence, input.OperationID, input.WriteKind, input.RevisionKind, input.SnapshotObjectKey,
			input.SnapshotContentHash, input.SnapshotSizeBytes, input.SceneSchemaVersion, input.EditorVersion, userID).Scan(&revisionID); err != nil {
			return nil, normalizeWhiteboardConstraintError(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revision_assets(
			account_id,board_id,revision_id,media_asset_id,file_id
		) SELECT account_id,board_id,$3,media_asset_id,file_id FROM whiteboard_assets
			WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND committed_at IS NOT NULL`, accountID, boardID, revisionID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
			delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
			accountID, input.SnapshotObjectKey); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs
			WHERE account_id=$1 AND object_key=$2`, accountID, input.SnapshotObjectKey); err != nil {
			return nil, err
		}
	}
	activityAction := WhiteboardActivityScenePatched
	if input.WriteKind == "restore" {
		activityAction = WhiteboardActivityRevisionRestored
	} else if !patch && input.RevisionKind == "manual" {
		activityAction = WhiteboardActivityRevisionCreated
	} else if !patch {
		activityAction = WhiteboardActivitySceneSnapshotted
	}
	details, _ := json.Marshal(map[string]any{
		"sequence": newSequence, "write_kind": input.WriteKind,
		"revision_kind": input.RevisionKind, "source_revision_id": input.SourceRevisionID,
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &userID,
		Action: activityAction, Details: details, OperationID: &input.OperationID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	scene, err := r.GetScene(ctx, accountID, userID, boardID, domain.WhiteboardAccessView)
	if err != nil {
		return nil, err
	}
	var revision *domain.WhiteboardRevision
	if !patch {
		revision, err = r.GetRevisionByOperation(ctx, accountID, userID, boardID, input.OperationID)
		if err != nil {
			return nil, err
		}
	}
	return &domain.WhiteboardSceneWriteResult{Scene: scene, Revision: revision, OperationSequence: newSequence}, nil
}

const whiteboardRestoreRevisionLockSQL = `SELECT id FROM whiteboard_revisions
	WHERE account_id=$1 AND board_id=$2 AND id=$3 FOR SHARE`

func restoreWhiteboardRevisionAssetsTx(ctx context.Context, tx pgx.Tx, accountID, boardID, actorID, revisionID uuid.UUID, scene []byte) error {
	var lockedRevisionID uuid.UUID
	if err := tx.QueryRow(ctx, whiteboardRestoreRevisionLockSQL, accountID, boardID, revisionID).Scan(&lockedRevisionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	rows, err := tx.Query(ctx, `SELECT DISTINCT media_asset_id FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset'`, accountID, boardID)
	if err != nil {
		return err
	}
	previous := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		previous = append(previous, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset'`, accountID, boardID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at
	) SELECT gen_random_uuid(),account_id,board_id,media_asset_id,file_id,'asset',$4,NOW(),NULL
		FROM whiteboard_revision_assets WHERE account_id=$1 AND board_id=$2 AND revision_id=$3`,
		accountID, boardID, revisionID, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets asset SET status='active',deleted_at=NULL,updated_at=NOW()
		FROM whiteboard_revision_assets revision_asset
		WHERE revision_asset.account_id=$1 AND revision_asset.board_id=$2 AND revision_asset.revision_id=$3
		AND asset.account_id=revision_asset.account_id AND asset.id=revision_asset.media_asset_id`, accountID, boardID, revisionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects object SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() FROM media_assets asset
		JOIN whiteboard_revision_assets revision_asset ON revision_asset.account_id=asset.account_id
			AND revision_asset.media_asset_id=asset.id
		WHERE revision_asset.account_id=$1 AND revision_asset.board_id=$2 AND revision_asset.revision_id=$3
		AND object.account_id=asset.account_id AND object.object_key=asset.object_key`, accountID, boardID, revisionID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs job USING whiteboard_revision_assets revision_asset
		WHERE revision_asset.account_id=$1 AND revision_asset.board_id=$2 AND revision_asset.revision_id=$3
		AND job.account_id=revision_asset.account_id AND job.media_asset_id=revision_asset.media_asset_id`, accountID, boardID, revisionID); err != nil {
		return err
	}
	for _, mediaAssetID := range previous {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
			return err
		}
	}
	return reconcileWhiteboardSceneAssetsTx(ctx, tx, accountID, boardID, scene)
}

func scanWhiteboardRevision(scanner whiteboardRowScanner) (*domain.WhiteboardRevision, error) {
	item := &domain.WhiteboardRevision{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.RevisionNumber,
		&item.Sequence, &item.OperationID, &item.WriteKind, &item.RevisionKind, &item.ExpiresAt, &item.SnapshotObjectKey,
		&item.SnapshotContentHash, &item.SnapshotSizeBytes, &item.SnapshotCompression,
		&item.SceneSchemaVersion, &item.EditorVersion, &item.ActorID, &item.GuestSessionID, &item.CreatedAt)
	return item, err
}

const whiteboardRevisionColumns = `id,account_id,board_id,revision_number,sequence,operation_id,write_kind,
	revision_kind,expires_at,
	snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
	scene_schema_version,editor_version,actor_id,guest_session_id,created_at`

func (r *WhiteboardRepository) ListRevisions(ctx context.Context, accountID, userID, boardID uuid.UUID, beforeSequence *int64, limit int) ([]*domain.WhiteboardRevision, bool, error) {
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, false, err
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardRevisionColumns+` FROM whiteboard_revisions
		WHERE account_id=$1 AND board_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
		ORDER BY sequence DESC,id DESC LIMIT $4`, accountID, boardID, beforeSequence, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardRevision, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardRevision(rows)
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

func (r *WhiteboardRepository) GetRevision(ctx context.Context, accountID, userID, boardID, revisionID uuid.UUID) (*domain.WhiteboardRevision, error) {
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardRevision(r.db.QueryRow(ctx, `SELECT `+whiteboardRevisionColumns+`
		FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND id=$3`, accountID, boardID, revisionID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) GetRevisionByOperation(ctx context.Context, accountID, userID, boardID, operationID uuid.UUID) (*domain.WhiteboardRevision, error) {
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardRevision(r.db.QueryRow(ctx, `SELECT `+whiteboardRevisionColumns+`
		FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`, accountID, boardID, operationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) ListOperationsAfter(ctx context.Context, accountID, userID, boardID uuid.UUID, afterSequence int64, limit int) ([]*domain.WhiteboardOperation, error) {
	if _, err := r.RequireAccess(ctx, accountID, userID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	return r.listWhiteboardOperationsAfter(ctx, accountID, boardID, afterSequence, limit)
}

func (r *WhiteboardRepository) listWhiteboardOperationsAfter(ctx context.Context, accountID, boardID uuid.UUID, afterSequence int64, limit int) ([]*domain.WhiteboardOperation, error) {
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	rows, err := r.db.Query(ctx, `SELECT id,account_id,board_id,base_sequence,sequence,operation_id,
		operation_kind,patch_json,COALESCE(request_payload_hash,''),result_scene_hash,actor_id,guest_session_id,created_at
		FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2 AND sequence>$3
		ORDER BY sequence,id LIMIT $4`, accountID, boardID, afterSequence, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardOperation, 0, limit)
	for rows.Next() {
		item := &domain.WhiteboardOperation{}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.BaseSequence,
			&item.Sequence, &item.OperationID, &item.OperationKind, &item.Patch,
			&item.RequestPayloadHash, &item.ResultSceneHash, &item.ActorID, &item.GuestSessionID, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
