package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrTaskAttachmentUploadInProgress = errors.New("task attachment upload already in progress")

const (
	TaskAttachmentScopeTask         = "task"
	TaskAttachmentScopeComment      = "comment"
	TaskAttachmentScopeCommentDraft = "comment_draft"
	taskCommentAttachmentDraftTTL   = 24 * time.Hour
)

// reconcileTaskCommentDraftGCJobTx keeps the single asset-scoped GC job at
// the earliest outstanding comment-draft expiry. Media assets are deduplicated
// per account, so the same bytes may back drafts on several tasks; promoting
// one draft must never cancel cleanup for the others.
func reconcileTaskCommentDraftGCJobTx(ctx context.Context, tx pgx.Tx, accountID, assetID uuid.UUID) error {
	var nextExpiry *time.Time
	if err := tx.QueryRow(ctx, `SELECT MIN(draft_expires_at) FROM task_attachments
		WHERE account_id=$1 AND media_asset_id=$2 AND attachment_scope='comment_draft'`, accountID, assetID).Scan(&nextExpiry); err != nil {
		return err
	}
	if nextExpiry == nil {
		_, err := tx.Exec(ctx, `DELETE FROM task_media_gc_jobs WHERE account_id=$1 AND media_asset_id=$2`, accountID, assetID)
		return err
	}
	command, err := tx.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,status,available_at,updated_at)
		SELECT asset.account_id,asset.id,asset.object_key,'pending',$3,NOW()
		FROM media_assets asset WHERE asset.account_id=$1 AND asset.id=$2
		ON CONFLICT(account_id,media_asset_id) DO UPDATE SET object_key=EXCLUDED.object_key,
			status='pending',claim_token=NULL,last_error='',available_at=EXCLUDED.available_at,updated_at=NOW()`,
		accountID, assetID, *nextExpiry)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrTaskWorkNotFound
	}
	return nil
}

// ReserveTaskAttachmentAsset creates a durable upload reservation before any
// bytes are written to object storage. A concurrent request for the same hash
// reuses an active asset, or fails closed while the first upload is pending.
func (r *TaskWorkRepository) ReserveTaskAttachmentAsset(ctx context.Context, input MediaAssetUpsert) (*domain.MediaAsset, bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	asset := &domain.MediaAsset{}
	err = tx.QueryRow(ctx, `
		INSERT INTO media_assets (
			account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,'task_upload_pending',NOW())
		ON CONFLICT (account_id,content_hash) DO UPDATE SET
			object_key=CASE WHEN media_assets.status IN ('active','task_upload_pending') THEN media_assets.object_key ELSE EXCLUDED.object_key END,
			media_type=CASE WHEN media_assets.status IN ('active','task_upload_pending') THEN media_assets.media_type ELSE EXCLUDED.media_type END,
			content_type=CASE WHEN media_assets.status IN ('active','task_upload_pending') THEN media_assets.content_type ELSE EXCLUDED.content_type END,
			filename=CASE WHEN media_assets.status IN ('active','task_upload_pending') THEN media_assets.filename ELSE EXCLUDED.filename END,
			size_bytes=CASE WHEN media_assets.status IN ('active','task_upload_pending') THEN media_assets.size_bytes ELSE EXCLUDED.size_bytes END,
			status=CASE WHEN media_assets.status='active' THEN 'active' ELSE 'task_upload_pending' END,
			deleted_at=NULL,
			updated_at=NOW()
		RETURNING id,account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,created_at,updated_at,deleted_at
	`, input.AccountID, input.ContentHash, input.ObjectKey, input.MediaType, input.ContentType, input.Filename, input.SizeBytes).Scan(
		&asset.ID, &asset.AccountID, &asset.ContentHash, &asset.ObjectKey, &asset.MediaType,
		&asset.ContentType, &asset.Filename, &asset.SizeBytes, &asset.Status,
		&asset.CreatedAt, &asset.UpdatedAt, &asset.DeletedAt,
	)
	if err != nil {
		return nil, false, err
	}

	if asset.Status == "active" {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return asset, false, nil
	}
	if asset.ObjectKey != input.ObjectKey {
		return nil, false, ErrTaskAttachmentUploadInProgress
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (
			account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,'task_attachment','task_upload_pending',NOW()+INTERVAL '1 hour',NOW())
		ON CONFLICT (account_id,object_key) DO UPDATE SET
			media_type=EXCLUDED.media_type,content_type=EXCLUDED.content_type,filename=EXCLUDED.filename,
			size_bytes=EXCLUDED.size_bytes,source='task_attachment',status='task_upload_pending',
			deleted_at=NULL,next_delete_at=NOW()+INTERVAL '1 hour',updated_at=NOW()
	`, input.AccountID, input.ObjectKey, input.MediaType, input.ContentType, input.Filename, input.SizeBytes); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,available_at,updated_at)
		VALUES($1,$2,$3,NOW()+INTERVAL '1 hour',NOW())
		ON CONFLICT(account_id,media_asset_id) DO UPDATE SET
			object_key=EXCLUDED.object_key,status='pending',claim_token=NULL,last_error='',
			available_at=NOW()+INTERVAL '1 hour',updated_at=NOW()
	`, input.AccountID, asset.ID, input.ObjectKey); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return asset, true, nil
}

func (r *TaskWorkRepository) MarkTaskAttachmentUploadFailed(ctx context.Context, accountID, assetID uuid.UUID, cause string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
		UPDATE task_media_gc_jobs SET status='pending',claim_token=NULL,last_error=$3,
			available_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND media_asset_id=$2
	`, accountID, assetID, cause); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE storage_objects SET next_delete_at=NOW(),delete_error=$3,updated_at=NOW()
		WHERE account_id=$1 AND object_key=(SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2)
	`, accountID, assetID, cause); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// AttachReservedTaskAsset commits the task reference, activity record and
// inventory activation together. If this transaction fails, the reservation
// remains eligible for the durable task-media GC worker.
func (r *TaskWorkRepository) AttachReservedTaskAsset(ctx context.Context, accountID, taskID, assetID, userID, operationID uuid.UUID, requestedScope string) (*domain.TaskAttachment, bool, error) {
	if requestedScope != TaskAttachmentScopeTask && requestedScope != TaskAttachmentScopeCommentDraft {
		return nil, false, ErrTaskAccessInvalid
	}
	requiredAccess := domain.TaskAccessEdit
	if requestedScope == TaskAttachmentScopeCommentDraft {
		requiredAccess = domain.TaskAccessComment
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Re-authorize after the potentially long object upload and under the same
	// task/environment locks used by ACL replacement. A concurrent revocation
	// therefore wins before this transaction or waits until after it commits;
	// it can never race between authorization and the visible attachment link.
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, userID, []uuid.UUID{taskID}, requiredAccess); err != nil {
		return nil, false, err
	}

	var assetStatus, objectKey string
	if err := tx.QueryRow(ctx, `
		SELECT status,object_key FROM media_assets WHERE account_id=$1 AND id=$2 FOR UPDATE
	`, accountID, assetID).Scan(&assetStatus, &objectKey); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrTaskWorkNotFound
		}
		return nil, false, err
	}
	if assetStatus != "active" && assetStatus != "task_upload_pending" {
		return nil, false, ErrTaskWorkNotFound
	}

	attachmentID := uuid.New()
	createdAt := time.Now().UTC()
	draftExpiresAt := createdAt.Add(taskCommentAttachmentDraftTTL)
	changed := true
	var draftOwnerID *uuid.UUID
	var draftExpiry *time.Time
	if requestedScope == TaskAttachmentScopeCommentDraft {
		draftOwnerID = &userID
		draftExpiry = &draftExpiresAt
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO task_attachments(id,account_id,task_id,media_asset_id,uploaded_by,attachment_scope,draft_owner_id,draft_expires_at,created_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT DO NOTHING
		RETURNING id
	`, attachmentID, accountID, taskID, assetID, userID, requestedScope, draftOwnerID, draftExpiry, createdAt).Scan(&attachmentID)
	if errors.Is(err, pgx.ErrNoRows) {
		changed = false
		var currentScope string
		var currentDraftOwner *uuid.UUID
		var currentDraftExpiry *time.Time
		switch requestedScope {
		case TaskAttachmentScopeTask:
			err = tx.QueryRow(ctx, `SELECT id,COALESCE(attachment_scope,'task'),draft_owner_id,draft_expires_at
				FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND media_asset_id=$3
				  AND attachment_scope='task' FOR UPDATE`, accountID, taskID, assetID).
				Scan(&attachmentID, &currentScope, &currentDraftOwner, &currentDraftExpiry)
		case TaskAttachmentScopeCommentDraft:
			err = tx.QueryRow(ctx, `SELECT id,COALESCE(attachment_scope,'task'),draft_owner_id,draft_expires_at
				FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND media_asset_id=$3
				  AND attachment_scope='comment_draft' AND draft_owner_id=$4 FOR UPDATE`, accountID, taskID, assetID, userID).
				Scan(&attachmentID, &currentScope, &currentDraftOwner, &currentDraftExpiry)
		}
		if err != nil {
			return nil, false, err
		}
		switch requestedScope {
		case TaskAttachmentScopeCommentDraft:
			if currentScope == TaskAttachmentScopeCommentDraft {
				// The owner-scoped partial unique index makes retries idempotent
				// without letting another commenter's draft block this user.
				if currentDraftOwner == nil || *currentDraftOwner != userID {
					return nil, false, ErrTaskAccessInvalid
				}
				if currentDraftExpiry == nil || !currentDraftExpiry.After(createdAt) {
					if _, err := tx.Exec(ctx, `UPDATE task_attachments SET draft_expires_at=$4,uploaded_by=$3
						WHERE account_id=$1 AND id=$2`, accountID, attachmentID, userID, draftExpiresAt); err != nil {
						return nil, false, err
					}
					changed = true
					currentDraftExpiry = &draftExpiresAt
				}
			}
		case TaskAttachmentScopeTask:
			if currentScope != TaskAttachmentScopeTask {
				if _, err := tx.Exec(ctx, `UPDATE task_attachments SET attachment_scope='task',draft_owner_id=NULL,
					draft_expires_at=NULL,uploaded_by=$3 WHERE account_id=$1 AND id=$2`, accountID, attachmentID, userID); err != nil {
					return nil, false, err
				}
				changed = true
			}
		}
	} else if err != nil {
		return nil, false, err
	}

	if requestedScope == TaskAttachmentScopeTask && changed {
		metadata, _ := json.Marshal(map[string]any{"attachment_id": attachmentID, "operation_id": operationID})
		if _, err := tx.Exec(ctx, `
			INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
			VALUES($1,$2,$3,'attachment_added',$4::jsonb)
		`, accountID, taskID, userID, metadata); err != nil {
			return nil, false, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, assetID); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE storage_objects SET status='active',next_delete_at=NULL,delete_error='',deleted_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2
	`, accountID, objectKey); err != nil {
		return nil, false, err
	}
	var finalScope string
	var finalDraftExpiry *time.Time
	if err := tx.QueryRow(ctx, `SELECT COALESCE(attachment_scope,'task'),draft_expires_at FROM task_attachments
		WHERE account_id=$1 AND id=$2`, accountID, attachmentID).Scan(&finalScope, &finalDraftExpiry); err != nil {
		return nil, false, err
	}
	if finalScope == TaskAttachmentScopeCommentDraft && finalDraftExpiry == nil {
		return nil, false, ErrTaskAccessInvalid
	}
	if err := reconcileTaskCommentDraftGCJobTx(ctx, tx, accountID, assetID); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}

	item := &domain.TaskAttachment{}
	var ignoredKey string
	if err := r.db.QueryRow(ctx, `SELECT attachment.id,attachment.account_id,attachment.task_id,attachment.media_asset_id,
		media.filename,media.content_type,media.media_type,media.size_bytes,media.object_key,attachment.uploaded_by,attachment.created_at
		FROM task_attachments attachment JOIN media_assets media
		  ON media.account_id=attachment.account_id AND media.id=attachment.media_asset_id AND media.status='active'
		WHERE attachment.account_id=$1 AND attachment.task_id=$2 AND attachment.id=$3`, accountID, taskID, attachmentID).
		Scan(&item.ID, &item.AccountID, &item.TaskID, &item.MediaAssetID, &item.Filename, &item.ContentType,
			&item.MediaType, &item.SizeBytes, &ignoredKey, &item.UploadedBy, &item.CreatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrTaskWorkNotFound
		}
		return nil, false, err
	}
	item.URL = taskAttachmentDownloadURL(item.TaskID, item.ID)
	return item, changed, nil
}
