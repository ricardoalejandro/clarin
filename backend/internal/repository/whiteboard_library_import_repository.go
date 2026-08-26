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

var (
	ErrWhiteboardLibraryImportExpired      = errors.New("whiteboard library import expired")
	ErrWhiteboardLibraryImportUnavailable  = errors.New("whiteboard library import unavailable")
	ErrWhiteboardLibraryImportNotPersisted = errors.New("whiteboard library import content was not persisted")
)

type WhiteboardLibraryImportStartInput struct {
	TokenHash string
	ExpiresAt time.Time
}

func whiteboardLibraryImportExpiryLimit(limit int) int {
	if limit <= 0 {
		return 100
	}
	if limit > 500 {
		return 500
	}
	return limit
}

func scanWhiteboardLibraryImport(scanner whiteboardRowScanner) (*domain.WhiteboardLibraryImport, error) {
	item := &domain.WhiteboardLibraryImport{}
	err := scanner.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.LibraryID, &item.ActorID,
		&item.Status, &item.SourceURL, &item.LibraryJSON, &item.CompletedLibraryVersion,
		&item.ExpiresAt, &item.ConsumedAt, &item.CompletedAt, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

const whiteboardLibraryImportColumns = `import_item.id,import_item.account_id,import_item.board_id,
	import_item.library_id,import_item.actor_id,import_item.status,COALESCE(import_item.source_url,''),
	import_item.library_json,import_item.completed_library_version,import_item.expires_at,
	import_item.consumed_at,import_item.completed_at,import_item.created_at,import_item.updated_at`

func scanWhiteboardLibraryImportWithCompletion(scanner whiteboardRowScanner) (*domain.WhiteboardLibraryImport, *uuid.UUID, error) {
	item := &domain.WhiteboardLibraryImport{}
	var completionOperationID *uuid.UUID
	err := scanner.Scan(&item.ID, &item.AccountID, &item.BoardID, &item.LibraryID, &item.ActorID,
		&item.Status, &item.SourceURL, &item.LibraryJSON, &item.CompletedLibraryVersion,
		&item.ExpiresAt, &item.ConsumedAt, &item.CompletedAt, &item.CreatedAt, &item.UpdatedAt,
		&completionOperationID)
	return item, completionOperationID, err
}

// whiteboardLibraryItemIDs extracts the stable item IDs used to prove that a
// browser merged the one-time import into the canonical personal library. The
// imported payload is strict because Clarin namespaced every item before it was
// stored. Existing personal libraries may still contain legacy array entries,
// which do not participate in this proof and are therefore ignored.
func whiteboardLibraryItemIDs(libraryJSON json.RawMessage, requireEveryID bool) (map[string]struct{}, error) {
	var envelope struct {
		LibraryItems []json.RawMessage `json:"libraryItems"`
	}
	if len(libraryJSON) == 0 || json.Unmarshal(libraryJSON, &envelope) != nil || envelope.LibraryItems == nil {
		return nil, ErrWhiteboardLibraryImportNotPersisted
	}
	ids := make(map[string]struct{}, len(envelope.LibraryItems))
	for _, rawItem := range envelope.LibraryItems {
		trimmed := strings.TrimSpace(string(rawItem))
		if strings.HasPrefix(trimmed, "[") && !requireEveryID {
			continue
		}
		var item struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(rawItem, &item) != nil || strings.TrimSpace(item.ID) == "" {
			if requireEveryID {
				return nil, ErrWhiteboardLibraryImportNotPersisted
			}
			continue
		}
		if _, duplicate := ids[item.ID]; duplicate && requireEveryID {
			return nil, ErrWhiteboardLibraryImportNotPersisted
		}
		ids[item.ID] = struct{}{}
	}
	return ids, nil
}

func whiteboardLibraryContainsImportedItems(importJSON, persistedJSON json.RawMessage) error {
	importedIDs, err := whiteboardLibraryItemIDs(importJSON, true)
	if err != nil {
		return err
	}
	persistedIDs, err := whiteboardLibraryItemIDs(persistedJSON, false)
	if err != nil {
		return err
	}
	for itemID := range importedIDs {
		if _, persisted := persistedIDs[itemID]; !persisted {
			return ErrWhiteboardLibraryImportNotPersisted
		}
	}
	return nil
}

const whiteboardLibraryImportClaimBoardSQL = `SELECT import_item.board_id
	FROM whiteboard_library_import_sessions import_item
	WHERE import_item.token_hash=$1 AND import_item.account_id=$2 AND import_item.actor_id=$3`

func (r *WhiteboardRepository) WhiteboardLibraryImportCallbackBoard(ctx context.Context, accountID, actorID uuid.UUID, tokenHash string) (uuid.UUID, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || len(tokenHash) != 64 {
		return uuid.Nil, ErrWhiteboardInvalid
	}
	var boardID uuid.UUID
	if err := r.db.QueryRow(ctx, whiteboardLibraryImportClaimBoardSQL, tokenHash, accountID, actorID).Scan(&boardID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return uuid.Nil, ErrWhiteboardNotFound
		}
		return uuid.Nil, err
	}
	return boardID, nil
}

const whiteboardLibraryImportClaimSelectSQL = `SELECT ` + whiteboardLibraryImportColumns + `
	FROM whiteboard_library_import_sessions import_item
	WHERE import_item.token_hash=$1 AND import_item.account_id=$2 AND import_item.actor_id=$3
	FOR UPDATE`

const whiteboardLibraryImportClaimUpdateSQL = `UPDATE whiteboard_library_import_sessions AS import_item
	SET status='fetching',consumed_at=NOW(),updated_at=NOW()
	WHERE token_hash=$1 AND account_id=$2 AND actor_id=$3 AND id=$4
	AND status='pending' AND expires_at>$5
	RETURNING ` + whiteboardLibraryImportColumns

const whiteboardLibraryImportNavigationSQL = `SELECT TRUE
	FROM whiteboard_library_import_sessions import_item
	JOIN whiteboard_libraries library
		ON library.account_id=import_item.account_id AND library.id=import_item.library_id
	WHERE import_item.account_id=$1 AND import_item.actor_id=$2 AND import_item.board_id=$3
	AND import_item.id=$4 AND import_item.token_hash=$5
	AND import_item.status='pending' AND import_item.expires_at>$6
	AND library.account_id=$1 AND library.created_by=$2
	AND library.visibility='private' AND library.archived_at IS NULL
	FOR UPDATE OF import_item FOR SHARE OF library`

const whiteboardLibraryImportNavigationRotateSQL = `UPDATE whiteboard_library_import_sessions AS import_item
	SET token_hash=$7,updated_at=NOW()
	WHERE import_item.account_id=$1 AND import_item.actor_id=$2 AND import_item.board_id=$3
	AND import_item.id=$4 AND import_item.token_hash=$5
	AND import_item.status='pending' AND import_item.expires_at>$6
	RETURNING import_item.token_hash`

// lockWhiteboardLibraryImportViewAccessTx locks every persisted input used by
// the cumulative board ACL before evaluating it. This serializes the callback
// with board ACL replacement, membership removal/role changes, direct-grant
// removal and actor deactivation, so a validated catalog payload cannot become
// ready after the originating actor has lost access.
func lockWhiteboardLibraryImportViewAccessTx(ctx context.Context, tx pgx.Tx, accountID, actorID, boardID uuid.UUID) error {
	if err := lockWhiteboardActorMembershipsTx(ctx, tx, accountID, actorID); err != nil {
		return err
	}

	var boardExists bool
	if err := tx.QueryRow(ctx, `SELECT TRUE FROM whiteboards
		WHERE account_id=$1 AND id=$2 FOR SHARE`, accountID, boardID).Scan(&boardExists); errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	} else if err != nil {
		return err
	}

	var grantID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT id FROM whiteboard_grants
		WHERE account_id=$1 AND board_id=$2 AND user_id=$3 FOR SHARE`, accountID, boardID, actorID).Scan(&grantID); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	_, err := requireWhiteboardAccessTx(ctx, tx, accountID, actorID, boardID, domain.WhiteboardAccessView, false)
	return err
}

func (r *WhiteboardRepository) StartWhiteboardLibraryImport(ctx context.Context, accountID, actorID, boardID, libraryID uuid.UUID, input WhiteboardLibraryImportStartInput) (*domain.WhiteboardLibraryImport, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || boardID == uuid.Nil || libraryID == uuid.Nil || len(input.TokenHash) != 64 || !input.ExpiresAt.After(time.Now().UTC()) || input.ExpiresAt.After(time.Now().UTC().Add(time.Hour)) {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	if err := lockWhiteboardLibraryImportViewAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	var archivedAt *time.Time
	if err := tx.QueryRow(ctx, `SELECT archived_at FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID).Scan(&archivedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if archivedAt != nil {
		return nil, ErrWhiteboardConflict
	}
	var libraryExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_libraries
		WHERE account_id=$1 AND id=$2 AND created_by=$3 AND visibility='private' AND archived_at IS NULL)`,
		accountID, libraryID, actorID).Scan(&libraryExists); err != nil {
		return nil, err
	}
	if !libraryExists {
		return nil, ErrWhiteboardNotFound
	}
	item, err := scanWhiteboardLibraryImport(tx.QueryRow(ctx, `INSERT INTO whiteboard_library_import_sessions AS import_item(
		account_id,board_id,library_id,actor_id,token_hash,expires_at
	) VALUES($1,$2,$3,$4,$5,$6) RETURNING `+whiteboardLibraryImportColumns,
		accountID, boardID, libraryID, actorID, input.TokenHash, input.ExpiresAt))
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

// RotateWhiteboardLibraryImportNavigation validates the HttpOnly navigation
// handoff and atomically replaces its hash with a fresh callback-only secret.
// Replaying the cookie hash cannot pass the same locked selection again.
func (r *WhiteboardRepository) RotateWhiteboardLibraryImportNavigation(ctx context.Context, accountID, actorID, boardID, importID uuid.UUID, navigationTokenHash, callbackTokenHash string, now time.Time) error {
	if accountID == uuid.Nil || actorID == uuid.Nil || boardID == uuid.Nil || importID == uuid.Nil ||
		len(navigationTokenHash) != 64 || len(callbackTokenHash) != 64 || navigationTokenHash == callbackTokenHash || now.IsZero() {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()

	if err := lockWhiteboardLibraryImportViewAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return err
	}
	var authorized bool
	if err := tx.QueryRow(ctx, whiteboardLibraryImportNavigationSQL,
		accountID, actorID, boardID, importID, navigationTokenHash, now).Scan(&authorized); errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	} else if err != nil {
		return err
	}
	if !authorized {
		return ErrWhiteboardNotFound
	}
	var rotatedTokenHash string
	if err := tx.QueryRow(ctx, whiteboardLibraryImportNavigationRotateSQL,
		accountID, actorID, boardID, importID, navigationTokenHash, now, callbackTokenHash).Scan(&rotatedTokenHash); errors.Is(err, pgx.ErrNoRows) {
		return ErrWhiteboardNotFound
	} else if err != nil {
		return normalizeWhiteboardConstraintError(err)
	}
	if rotatedTokenHash != callbackTokenHash {
		return ErrWhiteboardConflict
	}
	return tx.Commit(ctx)
}

// ClaimWhiteboardLibraryImport consumes the callback-purpose hash produced by
// a successful navigation rotation before any outbound request. A retry after
// the validated payload was stored is idempotent and returns that same import
// without fetching it again.
func (r *WhiteboardRepository) ClaimWhiteboardLibraryImport(ctx context.Context, accountID, actorID uuid.UUID, tokenHash string, now time.Time) (*domain.WhiteboardLibraryImport, bool, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || len(tokenHash) != 64 {
		return nil, false, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()

	var boardID uuid.UUID
	if err := tx.QueryRow(ctx, whiteboardLibraryImportClaimBoardSQL, tokenHash, accountID, actorID).Scan(&boardID); errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrWhiteboardNotFound
	} else if err != nil {
		return nil, false, err
	}
	if err := lockWhiteboardLibraryImportViewAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, false, err
	}

	item, err := scanWhiteboardLibraryImport(tx.QueryRow(ctx, whiteboardLibraryImportClaimSelectSQL,
		tokenHash, accountID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, false, err
	}
	if !item.ExpiresAt.After(now) {
		return nil, false, ErrWhiteboardLibraryImportExpired
	}
	if item.Status == domain.WhiteboardLibraryImportPending {
		item, err = scanWhiteboardLibraryImport(tx.QueryRow(ctx, whiteboardLibraryImportClaimUpdateSQL,
			tokenHash, accountID, actorID, item.ID, now))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, ErrWhiteboardLibraryImportUnavailable
		}
		if err != nil {
			return nil, false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return item, false, nil
	}
	if item.Status == domain.WhiteboardLibraryImportReady || item.Status == domain.WhiteboardLibraryImportCompleted {
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return item, true, nil
	}
	return nil, false, ErrWhiteboardLibraryImportUnavailable
}

func (r *WhiteboardRepository) MarkWhiteboardLibraryImportReady(ctx context.Context, accountID, actorID, importID uuid.UUID, sourceURL string, libraryJSON json.RawMessage) (*domain.WhiteboardLibraryImport, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || importID == uuid.Nil || sourceURL == "" || len(libraryJSON) == 0 {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()

	var boardID uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT board_id FROM whiteboard_library_import_sessions
		WHERE account_id=$1 AND actor_id=$2 AND id=$3`, accountID, actorID, importID).Scan(&boardID); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	} else if err != nil {
		return nil, err
	}
	if err := lockWhiteboardLibraryImportViewAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}

	item, err := scanWhiteboardLibraryImport(tx.QueryRow(ctx, `UPDATE whiteboard_library_import_sessions AS import_item
		SET status='ready',source_url=$4,library_json=$5::jsonb,failure_code=NULL,updated_at=NOW()
		WHERE account_id=$1 AND actor_id=$2 AND id=$3 AND status='fetching' AND expires_at>NOW()
		RETURNING `+whiteboardLibraryImportColumns, accountID, actorID, importID, sourceURL, libraryJSON))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardLibraryImportUnavailable
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return item, nil
}

func (r *WhiteboardRepository) MarkWhiteboardLibraryImportFailed(ctx context.Context, accountID, actorID, importID uuid.UUID, failureCode string) error {
	if len(failureCode) > 80 {
		failureCode = failureCode[:80]
	}
	_, err := r.db.Exec(ctx, `UPDATE whiteboard_library_import_sessions SET status='failed',failure_code=$4,
		library_json=NULL,source_url=NULL,updated_at=NOW() WHERE account_id=$1 AND actor_id=$2 AND id=$3
		AND status='fetching'`, accountID, actorID, importID, failureCode)
	return err
}

// ExpireWhiteboardLibraryImports removes untrusted catalog payloads from
// abandoned handoffs in bounded, lock-safe batches. The metadata row remains
// as a consumed-token tombstone, so an expired token can never be reused.
func (r *WhiteboardRepository) ExpireWhiteboardLibraryImports(ctx context.Context, now time.Time, limit int) (int64, error) {
	command, err := r.db.Exec(ctx, `WITH expired AS (
		SELECT id FROM whiteboard_library_import_sessions
		WHERE expires_at<=$1 AND status IN ('pending','fetching','ready')
		ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED
	)
	UPDATE whiteboard_library_import_sessions import_item
	SET status='failed',source_url=NULL,library_json=NULL,failure_code='expired',updated_at=NOW()
	FROM expired WHERE import_item.id=expired.id`, now, whiteboardLibraryImportExpiryLimit(limit))
	if err != nil {
		return 0, err
	}
	return command.RowsAffected(), nil
}

func (r *WhiteboardRepository) GetWhiteboardLibraryImport(ctx context.Context, accountID, actorID, boardID, importID uuid.UUID, now time.Time) (*domain.WhiteboardLibraryImport, error) {
	if _, err := r.RequireAccess(ctx, accountID, actorID, boardID, domain.WhiteboardAccessView); err != nil {
		return nil, err
	}
	item, err := scanWhiteboardLibraryImport(r.db.QueryRow(ctx, `SELECT `+whiteboardLibraryImportColumns+`
		FROM whiteboard_library_import_sessions import_item
		JOIN whiteboard_libraries library ON library.account_id=import_item.account_id AND library.id=import_item.library_id
		WHERE import_item.account_id=$1 AND import_item.actor_id=$2 AND import_item.board_id=$3 AND import_item.id=$4
		AND library.created_by=$2 AND library.visibility='private' AND library.archived_at IS NULL`,
		accountID, actorID, boardID, importID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	if !item.ExpiresAt.After(now) && item.Status != domain.WhiteboardLibraryImportCompleted {
		item.Status = domain.WhiteboardLibraryImportExpired
		item.LibraryJSON = nil
	}
	return item, nil
}

func (r *WhiteboardRepository) CompleteWhiteboardLibraryImport(ctx context.Context, accountID, actorID, boardID, importID, operationID uuid.UUID, libraryVersion int64, now time.Time) (*domain.WhiteboardLibraryImport, error) {
	if accountID == uuid.Nil || actorID == uuid.Nil || boardID == uuid.Nil || importID == uuid.Nil || operationID == uuid.Nil || libraryVersion <= 0 {
		return nil, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() {
		rollbackCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(rollbackCtx)
	}()
	if err := lockWhiteboardLibraryImportViewAccessTx(ctx, tx, accountID, actorID, boardID); err != nil {
		return nil, err
	}
	item, storedOperationID, err := scanWhiteboardLibraryImportWithCompletion(tx.QueryRow(ctx, `SELECT `+whiteboardLibraryImportColumns+`,
		import_item.completion_operation_id
		FROM whiteboard_library_import_sessions import_item
		WHERE import_item.account_id=$1 AND import_item.actor_id=$2 AND import_item.board_id=$3 AND import_item.id=$4
		FOR UPDATE`,
		accountID, actorID, boardID, importID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	if item.Status == domain.WhiteboardLibraryImportCompleted {
		if storedOperationID != nil && *storedOperationID == operationID && item.CompletedLibraryVersion != nil && *item.CompletedLibraryVersion == libraryVersion {
			if err := tx.Commit(ctx); err != nil {
				return nil, err
			}
			return item, nil
		}
		return nil, ErrWhiteboardConflict
	}
	if !item.ExpiresAt.After(now) {
		return nil, ErrWhiteboardLibraryImportExpired
	}
	if item.Status != domain.WhiteboardLibraryImportReady {
		return nil, ErrWhiteboardLibraryImportUnavailable
	}

	var currentLibraryVersion int64
	var persistedLibraryJSON json.RawMessage
	err = tx.QueryRow(ctx, `SELECT library.version,library.library_json
		FROM whiteboard_libraries library
		WHERE library.account_id=$1 AND library.id=$2 AND library.created_by=$3
		AND library.visibility='private' AND library.archived_at IS NULL
		FOR UPDATE`, accountID, item.LibraryID, actorID).Scan(&currentLibraryVersion, &persistedLibraryJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardNotFound
	}
	if err != nil {
		return nil, err
	}
	if currentLibraryVersion != libraryVersion {
		return nil, &WhiteboardConflictError{CurrentVersion: currentLibraryVersion}
	}
	if err := whiteboardLibraryContainsImportedItems(item.LibraryJSON, persistedLibraryJSON); err != nil {
		return nil, err
	}

	completed, err := scanWhiteboardLibraryImport(tx.QueryRow(ctx, `UPDATE whiteboard_library_import_sessions AS import_item
		SET status='completed',completion_operation_id=$5,completed_library_version=$6,completed_at=$7,
		library_json=NULL,source_url=NULL,updated_at=NOW()
		WHERE import_item.account_id=$1 AND import_item.actor_id=$2 AND import_item.board_id=$3 AND import_item.id=$4
		AND import_item.status='ready'
		RETURNING `+whiteboardLibraryImportColumns,
		accountID, actorID, boardID, importID, operationID, libraryVersion, now))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrWhiteboardConflict
	}
	if err != nil {
		return nil, normalizeWhiteboardConstraintError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return completed, nil
}
