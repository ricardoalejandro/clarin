package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type TaskLocationViewDuplicateInput struct {
	ViewID              uuid.UUID
	BoardID             uuid.UUID
	SourceViewID        uuid.UUID
	SourceBoardID       uuid.UUID
	AccountID           uuid.UUID
	ActorID             uuid.UUID
	Name                string
	ExpectedVersion     int64
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

type taskLocationViewDuplicateState struct {
	ScopeType     string
	ScopeID       uuid.UUID
	EnvironmentID uuid.UUID
	BoardID       uuid.UUID
	Version       int64
	Scene         json.RawMessage
	Deleted       bool
	BoardArchived bool
}

func readTaskLocationViewDuplicateState(ctx context.Context, tx pgx.Tx, accountID, viewID uuid.UUID, lock bool) (*taskLocationViewDuplicateState, error) {
	state := &taskLocationViewDuplicateState{}
	viewQuery := `SELECT CASE WHEN view_item.folder_id IS NOT NULL THEN 'folder' ELSE 'list' END,
		COALESCE(view_item.folder_id,view_item.list_id),view_item.environment_id,binding.whiteboard_id,
		view_item.version,view_item.deleted_at IS NOT NULL
		FROM task_location_views view_item JOIN task_location_whiteboard_views binding
		ON binding.account_id=view_item.account_id AND binding.task_view_id=view_item.id
		WHERE view_item.account_id=$1 AND view_item.id=$2`
	if lock {
		viewQuery += ` FOR UPDATE OF view_item`
	}
	if err := tx.QueryRow(ctx, viewQuery, accountID, viewID).Scan(&state.ScopeType, &state.ScopeID,
		&state.EnvironmentID, &state.BoardID, &state.Version, &state.Deleted); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskLocationViewNotFound
		}
		return nil, err
	}
	boardQuery := `SELECT scene_json,archived_at IS NOT NULL FROM whiteboards WHERE account_id=$1 AND id=$2`
	if lock {
		boardQuery += ` FOR UPDATE`
	}
	if err := tx.QueryRow(ctx, boardQuery, accountID, state.BoardID).Scan(&state.Scene, &state.BoardArchived); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskLocationViewNotFound
		}
		return nil, err
	}
	return state, nil
}

// Duplicate creates a second contextual view at the same Work location. It
// copies the canonical scene and committed media links, but never creates a
// standalone grant or copies public shares/history from the source board.
func (r *TaskLocationViewRepository) Duplicate(ctx context.Context, input TaskLocationViewDuplicateInput) (*domain.TaskLocationView, bool, error) {
	if input.ViewID == uuid.Nil || input.BoardID == uuid.Nil || input.SourceViewID == uuid.Nil || input.SourceBoardID == uuid.Nil ||
		input.AccountID == uuid.Nil || input.ActorID == uuid.Nil || input.OperationID == uuid.Nil || input.ExpectedVersion <= 0 ||
		input.ViewID == input.SourceViewID || input.BoardID == input.SourceBoardID || strings.TrimSpace(input.Name) == "" ||
		len(input.Scene) == 0 || len(input.RequestPayloadHash) != 64 || input.SnapshotObjectKey == "" ||
		input.SnapshotContentHash == "" || input.SnapshotSizeBytes <= 0 {
		return nil, false, ErrTaskLocationViewInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, input.AccountID); err != nil {
		return nil, false, ErrTaskLocationViewNotFound
	}
	if err := lockTaskLocationViewActorMembershipTx(ctx, tx, input.AccountID, input.ActorID); err != nil {
		return nil, false, err
	}
	if err := lockTaskLocationOperationTx(ctx, tx, input.AccountID, input.ActorID, input.OperationID); err != nil {
		return nil, false, err
	}
	if existingID, found, opErr := taskLocationViewOperationTx(ctx, tx, input.AccountID, input.ActorID,
		input.OperationID, "duplicate", input.RequestPayloadHash); opErr != nil {
		return nil, false, opErr
	} else if found {
		_ = tx.Rollback(ctx)
		item, getErr := r.Get(ctx, input.AccountID, input.ActorID, existingID)
		return item, true, getErr
	}

	// Discover the canonical parent without taking child locks. The mutation
	// then locks parent -> contextual view -> whiteboard, matching parent
	// archive/purge and checkpoint coordination.
	initial, err := readTaskLocationViewDuplicateState(ctx, tx, input.AccountID, input.SourceViewID, false)
	if err != nil {
		return nil, false, err
	}
	if initial.BoardID != input.SourceBoardID || initial.Deleted || initial.BoardArchived ||
		initial.Version != input.ExpectedVersion || string(initial.Scene) != string(input.Scene) {
		return nil, false, ErrTaskLocationViewConflict
	}
	_, lockedEnvironmentID, err := requireTaskLocationManageTx(ctx, tx, input.AccountID, input.ActorID,
		initial.ScopeID, initial.ScopeType)
	if err != nil {
		return nil, false, err
	}
	current, err := readTaskLocationViewDuplicateState(ctx, tx, input.AccountID, input.SourceViewID, true)
	if err != nil {
		return nil, false, err
	}
	if current.ScopeType != initial.ScopeType || current.ScopeID != initial.ScopeID ||
		current.EnvironmentID != initial.EnvironmentID || current.BoardID != input.SourceBoardID ||
		current.Deleted || current.BoardArchived || current.Version != input.ExpectedVersion ||
		string(current.Scene) != string(input.Scene) || lockedEnvironmentID != current.EnvironmentID {
		return nil, false, ErrTaskLocationViewConflict
	}
	if _, _, err := requireWorkWhiteboardAccessTx(ctx, tx, input.AccountID, input.ActorID,
		input.SourceBoardID, domain.WhiteboardAccessManage, true); err != nil {
		return nil, false, err
	}
	folderID, listID := taskLocationScopeColumns(current.ScopeType, current.ScopeID)
	var sortOrder int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM task_location_views
		WHERE account_id=$1 AND environment_id=$2 AND folder_id IS NOT DISTINCT FROM $3::uuid
		AND list_id IS NOT DISTINCT FROM $4::uuid`, input.AccountID, current.EnvironmentID, folderID, listID).Scan(&sortOrder); err != nil {
		return nil, false, err
	}
	inserted, err := tx.Exec(ctx, `INSERT INTO whiteboards(
		id,account_id,folder_id,name,description,scene_json,scene_schema_version,editor_version,
		scene_sequence,version,access_mode,access_revision,thumbnail_media_asset_id,created_by,updated_by
	) SELECT $1,$2,NULL,$3,source.description,$4::jsonb,$5,$6,0,1,'private',1,
		source.thumbnail_media_asset_id,$7,$7 FROM whiteboards source
		WHERE source.account_id=$2 AND source.id=$8 AND source.archived_at IS NULL`, input.BoardID, input.AccountID,
		strings.TrimSpace(input.Name), input.Scene, input.SceneSchemaVersion, input.EditorVersion, input.ActorID, input.SourceBoardID)
	if err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	if inserted.RowsAffected() != 1 {
		return nil, false, ErrTaskLocationViewConflict
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_location_views(
		id,account_id,environment_id,folder_id,list_id,view_type,sort_order,created_by
	) VALUES($1,$2,$3,$4,$5,'whiteboard',$6,$7)`, input.ViewID, input.AccountID, current.EnvironmentID,
		folderID, listID, sortOrder, input.ActorID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_location_whiteboard_views(account_id,task_view_id,whiteboard_id)
		VALUES($1,$2,$3)`, input.AccountID, input.ViewID, input.BoardID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,request_payload_hash,result_scene_hash,actor_id
	) VALUES($1,$2,0,0,$3,'create',$4,$5,$6)`, input.AccountID, input.BoardID, input.OperationID,
		input.RequestPayloadHash, input.ResultSceneHash, input.ActorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	storageTag, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey)
	if err != nil {
		return nil, false, err
	}
	if storageTag.RowsAffected() != 1 {
		return nil, false, ErrTaskLocationViewConflict
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs WHERE account_id=$1 AND object_key=$2`,
		input.AccountID, input.SnapshotObjectKey); err != nil {
		return nil, false, err
	}
	var revisionID uuid.UUID
	if err := tx.QueryRow(ctx, `INSERT INTO whiteboard_revisions(
		account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
		snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
		scene_schema_version,editor_version,actor_id
	) VALUES($1,$2,1,0,$3,'create','system',NULL,$4,$5,$6,'gzip',$7,$8,$9) RETURNING id`,
		input.AccountID, input.BoardID, input.OperationID, input.SnapshotObjectKey, input.SnapshotContentHash,
		input.SnapshotSizeBytes, input.SceneSchemaVersion, input.EditorVersion, input.ActorID).Scan(&revisionID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_assets(
		id,account_id,board_id,media_asset_id,file_id,kind,uploaded_by,committed_at,draft_expires_at
	) SELECT gen_random_uuid(),source.account_id,$3,source.media_asset_id,source.file_id,source.kind,$4,NOW(),NULL
		FROM whiteboard_assets source WHERE source.account_id=$1 AND source.board_id=$2
		AND source.committed_at IS NOT NULL`, input.AccountID, input.SourceBoardID, input.BoardID, input.ActorID); err != nil {
		return nil, false, normalizeWhiteboardConstraintError(err)
	}
	if err := reconcileWhiteboardSceneAssetsTx(ctx, tx, input.AccountID, input.BoardID, input.Scene); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revision_assets(account_id,board_id,revision_id,media_asset_id,file_id)
		SELECT account_id,board_id,$3,media_asset_id,file_id FROM whiteboard_assets
		WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND committed_at IS NOT NULL`,
		input.AccountID, input.BoardID, revisionID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets asset SET status='active',deleted_at=NULL,updated_at=NOW()
		FROM whiteboard_assets link WHERE link.account_id=$1 AND link.board_id=$2
		AND asset.account_id=link.account_id AND asset.id=link.media_asset_id`, input.AccountID, input.BoardID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects object SET status='active',next_delete_at=NULL,
		delete_error='',deleted_at=NULL,updated_at=NOW() FROM media_assets asset
		JOIN whiteboard_assets link ON link.account_id=asset.account_id AND link.media_asset_id=asset.id
		WHERE link.account_id=$1 AND link.board_id=$2 AND object.account_id=asset.account_id
		AND object.object_key=asset.object_key`, input.AccountID, input.BoardID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs job USING whiteboard_assets link
		WHERE link.account_id=$1 AND link.board_id=$2 AND job.account_id=link.account_id
		AND job.media_asset_id=link.media_asset_id`, input.AccountID, input.BoardID); err != nil {
		return nil, false, err
	}
	after, _ := json.Marshal(map[string]any{"access_mode": "work_inherited", "creator_id": input.ActorID,
		"source_board_id": input.SourceBoardID, "task_view_id": input.ViewID})
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_access_audit(
		account_id,board_id,actor_id,action,after_state,operation_id,request_payload_hash
	) VALUES($1,$2,$3,'board_duplicated',$4::jsonb,$5,$6)`, input.AccountID, input.BoardID,
		input.ActorID, after, input.OperationID, input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{AccountID: input.AccountID,
		BoardID: input.BoardID, ActorID: &input.ActorID, Action: WhiteboardActivityDuplicated,
		Details: after, OperationID: &input.OperationID}); err != nil {
		return nil, false, err
	}
	if err := insertTaskLocationViewOperationTx(ctx, tx, input.AccountID, input.ActorID, input.OperationID,
		input.ViewID, "duplicate", input.RequestPayloadHash); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	item, err := r.getOperationResult(ctx, input.AccountID, input.ActorID, input.ViewID)
	return item, false, err
}
