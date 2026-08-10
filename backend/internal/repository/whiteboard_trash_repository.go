package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type WhiteboardPurgeResult struct {
	Revisions int `json:"revisions"`
	Assets    int `json:"assets"`
}

func whiteboardTrashEligibility(archivedAt time.Time, retentionDays int, now time.Time) (time.Time, bool) {
	nextEligibleAt := archivedAt.Add(time.Duration(retentionDays) * 24 * time.Hour)
	return nextEligibleAt, !nextEligibleAt.After(now)
}

func (r *WhiteboardRepository) GetTrashRetentionDays(ctx context.Context, accountID uuid.UUID) (int, error) {
	var days int
	if err := r.db.QueryRow(ctx, `SELECT whiteboard_trash_retention_days FROM accounts WHERE id=$1`, accountID).Scan(&days); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrWhiteboardNotFound
		}
		return 0, err
	}
	return days, nil
}

func requireWhiteboardAccountAdminTx(ctx context.Context, tx pgx.Tx, accountID, actorID uuid.UUID) error {
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM users actor
		LEFT JOIN user_accounts membership ON membership.user_id=actor.id AND membership.account_id=$1
		WHERE actor.id=$2 AND actor.is_active
		AND (actor.is_super_admin OR membership.role IN ('admin','super_admin'))
	)`, accountID, actorID).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return ErrWhiteboardForbidden
	}
	return nil
}

func (r *WhiteboardRepository) UpdateTrashRetentionDays(ctx context.Context, accountID, actorID uuid.UUID, days int) error {
	if days < 7 || days > 365 {
		return fmt.Errorf("%w: retention days must be between 7 and 365", ErrWhiteboardInvalid)
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireWhiteboardAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE accounts SET whiteboard_trash_retention_days=$2,updated_at=NOW() WHERE id=$1`, accountID, days)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrWhiteboardNotFound
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) PurgeBoard(ctx context.Context, accountID, actorID, boardID uuid.UUID, confirmationName string, now time.Time) (*WhiteboardPurgeResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := requireWhiteboardAccountAdminTx(ctx, tx, accountID, actorID); err != nil {
		return nil, err
	}
	var name string
	var archivedAt *time.Time
	var retentionDays int
	if err := tx.QueryRow(ctx, `SELECT board.name,board.archived_at,account.whiteboard_trash_retention_days
		FROM whiteboards board JOIN accounts account ON account.id=board.account_id
		WHERE board.account_id=$1 AND board.id=$2 FOR UPDATE OF board,account`, accountID, boardID).Scan(
		&name, &archivedAt, &retentionDays); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWhiteboardNotFound
		}
		return nil, err
	}
	if confirmationName != name {
		return nil, ErrWhiteboardTrashConfirmation
	}
	if archivedAt == nil {
		return nil, ErrWhiteboardTrashNotEligible
	}
	nextEligibleAt, eligible := whiteboardTrashEligibility(*archivedAt, retentionDays, now)
	if !eligible {
		return nil, &WhiteboardTrashEligibilityError{NextEligibleAt: nextEligibleAt}
	}

	mediaRows, err := tx.Query(ctx, `SELECT DISTINCT media_asset_id FROM (
		SELECT media_asset_id FROM whiteboard_assets WHERE account_id=$1 AND board_id=$2
		UNION ALL SELECT media_asset_id FROM whiteboard_revision_assets WHERE account_id=$1 AND board_id=$2
		UNION ALL SELECT thumbnail_media_asset_id FROM whiteboards
			WHERE account_id=$1 AND id=$2 AND thumbnail_media_asset_id IS NOT NULL
	) candidates ORDER BY media_asset_id`, accountID, boardID)
	if err != nil {
		return nil, err
	}
	mediaIDs := make([]uuid.UUID, 0)
	for mediaRows.Next() {
		var mediaID uuid.UUID
		if err := mediaRows.Scan(&mediaID); err != nil {
			mediaRows.Close()
			return nil, err
		}
		mediaIDs = append(mediaIDs, mediaID)
	}
	if err := mediaRows.Err(); err != nil {
		mediaRows.Close()
		return nil, err
	}
	mediaRows.Close()

	snapshotRows, err := tx.Query(ctx, `SELECT snapshot_object_key FROM whiteboard_revisions
		WHERE account_id=$1 AND board_id=$2 ORDER BY id FOR UPDATE`, accountID, boardID)
	if err != nil {
		return nil, err
	}
	snapshotKeys := make([]string, 0)
	for snapshotRows.Next() {
		var objectKey string
		if err := snapshotRows.Scan(&objectKey); err != nil {
			snapshotRows.Close()
			return nil, err
		}
		snapshotKeys = append(snapshotKeys, objectKey)
	}
	if err := snapshotRows.Err(); err != nil {
		snapshotRows.Close()
		return nil, err
	}
	snapshotRows.Close()

	command, err := tx.Exec(ctx, `DELETE FROM whiteboards WHERE account_id=$1 AND id=$2`, accountID, boardID)
	if err != nil {
		return nil, err
	}
	if command.RowsAffected() != 1 {
		return nil, ErrWhiteboardConflict
	}
	for _, mediaID := range mediaIDs {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaID); err != nil {
			return nil, err
		}
	}
	for _, objectKey := range snapshotKeys {
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_snapshot_gc_jobs(
			account_id,object_key,status,claim_token,last_error,available_at,updated_at
		) VALUES($1,$2,'pending',NULL,'',NOW(),NOW())
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='pending',claim_token=NULL,
			last_error='',available_at=NOW(),updated_at=NOW()`, accountID, objectKey); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_pending',
			next_delete_at=NOW(),delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status<>'deleted'`, accountID, objectKey); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &WhiteboardPurgeResult{Revisions: len(snapshotKeys), Assets: len(mediaIDs)}, nil
}
