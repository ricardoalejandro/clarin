package repository

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

func requireWhiteboardAccessTx(ctx context.Context, tx pgx.Tx, accountID, userID, boardID uuid.UUID, required string, manage bool) (*domain.WhiteboardEffectiveAccess, error) {
	access, err := resolveWhiteboardAccessWith(ctx, tx, accountID, userID, boardID)
	if err != nil {
		return nil, err
	}
	if !access.CanView {
		return nil, ErrWhiteboardNotFound
	}
	if !WhiteboardAccessAllows(access, required) || (manage && !access.CanManageAccess) {
		return nil, ErrWhiteboardForbidden
	}
	return access, nil
}

func (r *WhiteboardRepository) UpdateBoard(ctx context.Context, accountID, actorID, boardID uuid.UUID, input WhiteboardUpdateInput) (*domain.Whiteboard, error) {
	if err := requireWhiteboardExpectedVersion(input.ExpectedVersion); err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	workLock, err := lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, true, true)
	if err != nil {
		return nil, err
	}
	var currentVersion int64
	var archivedAt *time.Time
	var currentFolderID *uuid.UUID
	var currentName, currentDescription string
	if err := tx.QueryRow(ctx, `SELECT version,archived_at,folder_id,name,description FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).
		Scan(&currentVersion, &archivedAt, &currentFolderID, &currentName, &currentDescription); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessView, false); err != nil {
		return nil, err
	}
	if err := requireStandaloneWhiteboardMutationLock(workLock); err != nil {
		// Metadata and naming are structural state for a contextual view. Only
		// PATCH /tasks/location-views/:id may change them because it enforces
		// Work Administrar, the location-view version and operation idempotency.
		// Origin is intentionally inspected only after canonical Ver access.
		return nil, err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessEdit, false); err != nil {
		return nil, err
	}
	if archivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, currentVersion); err != nil {
		return nil, err
	}
	if input.FolderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, accountID, *input.FolderID).Scan(&active); err != nil {
			return nil, err
		}
		if !active {
			return nil, ErrWhiteboardInvalid
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET folder_id=$3,name=$4,description=$5,
		updated_by=$6,version=version+1,updated_at=NOW() WHERE account_id=$1 AND id=$2`,
		accountID, boardID, input.FolderID, input.Name, input.Description, actorID); err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	changedFields := make([]string, 0, 3)
	if !reflect.DeepEqual(currentFolderID, input.FolderID) {
		changedFields = append(changedFields, "folder_id")
	}
	if currentName != input.Name {
		changedFields = append(changedFields, "name")
	}
	if currentDescription != input.Description {
		changedFields = append(changedFields, "description")
	}
	details, _ := json.Marshal(map[string]any{"changed_fields": changedFields})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityUpdated, Details: details,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetBoard(ctx, accountID, actorID, boardID)
}

func (r *WhiteboardRepository) ArchiveBoard(ctx context.Context, accountID, actorID, boardID uuid.UUID, expectedVersion int64) error {
	if err := requireWhiteboardExpectedVersion(expectedVersion); err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return err
	}
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return err
	}
	workLock, err := lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, true, true)
	if err != nil {
		return err
	}
	var version int64
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT version,archived_at FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).Scan(&version, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessManage, false); err != nil {
		return err
	}
	contextual := workLock != nil
	if err := checkWhiteboardExpectedVersion(expectedVersion, version); err != nil {
		return err
	}
	if contextual {
		if _, err := tx.Exec(ctx, `UPDATE task_location_views location_view SET
			deleted_at=COALESCE(location_view.deleted_at,NOW()),deleted_by=COALESCE(location_view.deleted_by,$3),
			version=CASE WHEN location_view.deleted_at IS NULL THEN location_view.version+1 ELSE location_view.version END,
			access_revision=CASE WHEN location_view.deleted_at IS NULL THEN location_view.access_revision+1 ELSE location_view.access_revision END,
			updated_at=CASE WHEN location_view.deleted_at IS NULL THEN NOW() ELSE location_view.updated_at END
			FROM task_location_whiteboard_views binding
			WHERE binding.account_id=$1 AND binding.whiteboard_id=$2
			AND location_view.account_id=binding.account_id AND location_view.id=binding.task_view_id`, accountID, boardID, actorID); err != nil {
			return err
		}
	}
	if archivedAt != nil {
		return tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET archived_at=NOW(),updated_by=$3,
		version=version+1,access_revision=access_revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, boardID, actorID); err != nil {
		return err
	}
	details, _ := json.Marshal(map[string]any{"previous_version": version})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityArchived, Details: details,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) RestoreBoard(ctx context.Context, accountID, actorID, boardID uuid.UUID, expectedVersion int64) (*domain.Whiteboard, error) {
	if err := requireWhiteboardExpectedVersion(expectedVersion); err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	workLock, err := lockWorkWhiteboardParentViewTx(ctx, tx, accountID, boardID, true, true)
	if err != nil {
		return nil, err
	}
	var folderID *uuid.UUID
	var archivedAt *time.Time
	var currentVersion int64
	if err := tx.QueryRow(ctx, `SELECT folder_id,archived_at,version FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, boardID).Scan(&folderID, &archivedAt, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	contextual := workLock != nil
	if contextual {
		if _, _, err := requireWorkWhiteboardLifecycleAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessManage); err != nil {
			return nil, err
		}
	} else if _, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessManage, false); err != nil {
		return nil, err
	}
	if err := checkWhiteboardExpectedVersion(expectedVersion, currentVersion); err != nil {
		return nil, err
	}
	if contextual {
		if _, err := tx.Exec(ctx, `UPDATE task_location_views location_view SET
			deleted_at=NULL,deleted_by=NULL,version=location_view.version+1,
			access_revision=location_view.access_revision+1,updated_at=NOW()
			FROM task_location_whiteboard_views binding
			WHERE binding.account_id=$1 AND binding.whiteboard_id=$2
			AND location_view.account_id=binding.account_id AND location_view.id=binding.task_view_id
			AND location_view.deleted_at IS NOT NULL`, accountID, boardID); err != nil {
			return nil, err
		}
	}
	if archivedAt == nil {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.GetBoard(ctx, accountID, actorID, boardID)
	}
	if folderID != nil {
		var active bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, accountID, *folderID).Scan(&active); err != nil {
			return nil, err
		}
		if !active {
			return nil, ErrWhiteboardConflict
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboards SET archived_at=NULL,updated_by=$3,
		version=version+1,access_revision=access_revision+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, boardID, actorID); err != nil {
		return nil, err
	}
	details, _ := json.Marshal(map[string]any{"previous_version": currentVersion})
	if err := insertWhiteboardActivityTx(ctx, tx, WhiteboardActivityInput{
		AccountID: accountID, BoardID: boardID, ActorID: &actorID,
		Action: WhiteboardActivityRestored, Details: details,
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetBoard(ctx, accountID, actorID, boardID)
}
