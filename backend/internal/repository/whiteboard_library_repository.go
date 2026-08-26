package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

type WhiteboardLibraryInput struct {
	Name            string
	Description     string
	LibraryJSON     json.RawMessage
	Visibility      string
	ExpectedVersion int64
}

type WhiteboardLibraryListOptions struct {
	Query           string
	IncludeArchived bool
	BeforeUpdatedAt *time.Time
	BeforeID        *uuid.UUID
	Limit           int
}

func scanWhiteboardLibrary(scanner whiteboardRowScanner) (*domain.WhiteboardLibrary, error) {
	item := &domain.WhiteboardLibrary{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.Name, &item.Description, &item.LibraryJSON,
		&item.Visibility, &item.Version, &item.CreatedBy, &item.UpdatedBy, &item.ArchivedAt,
		&item.CreatedAt, &item.UpdatedAt)
	if err == nil {
		item.ContentSizeBytes = int64(len(item.LibraryJSON))
		var envelope struct {
			LibraryItems []json.RawMessage `json:"libraryItems"`
		}
		if json.Unmarshal(item.LibraryJSON, &envelope) == nil {
			item.ItemCount = len(envelope.LibraryItems)
		}
	}
	return item, err
}

func scanWhiteboardLibrarySummary(scanner whiteboardRowScanner) (*domain.WhiteboardLibrary, error) {
	item := &domain.WhiteboardLibrary{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.Name, &item.Description,
		&item.Visibility, &item.Version, &item.CreatedBy, &item.UpdatedBy, &item.ArchivedAt,
		&item.CreatedAt, &item.UpdatedAt, &item.ItemCount, &item.ContentSizeBytes)
	return item, err
}

const whiteboardLibraryColumns = `library.id,library.account_id,library.name,library.description,library.library_json,
	library.visibility,library.version,library.created_by,library.updated_by,library.archived_at,
	library.created_at,library.updated_at`

const whiteboardLibrarySummaryColumns = `library.id,library.account_id,library.name,LEFT(library.description,1000),
	library.visibility,library.version,library.created_by,library.updated_by,library.archived_at,
	library.created_at,library.updated_at,
	CASE WHEN jsonb_typeof(library.library_json->'libraryItems')='array'
		THEN jsonb_array_length(library.library_json->'libraryItems') ELSE 0 END,
	octet_length(library.library_json::text)::bigint`

func validWhiteboardLibraryDescription(description string) bool {
	return utf8.ValidString(description) && utf8.RuneCountInString(description) <= whiteboardcore.MaxLibraryDescriptionRunes
}

func validWhiteboardLibraryQuery(query string) bool {
	return utf8.ValidString(query) && utf8.RuneCountInString(query) <= 200
}

func (r *WhiteboardRepository) resolveLibraryAccess(ctx context.Context, accountID, actorID, libraryID uuid.UUID) (string, error) {
	var level string
	err := r.db.QueryRow(ctx, `SELECT CASE
		WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
		WHEN library.created_by=$2 THEN 'manage'
		-- Account libraries are shared catalogs, not collaboratively mutable
		-- documents. Members may consume them; only the creator or an account
		-- administrator may change their contents or metadata.
		WHEN library.visibility='account' THEN 'view'
		ELSE 'none' END
		FROM whiteboard_libraries library
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=library.account_id AND membership.user_id=$2
		WHERE library.account_id=$1 AND library.id=$3
		AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)`, accountID, actorID, libraryID).Scan(&level)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrWhiteboardNotFound
	}
	if err != nil {
		return "", err
	}
	if whiteboardAccessRank(level) < whiteboardAccessRank(domain.WhiteboardAccessView) {
		return "", ErrWhiteboardNotFound
	}
	return level, nil
}

func (r *WhiteboardRepository) requireLibraryAccess(ctx context.Context, accountID, actorID, libraryID uuid.UUID, required string) error {
	level, err := r.resolveLibraryAccess(ctx, accountID, actorID, libraryID)
	if err != nil {
		return err
	}
	if whiteboardAccessRank(level) < whiteboardAccessRank(required) {
		return ErrWhiteboardForbidden
	}
	return nil
}

func (r *WhiteboardRepository) RequireLibraryAccess(ctx context.Context, accountID, actorID, libraryID uuid.UUID, required string) error {
	return r.requireLibraryAccess(ctx, accountID, actorID, libraryID, required)
}

type whiteboardLibraryMutationState struct {
	Version     int64
	Visibility  string
	ArchivedAt  *time.Time
	AccessLevel string
	LibraryJSON json.RawMessage
}

func canChangeWhiteboardLibraryVisibility(accessLevel, currentVisibility, nextVisibility string) bool {
	return currentVisibility == nextVisibility ||
		whiteboardAccessRank(accessLevel) >= whiteboardAccessRank(domain.WhiteboardAccessManage)
}

func requireWhiteboardLibraryMutationAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, libraryID uuid.UUID, required string) (*whiteboardLibraryMutationState, error) {
	state := &whiteboardLibraryMutationState{}
	err := tx.QueryRow(ctx, `SELECT library.version,library.visibility,library.archived_at,CASE
		WHEN COALESCE(account_user.is_super_admin,FALSE) OR COALESCE(membership.role,'') IN ('admin','super_admin') THEN 'manage'
		WHEN library.created_by=$2 THEN 'manage'
		WHEN library.visibility='account' THEN 'view'
		ELSE 'none' END,library.library_json
		FROM whiteboard_libraries library
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=library.account_id AND membership.user_id=$2
		WHERE library.account_id=$1 AND library.id=$3
		AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
		FOR UPDATE OF library`, accountID, actorID, libraryID).Scan(
		&state.Version, &state.Visibility, &state.ArchivedAt, &state.AccessLevel, &state.LibraryJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	if whiteboardAccessRank(state.AccessLevel) < whiteboardAccessRank(domain.WhiteboardAccessView) {
		return nil, ErrWhiteboardNotFound
	}
	if whiteboardAccessRank(state.AccessLevel) < whiteboardAccessRank(required) {
		return nil, ErrWhiteboardForbidden
	}
	return state, nil
}

func (r *WhiteboardRepository) CreateLibrary(ctx context.Context, accountID, actorID uuid.UUID, input WhiteboardLibraryInput) (*domain.WhiteboardLibrary, error) {
	if !validWhiteboardLibraryDescription(input.Description) {
		return nil, ErrWhiteboardInvalid
	}
	referencedFileIDs, err := whiteboardcore.ReferencedLibraryFileIDs(input.LibraryJSON)
	if err != nil || len(referencedFileIDs) != 0 {
		// Library creation has no stable library ID before the row exists, so its
		// private files are uploaded as drafts after creating an empty library and
		// are promoted by UpdateLibrary in one transaction.
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockActiveWhiteboardTenantTx(ctx, tx, accountID); err != nil {
		return nil, err
	}
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardLibrary(tx.QueryRow(ctx, `INSERT INTO whiteboard_libraries AS library(
		account_id,name,description,library_json,visibility,created_by,updated_by
	) VALUES($1,$2,$3,$4::jsonb,$5,$6,$6) RETURNING `+whiteboardLibraryColumns,
		accountID, input.Name, input.Description, input.LibraryJSON, input.Visibility, actorID))
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) GetLibrary(ctx context.Context, accountID, actorID, libraryID uuid.UUID) (*domain.WhiteboardLibrary, error) {
	if err := r.requireLibraryAccess(ctx, accountID, actorID, libraryID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardLibrary(r.db.QueryRow(ctx, `SELECT `+whiteboardLibraryColumns+`
		FROM whiteboard_libraries library WHERE library.account_id=$1 AND library.id=$2`, accountID, libraryID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	return item, err
}

func (r *WhiteboardRepository) ListLibraries(ctx context.Context, accountID, actorID uuid.UUID, options WhiteboardLibraryListOptions) ([]*domain.WhiteboardLibrary, bool, error) {
	limit := options.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	query := strings.TrimSpace(options.Query)
	if !validWhiteboardLibraryQuery(query) {
		return nil, false, ErrWhiteboardInvalid
	}
	rows, err := r.db.Query(ctx, `SELECT `+whiteboardLibrarySummaryColumns+`
		FROM whiteboard_libraries library
		JOIN users account_user ON account_user.id=$2 AND account_user.is_active
		LEFT JOIN user_accounts membership ON membership.account_id=library.account_id AND membership.user_id=$2
		WHERE library.account_id=$1 AND (membership.user_id IS NOT NULL OR account_user.account_id=$1)
		AND ($3::boolean OR library.archived_at IS NULL)
		AND ($4::text='' OR library.name ILIKE '%'||$4::text||'%' OR library.description ILIKE '%'||$4::text||'%')
		AND ($5::timestamptz IS NULL OR (library.updated_at,library.id)<($5::timestamptz,$6::uuid))
		AND (library.visibility='account' OR library.created_by=$2 OR COALESCE(account_user.is_super_admin,FALSE)
			OR COALESCE(membership.role,'') IN ('admin','super_admin'))
		ORDER BY library.updated_at DESC,library.id DESC LIMIT $7`, accountID, actorID,
		options.IncludeArchived, query, options.BeforeUpdatedAt, options.BeforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]*domain.WhiteboardLibrary, 0, limit)
	for rows.Next() {
		item, scanErr := scanWhiteboardLibrarySummary(rows)
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

func (r *WhiteboardRepository) UpdateLibrary(ctx context.Context, accountID, actorID, libraryID uuid.UUID, input WhiteboardLibraryInput) (*domain.WhiteboardLibrary, error) {
	if !validWhiteboardLibraryDescription(input.Description) {
		return nil, ErrWhiteboardInvalid
	}
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
	state, err := requireWhiteboardLibraryMutationAccessTx(ctx, tx, accountID, actorID, libraryID, domain.WhiteboardAccessEdit)
	if err != nil {
		return nil, err
	}
	if state.ArchivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	if err := checkWhiteboardExpectedVersion(input.ExpectedVersion, state.Version); err != nil {
		return nil, err
	}
	if !canChangeWhiteboardLibraryVisibility(state.AccessLevel, state.Visibility, input.Visibility) {
		return nil, ErrWhiteboardForbidden
	}
	if err := reconcileWhiteboardLibraryAssetsTx(ctx, tx, accountID, libraryID, input.LibraryJSON); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardLibrary(tx.QueryRow(ctx, `UPDATE whiteboard_libraries library SET
		name=$4,description=$5,library_json=$6::jsonb,visibility=$7,version=version+1,
		updated_by=$3,updated_at=NOW()
		WHERE library.account_id=$1 AND library.id=$2 AND library.archived_at IS NULL
		AND library.version=$8::bigint RETURNING `+whiteboardLibraryColumns,
		accountID, libraryID, actorID, input.Name, input.Description, input.LibraryJSON,
		input.Visibility, input.ExpectedVersion))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, &WhiteboardConflictError{CurrentVersion: state.Version}
	}
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) ArchiveLibrary(ctx context.Context, accountID, actorID, libraryID uuid.UUID, expectedVersion int64) error {
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
	state, err := requireWhiteboardLibraryMutationAccessTx(ctx, tx, accountID, actorID, libraryID, domain.WhiteboardAccessManage)
	if err != nil {
		return err
	}
	if state.ArchivedAt != nil {
		return ErrWhiteboardConflict
	}
	if err := checkWhiteboardExpectedVersion(expectedVersion, state.Version); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE whiteboard_libraries SET archived_at=NOW(),version=version+1,
		updated_by=$3,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND archived_at IS NULL
		AND version=$4::bigint`, accountID, libraryID, actorID, expectedVersion)
	if err != nil {
		return err
	}
	if command.RowsAffected() == 0 {
		return &WhiteboardConflictError{CurrentVersion: state.Version}
	}
	return tx.Commit(ctx)
}
