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

// PrivateStorageReference is an actor-authorized projection, never the proof
// used for physical deletion. Hidden references must remain in that proof.
type PrivateStorageReference struct {
	Kind, Origin, ObjectKey, Label, Href, Filename, Version, BlockedReason string
	ID, ParentID                                                           uuid.UUID
	CanRemove                                                              bool
}

type StoragePrivateMediaQuerier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

// One statement may inspect hundreds of assets belonging to the same board.
// Evaluate the canonical account/actor hierarchy once, then join by board ID.
// This is a statement-local relation, never a persisted authorization cache.
func StoragePrivateWhiteboardACLCTE(accountParam, actorParam string) string {
	return strings.ReplaceAll(strings.ReplaceAll(whiteboardHubAccessCTE, "$1", accountParam), "$2", actorParam) + ` SELECT id,account_id,effective_level,archived_at,view_deleted_at,work_lifecycle FROM visible`
}
func storagePrivateWhiteboardRelation(accountParam, actorParam string, factored []bool) (string, string) {
	if len(factored) > 0 && factored[0] {
		return "", "storage_private_visible_boards"
	}
	return strings.ReplaceAll(strings.ReplaceAll(whiteboardHubAccessCTE, "$1", accountParam), "$2", actorParam), "visible"
}

// Only internally supplied SQL aliases/parameter expressions may be passed.
// The same canonical Work/Whiteboard policy is evaluated before pagination.
func StoragePrivateMediaAccessSQL(refAlias, actorParam string, factored ...bool) string {
	task := `EXISTS(SELECT 1 FROM task_attachments storage_attachment
		JOIN tasks storage_task ON storage_task.account_id=storage_attachment.account_id AND storage_task.id=storage_attachment.task_id
		JOIN task_lists storage_list ON storage_list.account_id=storage_task.account_id AND storage_list.id=storage_task.list_id
		WHERE storage_attachment.account_id=` + refAlias + `.account_id AND storage_attachment.id::text=` + refAlias + `.source_id
		AND storage_attachment.storage_removed_at IS NULL AND storage_task.deleted_at IS NULL
		AND (storage_attachment.attachment_scope<>'comment_draft' OR storage_attachment.draft_owner_id=` + actorParam + `)
		AND ` + taskActorCanViewSQL("storage_task", "storage_list", actorParam) + `)`
	boardCTE, boardTable := storagePrivateWhiteboardRelation(refAlias+".account_id", actorParam, factored)
	board := `EXISTS(` + boardCTE + ` SELECT 1 FROM ` + boardTable + ` storage_board JOIN whiteboard_assets storage_asset
		ON storage_asset.account_id=storage_board.account_id AND storage_asset.board_id=storage_board.id
		WHERE storage_asset.id::text=` + refAlias + `.source_id AND storage_asset.kind='asset' AND storage_board.effective_level<>'none'
		AND storage_board.archived_at IS NULL AND storage_board.view_deleted_at IS NULL
		AND (storage_asset.committed_at IS NOT NULL OR storage_asset.uploaded_by=` + actorParam + `))`
	history := `EXISTS(` + boardCTE + ` SELECT 1 FROM ` + boardTable + ` storage_board JOIN whiteboard_revision_assets storage_revision
		ON storage_revision.account_id=storage_board.account_id AND storage_revision.board_id=storage_board.id
		WHERE storage_revision.id::text=` + refAlias + `.source_id AND storage_board.effective_level<>'none')`
	library := `EXISTS(SELECT 1 FROM whiteboard_assets storage_asset JOIN whiteboard_libraries storage_library
		ON storage_library.account_id=storage_asset.account_id AND storage_library.id=storage_asset.library_id
		JOIN users storage_actor ON storage_actor.id=` + actorParam + ` AND storage_actor.is_active
		JOIN user_accounts storage_member ON storage_member.account_id=storage_library.account_id AND storage_member.user_id=storage_actor.id
		WHERE storage_asset.account_id=` + refAlias + `.account_id AND storage_asset.id::text=` + refAlias + `.source_id
		AND storage_asset.kind='asset' AND storage_library.archived_at IS NULL
		AND (storage_library.created_by=storage_actor.id OR storage_library.visibility='account'
		 OR storage_member.role IN ('admin','super_admin') OR storage_actor.is_super_admin)
		AND (storage_asset.committed_at IS NOT NULL OR storage_asset.uploaded_by=storage_actor.id))`
	return `(CASE ` + refAlias + `.source_kind WHEN 'task_attachments' THEN (` + storagePrivateModuleAccessSQL(refAlias+".account_id", actorParam, domain.PermTasks) + ` AND ` + task + `)
		 WHEN 'whiteboard_assets' THEN (` + storagePrivateModuleAccessSQL(refAlias+".account_id", actorParam, domain.PermWhiteboards) + ` AND (` + board + ` OR ` + library + `)) WHEN 'whiteboard_revision_assets' THEN (` + storagePrivateModuleAccessSQL(refAlias+".account_id", actorParam, domain.PermWhiteboards) + ` AND ` + history + `) ELSE FALSE END)`
}

func storagePrivateModuleAccessSQL(accountParam, actorParam, permission string) string {
	return `EXISTS(SELECT 1 FROM user_accounts storage_membership JOIN users storage_user ON storage_user.id=storage_membership.user_id AND storage_user.is_active
		LEFT JOIN roles storage_role ON storage_role.id=storage_membership.role_id WHERE storage_membership.account_id=` + accountParam + ` AND storage_membership.user_id=` + actorParam + `
		AND (storage_membership.role IN ('admin','super_admin') OR storage_user.is_super_admin OR '` + permission + `'=ANY(COALESCE(storage_role.permissions,'{}'::text[])) OR '*'=ANY(COALESCE(storage_role.permissions,'{}'::text[]))))`
}

// Recovery identity comes from the server-owned snapshot. Account ownership of
// the ledger does not replace the resource's current ACL after revocation.
func StoragePrivateMediaRecoveryAccessSQL(recoveryAlias, actorParam string, factored ...bool) string {
	account := recoveryAlias + ".account_id"
	task := `EXISTS(SELECT 1 FROM task_attachments storage_attachment
		JOIN tasks storage_task ON storage_task.account_id=storage_attachment.account_id AND storage_task.id=storage_attachment.task_id
		JOIN task_lists storage_list ON storage_list.account_id=storage_task.account_id AND storage_list.id=storage_task.list_id
		WHERE storage_attachment.account_id=` + account + ` AND storage_attachment.id::text=` + recoveryAlias + `.snapshot->>'source_id'
		AND storage_task.id::text=` + recoveryAlias + `.snapshot->>'parent_id' AND storage_attachment.storage_removed_at IS NOT NULL
		AND storage_task.deleted_at IS NULL AND (storage_attachment.attachment_scope<>'comment_draft' OR storage_attachment.draft_owner_id=` + actorParam + `)
		AND ` + taskActorCanViewSQL("storage_task", "storage_list", actorParam) + `)`
	boardCTE, boardTable := storagePrivateWhiteboardRelation(account, actorParam, factored)
	board := `EXISTS(` + boardCTE + ` SELECT 1 FROM ` + boardTable + ` storage_board WHERE storage_board.id::text=` + recoveryAlias + `.snapshot->>'parent_id' AND effective_level<>'none'
		AND (` + recoveryAlias + `.snapshot->'before'->>'committed_at' IS NOT NULL OR ` + recoveryAlias + `.snapshot->'before'->>'uploaded_by'=` + actorParam + `::text))`
	admin := taskActorAdminSQL(recoveryAlias, actorParam)
	taskGone := `NOT EXISTS(SELECT 1 FROM tasks parent WHERE parent.account_id=` + account + ` AND parent.id::text=` + recoveryAlias + `.snapshot->>'parent_id')`
	boardGone := `NOT EXISTS(SELECT 1 FROM whiteboards parent WHERE parent.account_id=` + account + ` AND parent.id::text=` + recoveryAlias + `.snapshot->>'parent_id')`
	return `(CASE ` + recoveryAlias + `.adapter WHEN 'private_work' THEN (` + storagePrivateModuleAccessSQL(account, actorParam, domain.PermTasks) + ` AND (` + task + ` OR (` + admin + ` AND ` + taskGone + `)))
		WHEN 'private_whiteboards' THEN (` + storagePrivateModuleAccessSQL(account, actorParam, domain.PermWhiteboards) + ` AND (` + board + ` OR (` + admin + ` AND ` + boardGone + `))) ELSE FALSE END)`
}

func StoragePrivateMediaMutationSQL(refAlias, actorParam string, factored ...bool) string {
	task := `EXISTS(SELECT 1 FROM task_attachments attachment JOIN tasks task ON task.account_id=attachment.account_id AND task.id=attachment.task_id
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE attachment.account_id=` + refAlias + `.account_id AND attachment.id::text=` + refAlias + `.source_id AND attachment.storage_removed_at IS NULL
		AND (` + taskActorAccessRankSQL("task", "list_item", actorParam) + `)>=3
		AND (attachment.attachment_scope<>'comment_draft' OR (attachment.draft_owner_id=` + actorParam + ` AND attachment.draft_expires_at<=NOW())))`
	cte, boardTable := storagePrivateWhiteboardRelation(refAlias+".account_id", actorParam, factored)
	board := `EXISTS(` + cte + ` SELECT 1 FROM ` + boardTable + ` board JOIN whiteboard_assets link ON link.account_id=board.account_id AND link.board_id=board.id
		WHERE link.id::text=` + refAlias + `.source_id AND board.effective_level IN ('edit','manage') AND board.archived_at IS NULL AND board.view_deleted_at IS NULL
		AND board.work_lifecycle IN ('','active') AND (link.committed_at IS NOT NULL OR (link.uploaded_by=` + actorParam + ` AND link.draft_expires_at<=NOW())))`
	return `(` + StoragePrivateMediaAccessSQL(refAlias, actorParam, factored...) + ` AND CASE ` + refAlias + `.source_kind WHEN 'task_attachments' THEN ` + task + ` WHEN 'whiteboard_assets' THEN ` + board + ` ELSE FALSE END)`
}

// This capability is specifically restoration: deleted containers cannot be
// recreated through storage, even when an administrator may purge their bytes.
func StoragePrivateMediaRecoveryMutationSQL(recoveryAlias, actorParam string, factored ...bool) string {
	account := recoveryAlias + ".account_id"
	task := `EXISTS(SELECT 1 FROM tasks task JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=` + account + ` AND task.id::text=` + recoveryAlias + `.snapshot->>'parent_id' AND task.deleted_at IS NULL
		AND ` + taskActorCanViewSQL("task", "list_item", actorParam) + ` AND (` + taskActorAccessRankSQL("task", "list_item", actorParam) + `)>=3)`
	cte, boardTable := storagePrivateWhiteboardRelation(account, actorParam, factored)
	board := `EXISTS(` + cte + ` SELECT 1 FROM ` + boardTable + ` board WHERE board.id::text=` + recoveryAlias + `.snapshot->>'parent_id'
		AND effective_level IN ('edit','manage') AND archived_at IS NULL AND view_deleted_at IS NULL AND work_lifecycle IN ('','active'))`
	return `(` + StoragePrivateMediaRecoveryAccessSQL(recoveryAlias, actorParam, factored...) + ` AND CASE ` + recoveryAlias + `.adapter WHEN 'private_work' THEN ` + task + ` WHEN 'private_whiteboards' THEN ` + board + ` ELSE FALSE END)`
}

func AuthorizePrivateStorageRecovery(ctx context.Context, q StoragePrivateMediaQuerier, accountID, actorID, parentID uuid.UUID, whiteboards, mutate bool) error {
	if whiteboards {
		access, location, err := resolveWhiteboardActorAccessWith(ctx, q, accountID, actorID, parentID)
		if err != nil {
			return err
		}
		if access == nil || !access.CanView {
			return ErrWhiteboardNotFound
		}
		if mutate {
			var archived bool
			if err := q.QueryRow(ctx, `SELECT archived_at IS NOT NULL FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, parentID).Scan(&archived); err != nil {
				return err
			}
			if archived || !access.CanEdit || (location != nil && location.Lifecycle != domain.WhiteboardWorkLifecycleActive) {
				return ErrWhiteboardForbidden
			}
		}
		return nil
	}
	var rank int
	err := q.QueryRow(ctx, `SELECT `+taskActorAccessRankSQL("task", "list_item", "$2")+` FROM tasks task
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		WHERE task.account_id=$1 AND task.id=$3 AND task.deleted_at IS NULL AND `+taskActorCanViewSQL("task", "list_item", "$2"), accountID, actorID, parentID).Scan(&rank)
	if err != nil {
		return privateStorageMissing(err)
	}
	if rank < 1 {
		return ErrTaskWorkNotFound
	}
	if mutate && rank < 3 {
		return ErrTaskAccessDenied
	}
	return nil
}

func ListTaskStorageReferences(ctx context.Context, q StoragePrivateMediaQuerier, accountID, actorID uuid.UUID, keys []string, selected ...[]uuid.UUID) ([]PrivateStorageReference, error) {
	var ids []uuid.UUID
	if len(selected) > 0 {
		ids = selected[0]
	}
	rows, err := q.Query(ctx, `SELECT attachment.id,task.id,asset.object_key,task.title,asset.filename,
		task.version::text||':'||attachment.attachment_scope,
		(`+taskActorAccessRankSQL("task", "list_item", "$2")+`)>=3,
		attachment.attachment_scope,attachment.draft_owner_id,attachment.draft_expires_at
		FROM task_attachments attachment
		JOIN tasks task ON task.account_id=attachment.account_id AND task.id=attachment.task_id
		JOIN task_lists list_item ON list_item.account_id=task.account_id AND list_item.id=task.list_id
		JOIN media_assets asset ON asset.account_id=attachment.account_id AND asset.id=attachment.media_asset_id AND asset.status='active'
		WHERE attachment.account_id=$1 AND attachment.storage_removed_at IS NULL AND task.deleted_at IS NULL
		AND ($3::text[] IS NULL OR asset.object_key=ANY($3::text[])) AND ($4::uuid[] IS NULL OR attachment.id=ANY($4::uuid[]))
		AND (attachment.attachment_scope<>'comment_draft' OR attachment.draft_owner_id=$2)
		AND `+taskActorCanViewSQL("task", "list_item", "$2")+` ORDER BY attachment.id`, accountID, actorID, keys, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []PrivateStorageReference{}
	for rows.Next() {
		ref := PrivateStorageReference{Kind: "task_attachments", Origin: "tasks"}
		var scope string
		var owner *uuid.UUID
		var expiry *time.Time
		if err := rows.Scan(&ref.ID, &ref.ParentID, &ref.ObjectKey, &ref.Label, &ref.Filename, &ref.Version, &ref.CanRemove, &scope, &owner, &expiry); err != nil {
			return nil, err
		}
		ref.Href = "/dashboard/tasks?task=" + ref.ParentID.String()
		if scope == TaskAttachmentScopeCommentDraft {
			ref.CanRemove = ref.CanRemove && owner != nil && *owner == actorID && expiry != nil && !expiry.After(time.Now())
			ref.Label += " · Carga sin publicar"
		}
		if !ref.CanRemove {
			ref.BlockedReason = "Necesitas permiso para editar esta tarea; las cargas recientes se conservan mientras se publican."
		}
		result = append(result, ref)
	}
	return result, rows.Err()
}

type taskStorageRemovalSnapshot struct {
	AttachmentID uuid.UUID `json:"attachment_id"`
	TaskID       uuid.UUID `json:"task_id"`
	RecoveryID   uuid.UUID `json:"recovery_id"`
	ObjectKey    string    `json:"object_key"`
	Scope        string    `json:"attachment_scope"`
}

// Owning the account's storage does not expose another person's unpublished
// comment draft. Check the actual removed row as well as its parent ACL.
func AuthorizeTaskStorageRemovalRecovery(ctx context.Context, q StoragePrivateMediaQuerier, accountID, actorID, attachmentID, taskID uuid.UUID, backup json.RawMessage) error {
	var snapshot taskStorageRemovalSnapshot
	if json.Unmarshal(backup, &snapshot) != nil || snapshot.AttachmentID != attachmentID || snapshot.TaskID != taskID || snapshot.RecoveryID == uuid.Nil {
		return ErrTaskAccessInvalid
	}
	var allowed bool
	err := q.QueryRow(ctx, `SELECT attachment_scope<>'comment_draft' OR draft_owner_id=$4
		FROM task_attachments WHERE account_id=$1 AND id=$2 AND task_id=$3 AND storage_removed_at IS NOT NULL AND storage_removal_id=$5`,
		accountID, attachmentID, taskID, actorID, snapshot.RecoveryID).Scan(&allowed)
	if err != nil {
		return privateStorageMissing(err)
	}
	if !allowed {
		return ErrTaskAccessDenied
	}
	return nil
}

// RemoveTaskStorageReferenceTx retains every annotation and comment relation.
// The caller owns the per-account storage barrier and the recovery ledger.
func RemoveTaskStorageReferenceTx(ctx context.Context, tx pgx.Tx, accountID, actorID, attachmentID, recoveryID, operationID uuid.UUID, expectedVersion string) (json.RawMessage, uuid.UUID, error) {
	var taskID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT task_id FROM task_attachments WHERE account_id=$1 AND id=$2 AND storage_removed_at IS NULL`, accountID, attachmentID).Scan(&taskID); err != nil {
		return nil, uuid.Nil, err
	}
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{taskID}, domain.TaskAccessEdit); err != nil {
		return nil, uuid.Nil, err
	}
	var key, scope, version string
	var owner *uuid.UUID
	var expiry *time.Time
	err := tx.QueryRow(ctx, `SELECT asset.object_key,attachment.attachment_scope,attachment.draft_owner_id,attachment.draft_expires_at,task.version::text||':'||attachment.attachment_scope
		FROM task_attachments attachment JOIN media_assets asset ON asset.account_id=attachment.account_id AND asset.id=attachment.media_asset_id
		JOIN tasks task ON task.account_id=attachment.account_id AND task.id=attachment.task_id
		WHERE attachment.account_id=$1 AND attachment.id=$2 AND attachment.task_id=$3 AND attachment.storage_removed_at IS NULL AND asset.status='active'
		FOR UPDATE OF attachment,asset`, accountID, attachmentID, taskID).Scan(&key, &scope, &owner, &expiry, &version)
	if err != nil {
		return nil, uuid.Nil, err
	}
	if version != expectedVersion {
		return nil, uuid.Nil, ErrTaskAccessRevisionConflict
	}
	if scope == TaskAttachmentScopeCommentDraft && (owner == nil || *owner != actorID || expiry == nil || expiry.After(time.Now())) {
		return nil, uuid.Nil, ErrTaskAccessDenied
	}
	if _, err = tx.Exec(ctx, `UPDATE task_attachments SET storage_removed_at=NOW(),storage_removal_id=$3 WHERE account_id=$1 AND id=$2`, accountID, attachmentID, recoveryID); err != nil {
		return nil, uuid.Nil, err
	}
	metadata, _ := json.Marshal(map[string]any{"attachment_id": attachmentID, "operation_id": operationID, "origin": "storage"})
	if _, err = tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata) VALUES($1,$2,$3,'attachment_deleted',$4::jsonb)`, accountID, taskID, actorID, metadata); err != nil {
		return nil, uuid.Nil, err
	}
	snapshot, _ := json.Marshal(taskStorageRemovalSnapshot{attachmentID, taskID, recoveryID, key, scope})
	return snapshot, taskID, nil
}

func RestoreTaskStorageReferenceTx(ctx context.Context, tx pgx.Tx, accountID, actorID, recoveryID, operationID uuid.UUID, backup json.RawMessage) (uuid.UUID, error) {
	var snapshot taskStorageRemovalSnapshot
	if json.Unmarshal(backup, &snapshot) != nil || snapshot.AttachmentID == uuid.Nil || snapshot.TaskID == uuid.Nil || snapshot.RecoveryID != recoveryID {
		return uuid.Nil, ErrTaskAccessInvalid
	}
	if err := lockAndRequireTaskAccessTx(ctx, tx, accountID, actorID, []uuid.UUID{snapshot.TaskID}, domain.TaskAccessEdit); err != nil {
		return uuid.Nil, err
	}
	var scope string
	var owner *uuid.UUID
	err := tx.QueryRow(ctx, `SELECT attachment_scope,draft_owner_id FROM task_attachments WHERE account_id=$1 AND id=$2 AND task_id=$3
		AND storage_removal_id=$4 AND storage_removed_at IS NOT NULL FOR UPDATE`, accountID, snapshot.AttachmentID, snapshot.TaskID, recoveryID).Scan(&scope, &owner)
	if err != nil {
		return uuid.Nil, err
	}
	if scope == TaskAttachmentScopeCommentDraft && (owner == nil || *owner != actorID) {
		return uuid.Nil, ErrTaskAccessDenied
	}
	if scope == TaskAttachmentScopeComment {
		var available bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_comment_attachments relation JOIN task_comments comment
		 ON comment.account_id=relation.account_id AND comment.task_id=relation.task_id AND comment.id=relation.comment_id
		 WHERE relation.account_id=$1 AND relation.task_id=$2 AND relation.attachment_id=$3 AND comment.deleted_at IS NULL)`, accountID, snapshot.TaskID, snapshot.AttachmentID).Scan(&available); err != nil {
			return uuid.Nil, err
		}
		if !available {
			return uuid.Nil, ErrTaskAccessRevisionConflict
		}
	}
	command, err := tx.Exec(ctx, `UPDATE task_attachments attachment SET storage_removed_at=NULL,storage_removal_id=NULL,
		draft_expires_at=CASE WHEN attachment_scope='comment_draft' THEN NOW()+INTERVAL '24 hours' ELSE draft_expires_at END
		WHERE attachment.account_id=$1 AND attachment.id=$2 AND EXISTS(SELECT 1 FROM media_assets asset WHERE asset.account_id=attachment.account_id
		AND asset.id=attachment.media_asset_id AND asset.object_key=$3 AND asset.status='active')
		AND NOT EXISTS(SELECT 1 FROM task_attachments newer WHERE newer.account_id=attachment.account_id
		 AND newer.task_id=attachment.task_id AND newer.media_asset_id=attachment.media_asset_id AND newer.id<>attachment.id
		 AND newer.storage_removed_at IS NULL AND newer.attachment_scope=attachment.attachment_scope
		 AND (attachment.attachment_scope='task' OR (attachment.attachment_scope='comment_draft' AND newer.draft_owner_id=attachment.draft_owner_id)))`, accountID, snapshot.AttachmentID, snapshot.ObjectKey)
	if err != nil {
		return uuid.Nil, err
	}
	if command.RowsAffected() != 1 {
		return uuid.Nil, ErrTaskWorkNotFound
	}
	metadata, _ := json.Marshal(map[string]any{"attachment_id": snapshot.AttachmentID, "operation_id": operationID, "origin": "storage"})
	if _, err = tx.Exec(ctx, `INSERT INTO task_activity(account_id,task_id,actor_id,action,metadata) VALUES($1,$2,$3,'attachment_added',$4::jsonb)`, accountID, snapshot.TaskID, actorID, metadata); err != nil {
		return uuid.Nil, err
	}
	return snapshot.TaskID, nil
}

// Every attachment entry point calls this while holding the attachment row
// where it subsequently mutates child state. A removed reference is hidden.
func requireActiveTaskAttachmentTx(ctx context.Context, tx pgx.Tx, accountID, taskID, attachmentID uuid.UUID) error {
	if err := lockWorkResourceEnvironmentBarrierTx(ctx, tx, accountID, "task", []uuid.UUID{taskID}, false); err != nil {
		return err
	}
	if err := requireActiveWorkTaskTx(ctx, tx, accountID, taskID); err != nil {
		return err
	}
	var id uuid.UUID
	err := tx.QueryRow(ctx, `SELECT id FROM task_attachments WHERE account_id=$1 AND task_id=$2 AND id=$3
		AND storage_removed_at IS NULL AND attachment_scope<>'comment_draft' FOR SHARE`, accountID, taskID, attachmentID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	return err
}

// Final removal keeps historical comment/annotation rows, while derived
// previews are retired through the module's durable, reference-safe collector.
func FinalizeTaskStorageRemovalTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, backup json.RawMessage) error {
	var snapshot taskStorageRemovalSnapshot
	if json.Unmarshal(backup, &snapshot) != nil || snapshot.AttachmentID == uuid.Nil || snapshot.RecoveryID == uuid.Nil {
		return ErrTaskAccessInvalid
	}
	var found bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM task_attachments WHERE account_id=$1 AND id=$2 AND task_id=$3
		AND storage_removed_at IS NOT NULL AND storage_removal_id=$4)`, accountID, snapshot.AttachmentID, snapshot.TaskID, snapshot.RecoveryID).Scan(&found); err != nil {
		return err
	}
	if !found {
		var parentExists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tasks WHERE account_id=$1 AND id=$2)`, accountID, snapshot.TaskID).Scan(&parentExists); err != nil {
			return err
		}
		if !parentExists {
			return nil
		}
		return ErrTaskWorkNotFound
	}
	if _, err := tx.Exec(ctx, `INSERT INTO task_media_gc_jobs(account_id,media_asset_id,object_key,available_at,updated_at)
		SELECT DISTINCT preview.account_id,asset.id,asset.object_key,NOW(),NOW()
		FROM task_attachment_previews preview JOIN media_assets asset ON asset.account_id=preview.account_id AND asset.id=preview.derivative_asset_id
		WHERE preview.account_id=$1 AND preview.task_id=$2 AND preview.attachment_id=$3
		ON CONFLICT(account_id,media_asset_id) DO UPDATE SET status='pending',claim_token=NULL,available_at=NOW(),updated_at=NOW()`, accountID, snapshot.TaskID, snapshot.AttachmentID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM task_attachment_previews WHERE account_id=$1 AND task_id=$2 AND attachment_id=$3`, accountID, snapshot.TaskID, snapshot.AttachmentID)
	return err
}

func privateStorageMissing(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrTaskWorkNotFound
	}
	return err
}
