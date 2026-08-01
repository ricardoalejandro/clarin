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

var ErrTaskAttachmentPreviewRetryInvalid = errors.New("task attachment preview cannot be retried")
var ErrTaskAttachmentCommentInvalid = errors.New("task attachment comment is invalid")
var ErrTaskAttachmentCommentRootRequired = errors.New("only attachment comment roots can be resolved")
var ErrTaskAttachmentCommentThreadClosed = errors.New("attachment comment thread is resolved")

type taskAttachmentPreviewScanner interface {
	Scan(dest ...any) error
}

func scanTaskAttachmentPreview(row taskAttachmentPreviewScanner) (*domain.TaskAttachmentPreview, error) {
	item := &domain.TaskAttachmentPreview{}
	err := row.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AttachmentID, &item.Kind, &item.Status, &item.DerivativeAssetID, &item.PageCount, &item.Error, &item.Version, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func shouldEnsureTaskAttachmentPreviewJob(kind, status string) bool {
	return kind == "word_pdf" && status == "pending"
}

func taskAttachmentPreviewRetryTransition(kind, status string) (bool, error) {
	if kind != "word_pdf" {
		return false, ErrTaskAttachmentPreviewRetryInvalid
	}
	switch status {
	case "failed":
		return true, nil
	case "pending", "processing", "ready":
		return false, nil
	default:
		return false, ErrTaskAttachmentPreviewRetryInvalid
	}
}

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
	if _, err := r.db.Exec(ctx, `INSERT INTO task_attachment_previews(account_id,task_id,attachment_id,kind,status) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,attachment_id) DO NOTHING`, accountID, taskID, attachmentID, kind, status); err != nil {
		return nil, err
	}
	// Preview reads are deliberately read-only after the one-time insert. In
	// particular, polling a processing or failed conversion must not update its
	// state, timestamp or durable job.
	item, err := scanTaskAttachmentPreview(r.db.QueryRow(ctx, `SELECT id,account_id,task_id,attachment_id,kind,status,derivative_asset_id,page_count,error,version,created_at,updated_at FROM task_attachment_previews WHERE account_id=$1 AND task_id=$2 AND attachment_id=$3`, accountID, taskID, attachmentID))
	if err != nil {
		return nil, err
	}
	if shouldEnsureTaskAttachmentPreviewJob(item.Kind, item.Status) {
		// Reading preview state must never requeue a running/backoff job. The first
		// read only ensures that the durable job exists; retrying a failed job is an
		// explicit operation handled by RetryAttachmentPreview.
		_, err = r.db.Exec(ctx, `INSERT INTO task_attachment_preview_jobs(account_id,preview_id,status,available_at,updated_at) VALUES($1,$2,'pending',NOW(),NOW()) ON CONFLICT(preview_id) DO NOTHING`, accountID, item.ID)
		if err != nil {
			return nil, err
		}
	}
	if err := r.hydrateAttachmentPreviewURL(ctx, item); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *TaskWorkRepository) hydrateAttachmentPreviewURL(ctx context.Context, item *domain.TaskAttachmentPreview) error {
	if item.DerivativeAssetID != nil {
		var key string
		if err := r.db.QueryRow(ctx, `SELECT object_key FROM media_assets WHERE account_id=$1 AND id=$2 AND status='active'`, item.AccountID, *item.DerivativeAssetID).Scan(&key); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrTaskWorkNotFound
			}
			return err
		}
		item.URL = "/api/media/file/" + key
	}
	return nil
}

// RetryAttachmentPreview requeues only a terminal failed Word conversion.
// Repeating the same action while it is pending, processing or ready is a
// read-only success, which makes rapid/double submissions state-idempotent.
func (r *TaskWorkRepository) RetryAttachmentPreview(ctx context.Context, accountID, taskID, attachmentID uuid.UUID) (*domain.TaskAttachmentPreview, bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	item, err := scanTaskAttachmentPreview(tx.QueryRow(ctx, `SELECT p.id,p.account_id,p.task_id,p.attachment_id,p.kind,p.status,p.derivative_asset_id,p.page_count,p.error,p.version,p.created_at,p.updated_at
		FROM task_attachment_previews p
		JOIN task_attachments ta ON ta.account_id=p.account_id AND ta.task_id=p.task_id AND ta.id=p.attachment_id
		WHERE p.account_id=$1 AND p.task_id=$2 AND p.attachment_id=$3
		FOR UPDATE OF p`, accountID, taskID, attachmentID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrTaskWorkNotFound
		}
		return nil, false, err
	}
	requeue, err := taskAttachmentPreviewRetryTransition(item.Kind, item.Status)
	if err != nil {
		return nil, false, err
	}
	if requeue {
		if _, err := tx.Exec(ctx, `INSERT INTO task_attachment_preview_jobs(account_id,preview_id,status,attempts,available_at,locked_at,locked_by,last_error,updated_at)
			VALUES($1,$2,'pending',0,NOW(),NULL,NULL,'',NOW())
			ON CONFLICT(preview_id) DO UPDATE SET status='pending',attempts=0,available_at=NOW(),locked_at=NULL,locked_by=NULL,last_error='',updated_at=NOW()`, accountID, item.ID); err != nil {
			return nil, false, err
		}
		item, err = scanTaskAttachmentPreview(tx.QueryRow(ctx, `UPDATE task_attachment_previews SET status='pending',error='',updated_at=NOW(),version=version+1
			WHERE id=$1 AND account_id=$2 RETURNING id,account_id,task_id,attachment_id,kind,status,derivative_asset_id,page_count,error,version,created_at,updated_at`, item.ID, accountID))
		if err != nil {
			return nil, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	if err := r.hydrateAttachmentPreviewURL(ctx, item); err != nil {
		return nil, false, err
	}
	return item, requeue, nil
}

func (r *TaskWorkRepository) ListAttachmentComments(ctx context.Context, accountID, taskID, attachmentID uuid.UUID) ([]*domain.TaskAttachmentComment, error) {
	rows, err := r.db.Query(ctx, `SELECT c.id,c.account_id,c.task_id,c.attachment_id,c.parent_id,c.author_id,
		COALESCE(author.display_name,author.username,''),CASE WHEN c.deleted_at IS NULL THEN c.body ELSE '' END,
		c.anchor,c.resolved_at,c.resolved_by,COALESCE(resolver.display_name,resolver.username,''),c.edited_at,
		(c.deleted_at IS NOT NULL),c.version,c.created_at,c.updated_at
		FROM task_attachment_comments c
		JOIN users author ON author.id=c.author_id
		LEFT JOIN users resolver ON resolver.id=c.resolved_by
		WHERE c.account_id=$1 AND c.task_id=$2 AND c.attachment_id=$3 AND (
			c.deleted_at IS NULL OR (
				c.parent_id IS NULL AND EXISTS(
					SELECT 1 FROM task_attachment_comments reply
					WHERE reply.account_id=c.account_id AND reply.task_id=c.task_id
						AND reply.attachment_id=c.attachment_id AND reply.parent_id=c.id
						AND reply.deleted_at IS NULL
				)
			)
		)
		ORDER BY c.created_at,c.id`, accountID, taskID, attachmentID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []*domain.TaskAttachmentComment{}
	for rows.Next() {
		item := &domain.TaskAttachmentComment{Mentions: []*domain.TaskCommentMention{}}
		if err := rows.Scan(&item.ID, &item.AccountID, &item.TaskID, &item.AttachmentID, &item.ParentID, &item.AuthorID, &item.AuthorName, &item.Body, &item.Anchor, &item.ResolvedAt, &item.ResolvedBy, &item.ResolvedByName, &item.EditedAt, &item.Deleted, &item.Version, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range items {
		if item.Deleted {
			continue
		}
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
		var parentID *uuid.UUID
		var resolvedAt, deletedAt *time.Time
		err := tx.QueryRow(ctx, `SELECT parent_id,resolved_at,deleted_at FROM task_attachment_comments
			WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid
			FOR UPDATE`, item.AccountID, item.TaskID, item.AttachmentID, *item.ParentID).Scan(&parentID, &resolvedAt, &deletedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrTaskWorkNotFound
		}
		if err != nil {
			return err
		}
		if parentID != nil {
			return ErrTaskAttachmentCommentRootRequired
		}
		if resolvedAt != nil || deletedAt != nil {
			return ErrTaskAttachmentCommentThreadClosed
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

type lockedAttachmentComment struct {
	authorID uuid.UUID
	parentID *uuid.UUID
	resolved bool
	deleted  bool
	version  int64
}

func lockAttachmentComment(ctx context.Context, tx pgx.Tx, accountID, taskID, attachmentID, commentID uuid.UUID) (*lockedAttachmentComment, error) {
	item := &lockedAttachmentComment{}
	var resolvedAt, deletedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT author_id,parent_id,resolved_at,deleted_at,version
		FROM task_attachment_comments
		WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid
		FOR UPDATE`, accountID, taskID, attachmentID, commentID).
		Scan(&item.authorID, &item.parentID, &resolvedAt, &deletedAt, &item.version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrTaskWorkNotFound
	}
	if err != nil {
		return nil, err
	}
	item.resolved = resolvedAt != nil
	item.deleted = deletedAt != nil
	return item, nil
}

func ensureAttachmentThreadOpen(ctx context.Context, tx pgx.Tx, accountID, taskID, attachmentID uuid.UUID, item *lockedAttachmentComment) error {
	if item.deleted {
		return ErrTaskWorkNotFound
	}
	if item.parentID == nil {
		if item.resolved {
			return ErrTaskAttachmentCommentThreadClosed
		}
		return nil
	}
	var resolvedAt, deletedAt *time.Time
	err := tx.QueryRow(ctx, `SELECT resolved_at,deleted_at FROM task_attachment_comments
		WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid AND parent_id IS NULL
		FOR UPDATE`, accountID, taskID, attachmentID, *item.parentID).Scan(&resolvedAt, &deletedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	if err != nil {
		return err
	}
	if resolvedAt != nil {
		return ErrTaskAttachmentCommentThreadClosed
	}
	// A deleted root remains as a traceable tombstone while replies exist.
	// Existing replies keep their own author/admin edit and delete lifecycle,
	// but CreateAttachmentComment still prevents adding new replies to it.
	return nil
}

func insertAttachmentCommentActivity(ctx context.Context, tx pgx.Tx, accountID, taskID, actorID uuid.UUID, action string, metadata map[string]any) error {
	payload, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata)
		VALUES($1::uuid,$2::uuid,$3::uuid,$4::text,$5::jsonb)`, accountID, taskID, actorID, action, payload)
	return err
}

func (r *TaskWorkRepository) SetAttachmentCommentResolved(ctx context.Context, accountID, taskID, attachmentID, commentID, actorID uuid.UUID, resolved bool, expectedVersion int64, operationID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := lockAttachmentComment(ctx, tx, accountID, taskID, attachmentID, commentID)
	if err != nil {
		return err
	}
	if item.deleted {
		return ErrTaskWorkNotFound
	}
	if item.parentID != nil {
		return ErrTaskAttachmentCommentRootRequired
	}
	if item.version != expectedVersion {
		return ErrTaskVersionConflict
	}
	_, err = tx.Exec(ctx, `UPDATE task_attachment_comments SET
		resolved_at=CASE WHEN $6::boolean THEN NOW() ELSE NULL END,
		resolved_by=CASE WHEN $6::boolean THEN $5::uuid ELSE NULL::uuid END,
		updated_at=NOW(),version=version+1
		WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid`, accountID, taskID, attachmentID, commentID, actorID, resolved)
	if err != nil {
		return err
	}
	action := "attachment_comment_reopened"
	if resolved {
		action = "attachment_comment_resolved"
	}
	if err := insertAttachmentCommentActivity(ctx, tx, accountID, taskID, actorID, action, map[string]any{"attachment_id": attachmentID, "comment_id": commentID, "operation_id": operationID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) UpdateAttachmentComment(ctx context.Context, accountID, taskID, attachmentID, commentID, actorID uuid.UUID, admin bool, body string, mentions []uuid.UUID, expectedVersion int64, operationID uuid.UUID) error {
	body = strings.TrimSpace(body)
	if body == "" || len(body) > 10000 {
		return ErrTaskAttachmentCommentInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := lockAttachmentComment(ctx, tx, accountID, taskID, attachmentID, commentID)
	if err != nil {
		return err
	}
	if item.version != expectedVersion {
		return ErrTaskVersionConflict
	}
	if item.authorID != actorID && !admin {
		return ErrTaskWorkNotFound
	}
	if err := ensureAttachmentThreadOpen(ctx, tx, accountID, taskID, attachmentID, item); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_attachment_comments SET body=$5::text,edited_at=NOW(),updated_at=NOW(),version=version+1
		WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid`, accountID, taskID, attachmentID, commentID, body); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_attachment_comment_mentions WHERE account_id=$1::uuid AND comment_id=$2::uuid`, accountID, commentID); err != nil {
		return err
	}
	seen := map[uuid.UUID]struct{}{}
	for _, userID := range mentions {
		if userID == actorID {
			continue
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		command, err := tx.Exec(ctx, `INSERT INTO task_attachment_comment_mentions(comment_id,account_id,user_id)
			SELECT $1::uuid,$2::uuid,$3::uuid WHERE EXISTS(
				SELECT 1 FROM user_accounts WHERE account_id=$2::uuid AND user_id=$3::uuid
			)`, commentID, accountID, userID)
		if err != nil || command.RowsAffected() != 1 {
			if err != nil {
				return err
			}
			return ErrTaskAttachmentCommentInvalid
		}
	}
	if err := insertAttachmentCommentActivity(ctx, tx, accountID, taskID, actorID, "attachment_comment_updated", map[string]any{"attachment_id": attachmentID, "comment_id": commentID, "operation_id": operationID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *TaskWorkRepository) DeleteAttachmentComment(ctx context.Context, accountID, taskID, attachmentID, commentID, actorID uuid.UUID, admin bool, expectedVersion int64, operationID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	item, err := lockAttachmentComment(ctx, tx, accountID, taskID, attachmentID, commentID)
	if err != nil {
		return err
	}
	if item.version != expectedVersion {
		return ErrTaskVersionConflict
	}
	if item.authorID != actorID && !admin {
		return ErrTaskWorkNotFound
	}
	if err := ensureAttachmentThreadOpen(ctx, tx, accountID, taskID, attachmentID, item); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE task_attachment_comments SET deleted_at=NOW(),updated_at=NOW(),version=version+1
		WHERE account_id=$1::uuid AND task_id=$2::uuid AND attachment_id=$3::uuid AND id=$4::uuid`, accountID, taskID, attachmentID, commentID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_attachment_comment_mentions WHERE account_id=$1::uuid AND comment_id=$2::uuid`, accountID, commentID); err != nil {
		return err
	}
	if err := insertAttachmentCommentActivity(ctx, tx, accountID, taskID, actorID, "attachment_comment_deleted", map[string]any{"attachment_id": attachmentID, "comment_id": commentID, "parent_id": item.parentID, "operation_id": operationID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
