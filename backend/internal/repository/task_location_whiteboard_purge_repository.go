package repository

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type taskLocationWhiteboardPurgeSet struct {
	ViewIDs      []uuid.UUID
	BoardIDs     []uuid.UUID
	MediaIDs     []uuid.UUID
	SnapshotKeys []string
	EligibleAt   time.Time
}

func taskLocationWhiteboardPurgeEligibleAt(
	parentEligibleAt time.Time,
	viewDeletedAt, boardArchivedAt *time.Time,
	whiteboardRetentionDays *int,
) (time.Time, error) {
	explicitlyDeletedAt := viewDeletedAt
	if explicitlyDeletedAt == nil || (boardArchivedAt != nil && boardArchivedAt.After(*explicitlyDeletedAt)) {
		explicitlyDeletedAt = boardArchivedAt
	}
	if explicitlyDeletedAt == nil {
		return parentEligibleAt, nil
	}
	if whiteboardRetentionDays == nil {
		return time.Time{}, ErrTaskTrashDisabled
	}
	whiteboardEligibleAt := explicitlyDeletedAt.Add(time.Duration(*whiteboardRetentionDays) * 24 * time.Hour)
	if whiteboardEligibleAt.After(parentEligibleAt) {
		return whiteboardEligibleAt, nil
	}
	return parentEligibleAt, nil
}

// lockTaskLocationWhiteboardsForPurge captures every board owned by the
// container tree under the same transaction locks as the parent purge. Active
// contextual boards follow the parent's retention clock. An explicitly
// trashed board/view can only move the clock later, never earlier.
func lockTaskLocationWhiteboardsForPurge(
	ctx context.Context,
	tx pgx.Tx,
	accountID, environmentID uuid.UUID,
	folderIDs, listIDs []uuid.UUID,
	includeEnvironment bool,
	parentEligibleAt time.Time,
	whiteboardRetentionDays *int,
	workWhiteboardViewsEnabled bool,
) (*taskLocationWhiteboardPurgeSet, error) {
	set := &taskLocationWhiteboardPurgeSet{EligibleAt: parentEligibleAt}
	rows, err := tx.Query(ctx, `SELECT location_view.id,location_view.deleted_at,board.id,board.archived_at
		FROM task_location_views location_view
		JOIN task_location_whiteboard_views binding ON binding.account_id=location_view.account_id
			AND binding.task_view_id=location_view.id
		JOIN whiteboards board ON board.account_id=binding.account_id AND board.id=binding.whiteboard_id
		WHERE location_view.account_id=$1 AND (
			($5::boolean AND location_view.environment_id=$2) OR
			(COALESCE(cardinality($3::uuid[]),0)>0 AND location_view.folder_id=ANY($3::uuid[])) OR
			(COALESCE(cardinality($4::uuid[]),0)>0 AND location_view.list_id=ANY($4::uuid[]))
		) ORDER BY location_view.id FOR UPDATE OF location_view`,
		accountID, environmentID, folderIDs, listIDs, includeEnvironment)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var viewID, boardID uuid.UUID
		var viewDeletedAt, boardArchivedAt *time.Time
		if err := rows.Scan(&viewID, &viewDeletedAt, &boardID, &boardArchivedAt); err != nil {
			rows.Close()
			return nil, err
		}
		set.ViewIDs = append(set.ViewIDs, viewID)
		set.BoardIDs = append(set.BoardIDs, boardID)
		// The kill switch is also a destructive-write barrier. This check runs
		// only after the parent tree and contextual view are locked, so a
		// concurrent create cannot slip between a handler precheck and purge.
		if !workWhiteboardViewsEnabled {
			rows.Close()
			return nil, ErrTaskLocationViewDisabled
		}
		set.EligibleAt, err = taskLocationWhiteboardPurgeEligibleAt(
			set.EligibleAt, viewDeletedAt, boardArchivedAt, whiteboardRetentionDays,
		)
		if err != nil {
			rows.Close()
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(set.BoardIDs) == 0 {
		return set, nil
	}
	if err := lockWhiteboardRowsTx(ctx, tx, accountID, set.BoardIDs); err != nil {
		return nil, err
	}

	mediaRows, err := tx.Query(ctx, `SELECT DISTINCT media_asset_id FROM (
		SELECT media_asset_id FROM whiteboard_assets WHERE account_id=$1 AND board_id=ANY($2::uuid[])
		UNION ALL SELECT media_asset_id FROM whiteboard_revision_assets WHERE account_id=$1 AND board_id=ANY($2::uuid[])
		UNION ALL SELECT thumbnail_media_asset_id FROM whiteboards
			WHERE account_id=$1 AND id=ANY($2::uuid[]) AND thumbnail_media_asset_id IS NOT NULL
	) candidates ORDER BY media_asset_id`, accountID, set.BoardIDs)
	if err != nil {
		return nil, err
	}
	for mediaRows.Next() {
		var mediaID uuid.UUID
		if err := mediaRows.Scan(&mediaID); err != nil {
			mediaRows.Close()
			return nil, err
		}
		set.MediaIDs = append(set.MediaIDs, mediaID)
	}
	if err := mediaRows.Err(); err != nil {
		mediaRows.Close()
		return nil, err
	}
	mediaRows.Close()

	snapshotRows, err := tx.Query(ctx, `SELECT snapshot_object_key FROM whiteboard_revisions
		WHERE account_id=$1 AND board_id=ANY($2::uuid[]) ORDER BY board_id,id FOR UPDATE`, accountID, set.BoardIDs)
	if err != nil {
		return nil, err
	}
	for snapshotRows.Next() {
		var objectKey string
		if err := snapshotRows.Scan(&objectKey); err != nil {
			snapshotRows.Close()
			return nil, err
		}
		set.SnapshotKeys = append(set.SnapshotKeys, objectKey)
	}
	if err := snapshotRows.Err(); err != nil {
		snapshotRows.Close()
		return nil, err
	}
	snapshotRows.Close()
	return set, nil
}

func deleteTaskLocationWhiteboardsForPurge(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, set *taskLocationWhiteboardPurgeSet) error {
	if set == nil || len(set.BoardIDs) == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_location_whiteboard_views
		WHERE account_id=$1 AND task_view_id=ANY($2::uuid[]) AND whiteboard_id=ANY($3::uuid[])`,
		accountID, set.ViewIDs, set.BoardIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM task_location_views WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, set.ViewIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboards WHERE account_id=$1 AND id=ANY($2::uuid[])`, accountID, set.BoardIDs); err != nil {
		return err
	}
	for _, mediaID := range set.MediaIDs {
		if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaID); err != nil {
			return err
		}
	}
	for _, objectKey := range set.SnapshotKeys {
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_snapshot_gc_jobs(
			account_id,object_key,status,claim_token,last_error,available_at,updated_at
		) VALUES($1,$2,'pending',NULL,'',NOW(),NOW())
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='pending',claim_token=NULL,
			last_error='',available_at=NOW(),updated_at=NOW()`, accountID, objectKey); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_pending',
			next_delete_at=NOW(),delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status<>'deleted'`, accountID, objectKey); err != nil {
			return err
		}
	}
	return nil
}
