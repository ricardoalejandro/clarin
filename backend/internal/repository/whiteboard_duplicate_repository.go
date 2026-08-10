package repository

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

// WhiteboardDuplicateInput contains the immutable material prepared by the API
// for a retry-safe duplicate. Media bytes are not copied: the new board gets
// account-scoped links to the already inventoried private objects.
type WhiteboardDuplicateInput struct {
	ID                  uuid.UUID
	AccountID           uuid.UUID
	ActorID             uuid.UUID
	SourceBoardID       uuid.UUID
	FolderID            *uuid.UUID
	Name                string
	Description         string
	Scene               json.RawMessage
	SceneSchemaVersion  string
	EditorVersion       string
	OperationID         uuid.UUID
	RequestPayloadHash  string
	ResultSceneHash     string
	SnapshotObjectKey   string
	SnapshotContentHash string
	SnapshotSizeBytes   int64
}

// DuplicateBoard creates a private, independent collaboration boundary while
// reusing immutable media objects inside the same account. ACLs, guest links,
// operations and history from the source are deliberately not copied.
func (r *WhiteboardRepository) DuplicateBoard(ctx context.Context, input WhiteboardDuplicateInput) (*domain.Whiteboard, error) {
	if input.ID == uuid.Nil || input.AccountID == uuid.Nil || input.ActorID == uuid.Nil ||
		input.SourceBoardID == uuid.Nil || input.OperationID == uuid.Nil || len(input.RequestPayloadHash) != 64 ||
		input.ID == input.SourceBoardID || len(input.Scene) == 0 || input.SnapshotObjectKey == "" ||
		input.SnapshotContentHash == "" || input.SnapshotSizeBytes <= 0 {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := lockWhiteboardHierarchyTx(ctx, tx, input.AccountID); err != nil {
		return nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, input.AccountID, input.ActorID,
		input.SourceBoardID, domain.WhiteboardAccessView, false); err != nil {
		return nil, err
	}
	var sourceArchived bool
	var sourceScene json.RawMessage
	if err := tx.QueryRow(ctx, `SELECT archived_at IS NOT NULL,scene_json
		FROM whiteboards WHERE account_id=$1 AND id=$2 FOR SHARE`, input.AccountID, input.SourceBoardID).
		Scan(&sourceArchived, &sourceScene); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if sourceArchived || string(sourceScene) != string(input.Scene) {
		// The snapshot uploaded by the API must represent the exact source row
		// locked by this transaction; never create a mixed-time duplicate.
		return nil, ErrWhiteboardConflict
	}
	if input.FolderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, input.AccountID, *input.FolderID).Scan(&active); err != nil {
			return nil, err
		}
		if !active {
			return nil, ErrWhiteboardInvalid
		}
	}

	inserted, err := tx.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,folder_id,name,description,scene_json,scene_schema_version,editor_version,
		scene_sequence,version,access_mode,access_revision,thumbnail_media_asset_id,created_by,updated_by
	) SELECT $1,$2,$3,$4,$5,$6::jsonb,$7,$8,0,1,'private',1,
		source.thumbnail_media_asset_id,$9,$9
		FROM whiteboards source WHERE source.account_id=$2 AND source.id=$10 AND source.archived_at IS NULL
		ON CONFLICT(id) DO NOTHING`, input.ID, input.AccountID, input.FolderID, input.Name,
		input.Description, input.Scene, input.SceneSchemaVersion, input.EditorVersion, input.ActorID, input.SourceBoardID)
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if inserted.RowsAffected() == 0 {
		_ = tx.Rollback(ctx)
		item, found, findErr := r.FindCreatedBoardByOperation(ctx, input.AccountID, input.ActorID,
			input.ID, input.OperationID, input.RequestPayloadHash)
		if findErr != nil {
			return nil, findErr
		}
		if !found {
			return nil, ErrWhiteboardConflict
		}
		return item, nil
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_grants(
		account_id,board_id,user_id,access_level,can_manage_access,created_by
	) VALUES($1,$2,$3,'manage',TRUE,$3)`, input.AccountID, input.ID, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,
		request_payload_hash,result_scene_hash,actor_id
	) VALUES($1,$2,0,0,$3,'create',$4,$5,$6)`, input.AccountID, input.ID, input.OperationID,
		input.RequestPayloadHash, input.ResultSceneHash, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	var revisionID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO whiteboard_revisions(
		account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
		scene_schema_version,editor_version,actor_id
	) VALUES($1,$2,1,0,$3,'create','system',NULL,$4,$5,$6,'gzip',$7,$8,$9) RETURNING id`,
		input.AccountID, input.ID, input.OperationID, input.SnapshotObjectKey, input.SnapshotContentHash,
		input.SnapshotSizeBytes, input.SceneSchemaVersion, input.EditorVersion, input.ActorID).Scan(&revisionID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}

	// Copy only committed current assets. Draft uploads belong to the source
	// editing session and must never leak into a duplicate.
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at
	) SELECT gen_random_uuid(),source.account_id,$3,source.media_asset_id,source.file_id,source.kind,$4,NOW(),NULL
		FROM whiteboard_assets source
		WHERE source.account_id=$1 AND source.board_id=$2 AND source.committed_at IS NOT NULL`,
		input.AccountID, input.SourceBoardID, input.ID, input.ActorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := reconcileWhiteboardSceneAssetsTx(ctx, tx, input.AccountID, input.ID, input.Scene); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revision_assets(
		account_id,board_id,revision_id,media_asset_id,file_id
	) SELECT account_id,board_id,$3,media_asset_id,file_id FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND committed_at IS NOT NULL`,
		input.AccountID, input.ID, revisionID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets asset SET status='active',deleted_at=NULL,updated_at=NOW()
		FROM whiteboard_assets link WHERE link.account_id=$1 AND link.board_id=$2
		AND asset.account_id=link.account_id AND asset.id=link.media_asset_id`, input.AccountID, input.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects object SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() FROM media_assets asset
		JOIN whiteboard_assets link ON link.account_id=asset.account_id AND link.media_asset_id=asset.id
		WHERE link.account_id=$1 AND link.board_id=$2
		AND object.account_id=asset.account_id AND object.object_key=asset.object_key`, input.AccountID, input.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs job USING whiteboard_assets link
		WHERE link.account_id=$1 AND link.board_id=$2
		AND job.account_id=link.account_id AND job.media_asset_id=link.media_asset_id`, input.AccountID, input.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs
		WHERE account_id=$1 AND object_key=$2`, input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, err
	}
	after, _ := json.Marshal(map[string]any{
		"access_mode": "private", "creator_id": input.ActorID, "source_board_id": input.SourceBoardID,
	})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,after_state,operation_id,request_payload_hash
	) VALUES($1,$2,$3,'board_duplicated',$4::jsonb,$5,$6)`, input.AccountID, input.ID, input.ActorID,
		after, input.OperationID, input.RequestPayloadHash); err != nil {
		return nil, err
	}
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: input.AccountID, BoardID: input.ID, ActorID: &input.ActorID,
		Action: WhiteboardActivityDuplicated, Details: after, OperationID: &input.OperationID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetBoard(ctx, input.AccountID, input.ActorID, input.ID)
}
