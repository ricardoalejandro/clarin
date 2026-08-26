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
)

func resolveGuestSessionWith(ctx context.Context, q whiteboardQuerier, tokenHash, requiredLevel string, now time.Time) (*domain.WhiteboardGuestContext, error) {
	if requiredLevel != domain.WhiteboardAccessView && requiredLevel != domain.WhiteboardAccessEdit {
		return nil, ErrWhiteboardInvalid
	}
	item := &domain.WhiteboardGuestContext{Session: &domain.WhiteboardGuestSession{}}
	err := q.QueryRow(ctx, `SELECT session.id,session.account_id,session.board_id,session.share_link_id,
		session.display_name,session.access_level,session.expires_at,session.revoked_at,
		session.last_seen_at,session.created_at,link.allow_export
		FROM whiteboard_guest_sessions session
		JOIN whiteboard_share_links link ON link.account_id=session.account_id AND link.id=session.share_link_id
		JOIN whiteboards board ON board.account_id=session.account_id AND board.id=session.board_id
		JOIN accounts account ON account.id=session.account_id AND COALESCE(account.is_active,TRUE)
		JOIN subscriptions account_subscription ON account_subscription.account_id=session.account_id
			AND (
				(account_subscription.status='active' AND (account_subscription.current_period_end IS NULL OR account_subscription.current_period_end>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='trialing' AND (account_subscription.trial_ends_at IS NULL OR account_subscription.trial_ends_at>=CURRENT_TIMESTAMP)) OR
				(account_subscription.status='grace' AND (account_subscription.grace_ends_at IS NULL OR account_subscription.grace_ends_at>=CURRENT_TIMESTAMP))
			)
		WHERE session.token_hash=$1 AND session.revoked_at IS NULL AND session.expires_at>$2
		AND link.revoked_at IS NULL AND (link.expires_at IS NULL OR link.expires_at>$2)
		AND board.archived_at IS NULL
		AND NOT EXISTS(SELECT 1 FROM task_location_whiteboard_views work_binding
			WHERE work_binding.account_id=board.account_id AND work_binding.whiteboard_id=board.id)
		AND ($3::text='view' OR session.access_level='edit')`, tokenHash, now, requiredLevel).Scan(
		&item.Session.ID, &item.Session.AccountID, &item.Session.BoardID, &item.Session.ShareLinkID,
		&item.Session.DisplayName, &item.Session.AccessLevel, &item.Session.ExpiresAt,
		&item.Session.RevokedAt, &item.Session.LastSeenAt, &item.Session.CreatedAt, &item.AllowExport)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardSessionUnavailable
	}
	return item, err
}

func (r *WhiteboardRepository) GetSceneAsGuest(ctx context.Context, tokenHash, requiredLevel string, now time.Time) (*domain.WhiteboardScene, *domain.WhiteboardGuestContext, error) {
	guest, err := r.ResolveGuestSession(ctx, tokenHash, requiredLevel, now)
	if err != nil {
		return nil, nil, err
	}
	scene := &domain.WhiteboardScene{BoardID: guest.Session.BoardID}
	if err := r.db.QueryRow(ctx, `SELECT scene_json,scene_schema_version,editor_version,scene_sequence,updated_at
		FROM whiteboards WHERE account_id=$1 AND id=$2 AND archived_at IS NULL`,
		guest.Session.AccountID, guest.Session.BoardID).Scan(&scene.Scene, &scene.SceneSchemaVersion,
		&scene.EditorVersion, &scene.Sequence, &scene.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrWhiteboardSessionUnavailable
		}
		return nil, nil, err
	}
	return scene, guest, nil
}

func (r *WhiteboardRepository) ListOperationsAfterAsGuest(ctx context.Context, tokenHash string, afterSequence int64, limit int, now time.Time) ([]*domain.WhiteboardOperation, *domain.WhiteboardGuestContext, error) {
	guest, err := r.ResolveGuestSession(ctx, tokenHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return nil, nil, err
	}
	items, err := r.listWhiteboardOperationsAfter(ctx, guest.Session.AccountID, guest.Session.BoardID, afterSequence, limit)
	if err != nil {
		return nil, nil, err
	}
	return items, guest, nil
}

func (r *WhiteboardRepository) UpdateSceneAsGuest(ctx context.Context, tokenHash string, input WhiteboardSceneWriteInput, now time.Time) (*domain.WhiteboardSceneWriteResult, error) {
	if input.WriteKind == "" {
		input.WriteKind = "snapshot"
	}
	if input.WriteKind != "snapshot" && input.WriteKind != "restore" {
		return nil, ErrWhiteboardInvalid
	}
	if input.RevisionKind == "" {
		input.RevisionKind = "automatic"
	}
	if input.RevisionKind != "automatic" && input.RevisionKind != "manual" {
		return nil, ErrWhiteboardInvalid
	}
	return r.writeSceneAsGuest(ctx, tokenHash, input, now, false)
}

func (r *WhiteboardRepository) ApplyScenePatchAsGuest(ctx context.Context, tokenHash string, input WhiteboardSceneWriteInput, now time.Time) (*domain.WhiteboardSceneWriteResult, error) {
	if len(input.Patch) == 0 || !json.Valid(input.Patch) {
		return nil, ErrWhiteboardInvalid
	}
	input.WriteKind = "patch"
	return r.writeSceneAsGuest(ctx, tokenHash, input, now, true)
}

func (r *WhiteboardRepository) FindSceneOperationAsGuest(ctx context.Context, tokenHash string, operationID uuid.UUID, requestPayloadHash string, now time.Time) (*domain.WhiteboardSceneWriteResult, *domain.WhiteboardGuestContext, bool, error) {
	if operationID == uuid.Nil || len(requestPayloadHash) != 64 {
		return nil, nil, false, ErrWhiteboardInvalid
	}
	guest, err := r.ResolveGuestSession(ctx, tokenHash, domain.WhiteboardAccessEdit, now)
	if err != nil {
		return nil, nil, false, err
	}
	var sequence int64
	var actorID *uuid.UUID
	var operationGuestID *uuid.UUID
	var storedHash *string
	var kind string
	err = r.db.QueryRow(ctx, `SELECT sequence,actor_id,guest_session_id,request_payload_hash,operation_kind
		FROM whiteboard_operations WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`,
		guest.Session.AccountID, guest.Session.BoardID, operationID).Scan(
		&sequence, &actorID, &operationGuestID, &storedHash, &kind)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, guest, false, nil
	}
	if err != nil {
		return nil, guest, false, err
	}
	if actorID != nil || operationGuestID == nil || *operationGuestID != guest.Session.ID || storedHash == nil || !strings.EqualFold(*storedHash, requestPayloadHash) {
		return nil, guest, true, ErrWhiteboardConflict
	}
	scene, _, err := r.GetSceneAsGuest(ctx, tokenHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return nil, guest, true, err
	}
	result := &domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: sequence, Idempotent: true}
	if kind == "snapshot" || kind == "restore" {
		result.Revision, err = scanWhiteboardRevision(r.db.QueryRow(ctx, `SELECT `+whiteboardRevisionColumns+`
			FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`,
			guest.Session.AccountID, guest.Session.BoardID, operationID))
	}
	return result, guest, true, err
}

func (r *WhiteboardRepository) writeSceneAsGuest(ctx context.Context, tokenHash string, input WhiteboardSceneWriteInput, now time.Time, patch bool) (*domain.WhiteboardSceneWriteResult, error) {
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
	guest, err := resolveGuestSessionWith(ctx, tx, tokenHash, domain.WhiteboardAccessEdit, now)
	if err != nil {
		return nil, err
	}
	var currentSequence int64
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT scene_sequence,archived_at FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, guest.Session.AccountID, guest.Session.BoardID).Scan(&currentSequence, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardSessionUnavailable
		}
		return nil, err
	}
	// The public exchange is resolved once to discover the board, then again
	// after its mutation lock. Account/subscription transitions lock every board
	// after changing authority, so this second read serializes the write on the
	// correct side of a concurrent suspension or tenant deactivation.
	guest, err = resolveGuestSessionWith(ctx, tx, tokenHash, domain.WhiteboardAccessEdit, now)
	if err != nil {
		return nil, err
	}
	if archivedAt != nil {
		return nil, ErrWhiteboardSessionUnavailable
	}
	var existingSequence int64
	var existingGuestID *uuid.UUID
	var existingHash string
	var existingPayloadHash *string
	err = tx.QueryRow(ctx, `SELECT sequence,guest_session_id,request_payload_hash,result_scene_hash FROM whiteboard_operations
		WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`, guest.Session.AccountID,
		guest.Session.BoardID, input.OperationID).Scan(&existingSequence, &existingGuestID, &existingPayloadHash, &existingHash)
	if err == nil {
		if existingGuestID == nil || *existingGuestID != guest.Session.ID || (existingPayloadHash != nil && !strings.EqualFold(*existingPayloadHash, input.RequestPayloadHash)) {
			return nil, ErrWhiteboardConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		scene, _, sceneErr := r.GetSceneAsGuest(ctx, tokenHash, domain.WhiteboardAccessView, now)
		if sceneErr != nil {
			return nil, sceneErr
		}
		return &domain.WhiteboardSceneWriteResult{Scene: scene, OperationSequence: existingSequence, Idempotent: true}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if input.ExpectedSequence != currentSequence {
		return nil, &WhiteboardConflictError{CurrentSequence: currentSequence}
	}
	if err := reconcileWhiteboardSceneAssetsTx(ctx, tx, guest.Session.AccountID, guest.Session.BoardID, input.Scene); err != nil {
		return nil, err
	}
	newSequence := currentSequence + 1
	operationKind := input.WriteKind
	if patch {
		operationKind = "patch"
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET scene_json=$3::jsonb,scene_schema_version=$4,
		editor_version=$5,scene_sequence=$6,version=version+1,updated_by=NULL,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, guest.Session.AccountID, guest.Session.BoardID, input.Scene,
		input.SceneSchemaVersion, input.EditorVersion, newSequence); err != nil {
		return nil, err
	}
	var patchJSON any
	if patch {
		patchJSON = input.Patch
	}
	if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_operations(
		account_id,board_id,base_sequence,sequence,operation_id,operation_kind,patch_json,
		request_payload_hash,result_scene_hash,guest_session_id
	) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`, guest.Session.AccountID, guest.Session.BoardID,
		currentSequence, newSequence, input.OperationID, operationKind, patchJSON,
		input.RequestPayloadHash, input.ResultSceneHash, guest.Session.ID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	var revision *domain.WhiteboardRevision
	if !patch {
		var revisionID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO whiteboard_revisions(
			account_id,board_id,revision_number,sequence,operation_id,write_kind,revision_kind,expires_at,
			snapshot_object_key,snapshot_content_hash,snapshot_size_bytes,snapshot_compression,
			scene_schema_version,editor_version,guest_session_id
		) VALUES($1,$2,$3,$4,$5,$6::varchar,$7::varchar,CASE WHEN $7::varchar='automatic' THEN NOW()+INTERVAL '30 days' ELSE NULL::timestamptz END,
			$8,$9,$10,'gzip',$11,$12,$13) RETURNING id`, guest.Session.AccountID,
			guest.Session.BoardID, newSequence+1, newSequence, input.OperationID, input.WriteKind, input.RevisionKind,
			input.SnapshotObjectKey, input.SnapshotContentHash, input.SnapshotSizeBytes,
			input.SceneSchemaVersion, input.EditorVersion, guest.Session.ID).Scan(&revisionID); err != nil {
			return nil, normalizeWhiteboardConstraintError(err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_revision_assets(
			account_id,board_id,revision_id,media_asset_id,file_id
		) SELECT account_id,board_id,$3,media_asset_id,file_id FROM whiteboard_assets
			WHERE account_id=$1 AND board_id=$2 AND kind='asset' AND committed_at IS NOT NULL`, guest.Session.AccountID, guest.Session.BoardID, revisionID); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',next_delete_at=NULL,
			delete_error='',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND object_key=$2`,
			guest.Session.AccountID, input.SnapshotObjectKey); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs
			WHERE account_id=$1 AND object_key=$2`, guest.Session.AccountID, input.SnapshotObjectKey); err != nil {
			return nil, err
		}
	}
	activityAction := WhiteboardActivityScenePatched
	if !patch && input.RevisionKind == "manual" {
		activityAction = WhiteboardActivityRevisionCreated
	} else if !patch {
		activityAction = WhiteboardActivitySceneSnapshotted
	}
	details, _ := json.Marshal(map[string]any{
		"sequence": newSequence, "write_kind": input.WriteKind, "revision_kind": input.RevisionKind,
	})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: guest.Session.AccountID, BoardID: guest.Session.BoardID,
		GuestSessionID: &guest.Session.ID, Action: activityAction, Details: details,
		OperationID: &input.OperationID,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	scene, _, err := r.GetSceneAsGuest(ctx, tokenHash, domain.WhiteboardAccessView, now)
	if err != nil {
		return nil, err
	}
	if !patch {
		revision, err = scanWhiteboardRevision(r.db.QueryRow(ctx, `SELECT `+whiteboardRevisionColumns+`
			FROM whiteboard_revisions WHERE account_id=$1 AND board_id=$2 AND operation_id=$3`,
			guest.Session.AccountID, guest.Session.BoardID, input.OperationID))
		if err != nil {
			return nil, err
		}
	}
	return &domain.WhiteboardSceneWriteResult{Scene: scene, Revision: revision, OperationSequence: newSequence}, nil
}
