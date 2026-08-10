package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const maxWhiteboardFolderDepth = 20

type WhiteboardFolderInput struct {
	ParentID        *uuid.UUID
	Name            string
	Description     string
	SortOrder       *int64
	ExpectedVersion int64
}

func scanWhiteboardFolder(scanner whiteboardRowScanner) (*domain.WhiteboardFolder, error) {
	item := &domain.WhiteboardFolder{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.ParentID, &item.Name, &item.Description,
		&item.SortOrder, &item.Version, &item.CreatedBy, &item.ArchivedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

const whiteboardFolderColumns = `id,account_id,parent_id,name,description,sort_order,version,
	created_by,archived_at,created_at,updated_at`

func (r *WhiteboardRepository) CreateFolder(ctx context.Context, accountID, actorID uuid.UUID, input WhiteboardFolderInput) (*domain.WhiteboardFolder, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if input.ParentID != nil {
		var parentDepth int
		if err := tx.QueryRow(ctx, `WITH RECURSIVE ancestors AS (
			SELECT id,parent_id,1 AS depth FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
			UNION ALL
			SELECT parent.id,parent.parent_id,child.depth+1 FROM whiteboard_folders parent
			JOIN ancestors child ON child.parent_id=parent.id
			WHERE parent.account_id=$1 AND parent.archived_at IS NULL AND child.depth<$3
		) SELECT COALESCE(MAX(depth),0) FROM ancestors`, accountID, *input.ParentID, maxWhiteboardFolderDepth).Scan(&parentDepth); err != nil {
			return nil, err
		}
		if parentDepth == 0 || parentDepth+1 > maxWhiteboardFolderDepth {
			return nil, ErrWhiteboardInvalid
		}
	}
	sortOrder := int64(0)
	if input.SortOrder != nil {
		sortOrder = *input.SortOrder
	} else if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sort_order),0)+1024 FROM whiteboard_folders
		WHERE account_id=$1 AND parent_id IS NOT DISTINCT FROM $2::uuid AND archived_at IS NULL`, accountID, input.ParentID).Scan(&sortOrder); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardFolder(tx.QueryRow(ctx, `INSERT INTO whiteboard_folders(
		account_id,parent_id,name,description,sort_order,created_by
	) VALUES($1,$2,$3,$4,$5,$6) RETURNING `+whiteboardFolderColumns,
		accountID, input.ParentID, input.Name, input.Description, sortOrder, actorID))
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) GetFolder(ctx context.Context, accountID, folderID uuid.UUID) (*domain.WhiteboardFolder, error) {
	item, err := scanWhiteboardFolder(r.db.QueryRow(ctx, `SELECT `+whiteboardFolderColumns+`
		FROM whiteboard_folders WHERE account_id=$1 AND id=$2`, accountID, folderID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) ListFolders(ctx context.Context, accountID uuid.UUID, options WhiteboardFolderListOptions) ([]*domain.WhiteboardFolder, bool, error) {
	limit := options.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardFolderColumns+` FROM whiteboard_folders
		WHERE account_id=$1
		  AND ($2::boolean OR archived_at IS NULL)
		  AND (NOT $3::boolean OR parent_id IS NOT DISTINCT FROM $4::uuid)
		  AND ($5::bigint IS NULL OR (sort_order,id)>($5::bigint,$6::uuid))
		ORDER BY sort_order,id LIMIT $7`, accountID, options.IncludeArchived, options.FilterByParent,
		options.ParentID, options.AfterSortOrder, options.AfterID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardFolder, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardFolder(rows)
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

func (r *WhiteboardRepository) UpdateFolder(ctx context.Context, accountID, actorID, folderID uuid.UUID, input WhiteboardFolderInput) (*domain.WhiteboardFolder, error) {
	if err := requireWhiteboardExpectedVersion(input.ExpectedVersion); err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	var currentVersion int64
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT version,archived_at FROM whiteboard_folders
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, folderID).Scan(&currentVersion, &archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if archivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, currentVersion); err != nil {
		return nil, err
	}
	if input.ParentID != nil {
		if *input.ParentID == folderID {
			return nil, ErrWhiteboardInvalid
		}
		var invalidParent bool
		if err := tx.QueryRow(ctx, `WITH RECURSIVE descendants AS (
			SELECT id FROM whiteboard_folders WHERE account_id=$1 AND parent_id=$2 AND archived_at IS NULL
			UNION ALL
			SELECT child.id FROM whiteboard_folders child JOIN descendants parent ON child.parent_id=parent.id
			WHERE child.account_id=$1 AND child.archived_at IS NULL
		) SELECT NOT EXISTS(SELECT 1 FROM whiteboard_folders WHERE account_id=$1 AND id=$3 AND archived_at IS NULL)
			OR EXISTS(SELECT 1 FROM descendants WHERE id=$3)`, accountID, folderID, *input.ParentID).Scan(&invalidParent); err != nil {
			return nil, err
		}
		if invalidParent {
			return nil, ErrWhiteboardInvalid
		}
	}
	var resultingDepth int
	if err := tx.QueryRow(ctx, `WITH RECURSIVE
		ancestors AS (
			SELECT id,parent_id,1 AS depth FROM whiteboard_folders
			WHERE account_id=$1 AND id=$3::uuid AND archived_at IS NULL
			UNION ALL
			SELECT parent.id,parent.parent_id,child.depth+1 FROM whiteboard_folders parent
			JOIN ancestors child ON child.parent_id=parent.id
			WHERE parent.account_id=$1 AND parent.archived_at IS NULL AND child.depth<$4
		), subtree AS (
			SELECT id,1 AS depth FROM whiteboard_folders WHERE account_id=$1 AND id=$2
			UNION ALL
			SELECT child.id,parent.depth+1 FROM whiteboard_folders child
			JOIN subtree parent ON child.parent_id=parent.id
			WHERE child.account_id=$1 AND child.archived_at IS NULL AND parent.depth<$4
		)
		SELECT COALESCE((SELECT MAX(depth) FROM ancestors),0)+COALESCE((SELECT MAX(depth) FROM subtree),1)`,
		accountID, folderID, input.ParentID, maxWhiteboardFolderDepth+1).Scan(&resultingDepth); err != nil {
		return nil, err
	}
	if resultingDepth > maxWhiteboardFolderDepth {
		return nil, ErrWhiteboardInvalid
	}
	var sortOrder any
	if input.SortOrder != nil {
		sortOrder = *input.SortOrder
	}
	item, err := scanWhiteboardFolder(tx.QueryRow(ctx, `UPDATE whiteboard_folders SET
		parent_id=$3,name=$4,description=$5,sort_order=COALESCE($6::bigint,sort_order),
		version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 RETURNING `+whiteboardFolderColumns,
		accountID, folderID, input.ParentID, input.Name, input.Description, sortOrder))
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) ArchiveFolder(ctx context.Context, accountID, folderID uuid.UUID, expectedVersion int64) error {
	if err := requireWhiteboardExpectedVersion(expectedVersion); err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return err
	}
	var version int64
	if err := tx.QueryRow(ctx, `SELECT version FROM whiteboard_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NULL FOR UPDATE`, accountID, folderID).Scan(&version); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWhiteboardNotFound
		}
		return err
	}
	if err := checkWhiteboardExpectedVersion(expectedVersion, version); err != nil {
		return err
	}
	var occupied bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM whiteboard_folders WHERE account_id=$1 AND parent_id=$2 AND archived_at IS NULL
		UNION ALL
		SELECT 1 FROM whiteboards WHERE account_id=$1 AND folder_id=$2 AND archived_at IS NULL
	)`, accountID, folderID).Scan(&occupied); err != nil {
		return err
	}
	if occupied {
		return ErrWhiteboardFolderNotEmpty
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_folders SET archived_at=NOW(),version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2`, accountID, folderID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) RestoreFolder(ctx context.Context, accountID, folderID uuid.UUID, expectedVersion int64) (*domain.WhiteboardFolder, error) {
	if err := requireWhiteboardExpectedVersion(expectedVersion); err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockWhiteboardHierarchyTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	var parentID *uuid.UUID
	var currentVersion int64
	if err := tx.QueryRow(ctx, `SELECT parent_id,version FROM whiteboard_folders
		WHERE account_id=$1 AND id=$2 AND archived_at IS NOT NULL FOR UPDATE`, accountID, folderID).Scan(&parentID, &currentVersion); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if err := checkWhiteboardExpectedVersion(expectedVersion, currentVersion); err != nil {
		return nil, err
	}
	if parentID != nil {
		var parentActive bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_folders
			WHERE account_id=$1 AND id=$2 AND archived_at IS NULL)`, accountID, *parentID).Scan(&parentActive); err != nil {
			return nil, err
		}
		if !parentActive {
			return nil, ErrWhiteboardConflict
		}
	}
	item, err := scanWhiteboardFolder(tx.QueryRow(ctx, `UPDATE whiteboard_folders
		SET archived_at=NULL,version=version+1,updated_at=NOW()
		WHERE account_id=$1 AND id=$2 RETURNING `+whiteboardFolderColumns, accountID, folderID))
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}
