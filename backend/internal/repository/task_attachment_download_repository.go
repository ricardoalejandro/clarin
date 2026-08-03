package repository

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type TaskAttachmentDownload struct {
	ObjectKey   string
	Filename    string
	ContentType string
}

func taskAttachmentDownloadURL(taskID, attachmentID uuid.UUID) string {
	return fmt.Sprintf("/api/tasks/%s/attachments/%s/download", taskID, attachmentID)
}

func taskAttachmentPreviewDownloadURL(taskID, attachmentID uuid.UUID) string {
	return fmt.Sprintf("/api/tasks/%s/attachments/%s/preview/download", taskID, attachmentID)
}

// ResolveAttachmentDownload resolves storage identity only through the
// account+task+attachment composite identity. The caller still must pass the
// task ACL middleware before any bytes are served.
func (r *TaskWorkRepository) ResolveAttachmentDownload(ctx context.Context, accountID, taskID, attachmentID uuid.UUID, preview bool) (*TaskAttachmentDownload, error) {
	item := &TaskAttachmentDownload{}
	var err error
	if preview {
		err = r.db.QueryRow(ctx, `
			SELECT asset.object_key,asset.filename,asset.content_type
			FROM task_attachment_previews preview
			JOIN task_attachments attachment
			  ON attachment.account_id=preview.account_id
			 AND attachment.task_id=preview.task_id
			 AND attachment.id=preview.attachment_id
			JOIN media_assets asset
			  ON asset.account_id=preview.account_id
			 AND asset.id=preview.derivative_asset_id
			 AND asset.status='active'
			WHERE preview.account_id=$1 AND preview.task_id=$2
			  AND preview.attachment_id=$3 AND preview.status='ready'
			  AND COALESCE(attachment.attachment_scope,'task')<>'comment_draft'
		`, accountID, taskID, attachmentID).Scan(&item.ObjectKey, &item.Filename, &item.ContentType)
	} else {
		err = r.db.QueryRow(ctx, `
			SELECT asset.object_key,asset.filename,asset.content_type
			FROM task_attachments attachment
			JOIN media_assets asset
			  ON asset.account_id=attachment.account_id
			 AND asset.id=attachment.media_asset_id
			 AND asset.status='active'
			WHERE attachment.account_id=$1 AND attachment.task_id=$2 AND attachment.id=$3
			  AND COALESCE(attachment.attachment_scope,'task')<>'comment_draft'
		`, accountID, taskID, attachmentID).Scan(&item.ObjectKey, &item.Filename, &item.ContentType)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(item.ObjectKey, accountID.String()+"/") {
		return nil, ErrTaskWorkNotFound
	}
	return item, nil
}
