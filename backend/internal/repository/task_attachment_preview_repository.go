package repository

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func classifyTaskAttachmentPreview(filename, contentType string) (kind, status string) {
	contentType = strings.ToLower(strings.TrimSpace(contentType))
	ext := strings.ToLower(filepath.Ext(filename))
	switch {
	case strings.HasPrefix(contentType, "image/"):
		return "image", "ready"
	case contentType == "application/pdf" || ext == ".pdf":
		return "pdf", "ready"
	case strings.HasPrefix(contentType, "text/") || ext == ".txt":
		return "text", "ready"
	case ext == ".doc" || ext == ".docx" || strings.Contains(contentType, "word"):
		return "word_pdf", "pending"
	default:
		return "unsupported", "unsupported"
	}
}

func (r *TaskWorkRepository) EnsureAttachmentPreview(ctx context.Context, accountID, taskID, attachmentID uuid.UUID) (*domain.TaskAttachmentPreview, error) {
	var filename, contentType string
	if err := r.db.QueryRow(ctx, `SELECT ma.filename,ma.content_type FROM task_attachments ta JOIN media_assets ma ON ma.account_id=ta.account_id AND ma.id=ta.media_asset_id AND ma.status='active' WHERE ta.account_id=$1 AND ta.task_id=$2 AND ta.id=$3`, accountID, taskID, attachmentID).Scan(&filename, &contentType); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrTaskWorkNotFound
		}
		return nil, err
	}
	kind, status := classifyTaskAttachmentPreview(filename, contentType)
	item := &domain.TaskAttachmentPreview{}
	err := r.db.QueryRow(ctx, `INSERT INTO task_attachment_previews(account_id,task_id,attachment_id,kind,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,attachment_id) DO UPDATE SET updated_at=task_attachment_previews.updated_at RETURNING id,account_id,task_id,attachment_id,kind,status,derivative_asset_id,page_count,error,version,created_at,updated_at`, accountID, taskID, attachmentID, kind, status).Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AttachmentID, &item.Kind, &item.Status, &item.DerivativeAssetID, &item.PageCount, &item.Error, &item.Version, &item.CreatedAt, &item.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if item.Kind == "word_pdf" && item.Status != "ready" {
		_, err = r.db.Exec(ctx, `INSERT INTO task_attachment_preview_jobs(account_id,preview_id,status,available_at,updated_at) VALUES($1,$2,'pending',NOW(),NOW()) ON CONFLICT(preview_id) DO UPDATE SET status=CASE WHEN task_attachment_preview_jobs.status='complete' THEN task_attachment_preview_jobs.status ELSE 'pending' END,available_at=NOW(),updated_at=NOW()`, accountID, item.ID)
		if err != nil {
			return nil, err
		}
	}
	if item.DerivativeAssetID != nil {
		var key string
		if err := r.db.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2 AND status='active'`, accountID, *item.DerivativeAssetID).Scan(&key); err == nil {
			item.URL = "/api/media/file/" + key
		}
	}
	return item, nil
}

func (r *TaskWorkRepository) ListAttachmentComments(ctx context.Context, accountID, taskID, attachmentID uuid.UUID) ([]*domain.TaskAttachmentComment, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id,c.account_id,c.task_id,c.attachment_id,c.parent_id,c.author_id,COALESCE(u.display_name,u.username,''),c.body,c.anchor,c.resolved_at,c.resolved_by,c.version,c.created_at,c.updated_at FROM task_attachment_comments c JOIN users u ON u.id=c.author_id WHERE c.account_id=$1 AND c.task_id=$2 AND c.attachment_id=$3 AND c.deleted_at IS NULL ORDER BY c.created_at,c.id`, accountID, taskID, attachmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*domain.TaskAttachmentComment{}
	for rows.Next() {
		item := &domain.TaskAttachmentComment{Mentions: []*domain.TaskCommentMention{}}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AttachmentID, &item.ParentID, &item.AuthorID, &item.AuthorName, &item.Body, &item.Anchor, &item.ResolvedAt, &item.ResolvedBy, &item.Version, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range items {
		mentionRows, queryErr := r.db.Query(ctx, `SELECT m.user_id,COALESCE(u.display_name,u.username,''),u.username FROM task_attachment_comment_mentions m JOIN users u ON u.id=m.user_id WHERE m.account_id=$1 AND m.comment_id=$2 ORDER BY u.username`, accountID, item.ID)
		if queryErr != nil {
			return nil, queryErr
		}
		for mentionRows.Next() {
			mention := &domain.TaskCommentMention{}
			if err := mentionRows.Scan(&mention.UserID, &mention.DisplayName, &mention.Username); err != nil {
				mentionRows.Close()
				return nil, err
			}
			item.Mentions = append(item.Mentions, mention)
		}
		mentionRows.Close()
	}
	return items, nil
}

func (r *TaskWorkRepository) CreateAttachmentComment(ctx context.Context, item *domain.TaskAttachmentComment, mentions []uuid.UUID) error {
	if strings.TrimSpace(item.Body) == "" || len(item.Body) > 10000 || len(item.Anchor) > 32*1024 || !json.Valid(item.Anchor) {
		return ErrTaskBulkUpdateInvalid
	}
	item.ID = uuid.New()
	item.CreatedAt = time.Now()
	item.UpdatedAt = item.CreatedAt
	item.Version = 1
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if item.ParentID != nil {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_attachment_comments WHERE account_id=$1 AND task_id=$2 AND attachment_id=$3 AND id=$4 AND deleted_at IS NULL)`, item.AccountID, item.TaskID, item.AttachmentID, *item.ParentID).Scan(&exists); err != nil || !exists {
			if err != nil {
				return err
			}
			return ErrTaskWorkNotFound
		}
	}
	command, err := tx.Exec(ctx, `INSERT INTO task_attachment_comments(id,account_id,task_id,attachment_id,parent_id,author_id,body,anchor,version,created_at,updated_at) SELECT $1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$9 WHERE EXISTS(SELECT 1 FROM task_attachments WHERE account_id=$2 AND task_id=$3 AND id=$4)`, item.ID, item.AccountID, item.TaskID, item.AttachmentID, item.ParentID, item.AuthorID, strings.TrimSpace(item.Body), item.Anchor, item.CreatedAt)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrTaskWorkNotFound
	}
	for _, userID := range mentions {
		if _, err := tx.Exec(ctx, `INSERT INTO task_attachment_comment_mentions(comment_id,account_id,user_id) SELECT $1,$2,$3 WHERE EXISTS(SELECT 1 FROM user_accounts WHERE account_id=$2 AND user_id=$3) ON CONFLICT DO NOTHING`, item.ID, item.AccountID, userID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) SetAttachmentCommentResolved(ctx context.Context, accountID, taskID, attachmentID, commentID, actorID uuid.UUID, resolved bool, expectedVersion int64) error {
	command, err := r.db.Exec(ctx, `UPDATE task_attachment_comments SET resolved_at=CASE WHEN $6 THEN NOW() ELSE NULL END,resolved_by=CASE WHEN $6 THEN $5 ELSE NULL END,updated_at=NOW(),version=version+1 WHERE account_id=$1 AND task_id=$2 AND attachment_id=$3 AND id=$4 AND version=$7 AND deleted_at IS NULL`, accountID, taskID, attachmentID, commentID, actorID, resolved, expectedVersion)
	if err == nil && command.RowsAffected() == 0 {
		return ErrTaskVersionConflict
	}
	return err
}
