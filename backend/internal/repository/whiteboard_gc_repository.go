package repository

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const (
	whiteboardGCRetryBase   = time.Minute
	whiteboardGCRetryMax    = time.Hour
	whiteboardGCErrorLength = 1000
)

const whiteboardTechnicalOperationPruneSQL = `WITH candidates AS (
	SELECT operation.id,operation.account_id,operation.board_id
	FROM whiteboard_operations operation
	WHERE operation.created_at<$1 AND (
		operation.operation_kind='patch' OR (
			operation.operation_kind='snapshot' AND NOT EXISTS (
				SELECT 1 FROM whiteboard_revisions revision
				WHERE revision.account_id=operation.account_id
					AND revision.board_id=operation.board_id
					AND revision.operation_id=operation.operation_id
			)
		)
	)
	ORDER BY operation.created_at,operation.id
	FOR UPDATE OF operation SKIP LOCKED LIMIT $2
)
DELETE FROM whiteboard_operations operation USING candidates
WHERE operation.id=candidates.id AND operation.account_id=candidates.account_id AND operation.board_id=candidates.board_id
RETURNING operation.id`

const whiteboardTechnicalActivityPruneSQL = `WITH candidates AS (
	SELECT activity.id,activity.account_id,activity.board_id
	FROM whiteboard_activity activity
	WHERE activity.created_at<$1
		AND activity.action IN ('scene.patched','scene.snapshotted','thumbnail.updated')
	ORDER BY activity.created_at,activity.id
	FOR UPDATE OF activity SKIP LOCKED LIMIT $2
)
DELETE FROM whiteboard_activity activity USING candidates
WHERE activity.id=candidates.id AND activity.account_id=candidates.account_id AND activity.board_id=candidates.board_id
RETURNING activity.id`

// WhiteboardMediaGCJob identifies one account-scoped physical media object.
// ClaimToken prevents a worker whose lease expired from finalizing a newer
// reservation for the same deduplicated media row.
type WhiteboardMediaGCJob struct {
	ID           uuid.UUID
	AccountID    uuid.UUID
	MediaAssetID uuid.UUID
	ObjectKey    string
	ClaimToken   uuid.UUID
	Attempts     int
}

// WhiteboardSnapshotGCJob identifies one immutable scene object. Snapshot
// object keys are unique, but the token is still required because an upload
// retry can race a recovered worker lease.
type WhiteboardSnapshotGCJob struct {
	ID         uuid.UUID
	AccountID  uuid.UUID
	ObjectKey  string
	ClaimToken uuid.UUID
	Attempts   int
}

type expiredWhiteboardRevision struct {
	ID         uuid.UUID
	AccountID  uuid.UUID
	ObjectKey  string
	MediaAsset []uuid.UUID
}

type unreferencedWhiteboardAssetLink struct {
	ID           uuid.UUID
	AccountID    uuid.UUID
	MediaAssetID uuid.UUID
}

func whiteboardGCLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func whiteboardTechnicalGCLimit(limit int) int {
	if limit <= 0 {
		return 100
	}
	if limit > 500 {
		return 500
	}
	return limit
}

func countWhiteboardPrunedRows(rows pgx.Rows) (int, error) {
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return 0, err
		}
		count++
	}
	return count, rows.Err()
}

// PruneWhiteboardTechnicalHistory compacts only replay/audit noise older than
// the supplied cutoff. Snapshot operations remain while their immutable
// revision exists, which preserves every manual, system and unexpired
// automatic recovery point. Create and restore operations are never selected.
func (r *WhiteboardRepository) PruneWhiteboardTechnicalHistory(ctx context.Context, cutoff time.Time, limit int) (int, int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	batchLimit := whiteboardTechnicalGCLimit(limit)
	operationRows, err := tx.Query(ctx, whiteboardTechnicalOperationPruneSQL, cutoff, batchLimit)
	if err != nil {
		return 0, 0, err
	}
	operationCount, err := countWhiteboardPrunedRows(operationRows)
	if err != nil {
		return 0, 0, err
	}
	activityRows, err := tx.Query(ctx, whiteboardTechnicalActivityPruneSQL, cutoff, batchLimit)
	if err != nil {
		return 0, 0, err
	}
	activityCount, err := countWhiteboardPrunedRows(activityRows)
	if err != nil {
		return 0, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}
	return operationCount, activityCount, nil
}

func whiteboardGCRetryDelay(attempts int) time.Duration {
	if attempts < 0 {
		attempts = 0
	}
	delay := whiteboardGCRetryBase
	for attempt := 0; attempt < attempts && delay < whiteboardGCRetryMax; attempt++ {
		delay *= 2
		if delay >= whiteboardGCRetryMax {
			return whiteboardGCRetryMax
		}
	}
	return delay
}

func whiteboardGCError(cause error) string {
	if cause == nil {
		return ""
	}
	message := strings.TrimSpace(cause.Error())
	if len(message) > whiteboardGCErrorLength {
		message = message[:whiteboardGCErrorLength]
	}
	return message
}

// EnqueueExpiredWhiteboardRevisions removes only expired automatic revision
// metadata. The immutable object and any newly unreferenced media are queued in
// the same transaction, so a crash can never strand physical data invisibly.
func (r *WhiteboardRepository) EnqueueExpiredWhiteboardRevisions(ctx context.Context, limit int) (int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `SELECT id,account_id,snapshot_object_key
		FROM whiteboard_revisions
		WHERE revision_kind='automatic' AND expires_at<=NOW()
		ORDER BY expires_at,id
		FOR UPDATE SKIP LOCKED LIMIT $1`, whiteboardGCLimit(limit))
	if err != nil {
		return 0, err
	}
	revisions := make([]expiredWhiteboardRevision, 0, whiteboardGCLimit(limit))
	for rows.Next() {
		var revision expiredWhiteboardRevision
		if err := rows.Scan(&revision.ID, &revision.AccountID, &revision.ObjectKey); err != nil {
			rows.Close()
			return 0, err
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(revisions) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return 0, err
		}
		return 0, nil
	}

	mediaCandidates := make(map[uuid.UUID]map[uuid.UUID]struct{})
	for index := range revisions {
		assetRows, err := tx.Query(ctx, `SELECT DISTINCT media_asset_id
			FROM whiteboard_revision_assets WHERE account_id=$1 AND revision_id=$2`,
			revisions[index].AccountID, revisions[index].ID)
		if err != nil {
			return 0, err
		}
		for assetRows.Next() {
			var mediaAssetID uuid.UUID
			if err := assetRows.Scan(&mediaAssetID); err != nil {
				assetRows.Close()
				return 0, err
			}
			revisions[index].MediaAsset = append(revisions[index].MediaAsset, mediaAssetID)
			if mediaCandidates[revisions[index].AccountID] == nil {
				mediaCandidates[revisions[index].AccountID] = make(map[uuid.UUID]struct{})
			}
			mediaCandidates[revisions[index].AccountID][mediaAssetID] = struct{}{}
		}
		if err := assetRows.Err(); err != nil {
			assetRows.Close()
			return 0, err
		}
		assetRows.Close()

		command, err := tx.Exec(ctx, `DELETE FROM whiteboard_revisions
			WHERE account_id=$1 AND id=$2 AND revision_kind='automatic' AND expires_at<=NOW()`,
			revisions[index].AccountID, revisions[index].ID)
		if err != nil {
			return 0, err
		}
		if command.RowsAffected() != 1 {
			return 0, ErrWhiteboardConflict
		}
		if _, err := tx.Exec(ctx, `INSERT INTO whiteboard_snapshot_gc_jobs(
			account_id,object_key,status,claim_token,last_error,available_at,updated_at
		) VALUES($1,$2,'pending',NULL,'',NOW(),NOW())
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='pending',claim_token=NULL,
			last_error='',available_at=NOW(),updated_at=NOW()`,
			revisions[index].AccountID, revisions[index].ObjectKey); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_pending',
			next_delete_at=NOW(),delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status<>'deleted'`,
			revisions[index].AccountID, revisions[index].ObjectKey); err != nil {
			return 0, err
		}
	}

	// Revision assets are historical live references. They are considered for
	// collection only after every expired revision row above has cascaded away.
	for accountID, candidates := range mediaCandidates {
		for mediaAssetID := range candidates {
			if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
				return 0, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(revisions), nil
}

const whiteboardUnreferencedAssetLinksSQL = `SELECT link.id,link.account_id,link.media_asset_id
	FROM whiteboard_assets link
	JOIN whiteboards board ON board.account_id=link.account_id AND board.id=link.board_id
	WHERE link.kind='asset' AND link.board_id IS NOT NULL
		AND link.committed_at IS NULL AND link.draft_expires_at<=NOW()
		AND NOT EXISTS (
			SELECT 1
			FROM jsonb_array_elements(CASE
				WHEN jsonb_typeof(board.scene_json->'elements')='array' THEN board.scene_json->'elements'
				ELSE '[]'::jsonb END) element
			WHERE element->>'fileId'=link.file_id
				AND element->'isDeleted' IS DISTINCT FROM 'true'::jsonb
		)
	ORDER BY link.draft_expires_at,link.id
	LIMIT $1 FOR UPDATE OF board SKIP LOCKED`

const whiteboardUnreferencedLibraryAssetLinksSQL = `SELECT link.id,link.account_id,link.media_asset_id,
		link.file_id,library.library_json
	FROM whiteboard_assets link
	JOIN whiteboard_libraries library ON library.account_id=link.account_id AND library.id=link.library_id
	WHERE link.kind='asset' AND link.library_id IS NOT NULL
		AND link.committed_at IS NULL AND link.draft_expires_at<=NOW()
	ORDER BY link.draft_expires_at,link.id
	LIMIT $1 FOR UPDATE OF library SKIP LOCKED`

// EnqueueUnreferencedWhiteboardAssetLinks releases abandoned uploads only
// after a one-hour grace period. The board lock serializes the reference proof
// with scene writes and attachment. Historical revision references are checked
// by scheduleWhiteboardAssetGCTx and therefore continue preserving the bytes.
func (r *WhiteboardRepository) EnqueueUnreferencedWhiteboardAssetLinks(ctx context.Context, limit int) (int, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	batchLimit := whiteboardGCLimit(limit)
	rows, err := tx.Query(ctx, whiteboardUnreferencedAssetLinksSQL, batchLimit)
	if err != nil {
		return 0, err
	}
	boardLinks := make([]unreferencedWhiteboardAssetLink, 0, batchLimit)
	for rows.Next() {
		var link unreferencedWhiteboardAssetLink
		if err := rows.Scan(&link.ID, &link.AccountID, &link.MediaAssetID); err != nil {
			rows.Close()
			return 0, err
		}
		boardLinks = append(boardLinks, link)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()

	libraryRows, err := tx.Query(ctx, whiteboardUnreferencedLibraryAssetLinksSQL, batchLimit)
	if err != nil {
		return 0, err
	}
	libraryLinks := make([]unreferencedWhiteboardAssetLink, 0, batchLimit)
	for libraryRows.Next() {
		var link unreferencedWhiteboardAssetLink
		var fileID string
		var libraryJSON json.RawMessage
		if err := libraryRows.Scan(&link.ID, &link.AccountID, &link.MediaAssetID, &fileID, &libraryJSON); err != nil {
			libraryRows.Close()
			return 0, err
		}
		referenced, err := whiteboardcore.ReferencedLibraryFileIDs(libraryJSON)
		if err != nil {
			libraryRows.Close()
			return 0, ErrWhiteboardInvalid
		}
		live := false
		for _, referencedFileID := range referenced {
			if referencedFileID == fileID {
				live = true
				break
			}
		}
		if !live {
			libraryLinks = append(libraryLinks, link)
		}
	}
	if err := libraryRows.Err(); err != nil {
		libraryRows.Close()
		return 0, err
	}
	libraryRows.Close()

	// Interleave both owners so a continuous board-upload backlog cannot starve
	// abandoned library drafts (or vice versa) while retaining the caller's
	// bounded batch size.
	links := make([]unreferencedWhiteboardAssetLink, 0, batchLimit)
	for index := 0; len(links) < batchLimit && (index < len(boardLinks) || index < len(libraryLinks)); index++ {
		if index < len(boardLinks) {
			links = append(links, boardLinks[index])
		}
		if len(links) < batchLimit && index < len(libraryLinks) {
			links = append(links, libraryLinks[index])
		}
	}
	for _, link := range links {
		command, err := tx.Exec(ctx, `DELETE FROM whiteboard_assets
			WHERE id=$1 AND account_id=$2 AND kind='asset'
			AND committed_at IS NULL AND draft_expires_at<=NOW()`,
			link.ID, link.AccountID)
		if err != nil {
			return 0, err
		}
		if command.RowsAffected() != 1 {
			return 0, ErrWhiteboardConflict
		}
	}
	mediaCandidates := make(map[uuid.UUID]map[uuid.UUID]struct{})
	for _, link := range links {
		if mediaCandidates[link.AccountID] == nil {
			mediaCandidates[link.AccountID] = make(map[uuid.UUID]struct{})
		}
		mediaCandidates[link.AccountID][link.MediaAssetID] = struct{}{}
	}
	for accountID, candidates := range mediaCandidates {
		for mediaAssetID := range candidates {
			if err := scheduleWhiteboardAssetGCTx(ctx, tx, accountID, mediaAssetID); err != nil {
				return 0, err
			}
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(links), nil
}

func (r *WhiteboardRepository) ClaimWhiteboardMediaGCJob(ctx context.Context) (*WhiteboardMediaGCJob, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	job := &WhiteboardMediaGCJob{ClaimToken: uuid.New()}
	err = tx.QueryRow(ctx, `SELECT id,account_id,media_asset_id,object_key,attempts
		FROM whiteboard_media_gc_jobs
		WHERE (status='pending' AND available_at<=NOW())
			OR (status='processing' AND updated_at<NOW()-INTERVAL '10 minutes')
		ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(
		&job.ID, &job.AccountID, &job.MediaAssetID, &job.ObjectKey, &job.Attempts)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_media_gc_jobs
		SET status='processing',claim_token=$2,updated_at=NOW() WHERE id=$1`, job.ID, job.ClaimToken); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

// Keep this proof centralized. A whiteboard upload may be account-deduplicated
// into an existing media row, so collection must consider every current media
// consumer, not only the two whiteboard link tables.
const whiteboardMediaReferenceProofSQL = `SELECT EXISTS(
	SELECT 1 FROM whiteboard_assets WHERE account_id=$1 AND media_asset_id=$2
	UNION ALL SELECT 1 FROM whiteboard_revision_assets WHERE account_id=$1 AND media_asset_id=$2
	UNION ALL SELECT 1 FROM whiteboards WHERE account_id=$1 AND thumbnail_media_asset_id=$2
	UNION ALL SELECT 1 FROM task_attachments WHERE account_id=$1 AND media_asset_id=$2
	UNION ALL SELECT 1 FROM task_attachment_previews WHERE account_id=$1 AND derivative_asset_id=$2
	UNION ALL SELECT 1 FROM messages WHERE account_id=$1 AND media_asset_id=$2
	UNION ALL SELECT 1 FROM contacts WHERE account_id=$1 AND avatar_media_asset_id=$2
	UNION ALL SELECT 1 FROM whatsapp_statuses WHERE account_id=$1 AND media_asset_id=$2
	UNION ALL SELECT 1 FROM survey_file_uploads WHERE account_id=$1 AND media_asset_id=$2 AND status<>'deleted'
	UNION ALL SELECT 1 FROM survey_branding_asset_refs WHERE account_id=$1 AND media_asset_id=$2
)`

func (r *WhiteboardRepository) PrepareWhiteboardMediaGCDeletion(ctx context.Context, job *WhiteboardMediaGCJob) (bool, error) {
	if job == nil || job.ID == uuid.Nil || job.AccountID == uuid.Nil || job.MediaAssetID == uuid.Nil || job.ClaimToken == uuid.Nil {
		return false, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND claim_token=$4 AND status='processing'
		FOR UPDATE`, job.ID, job.AccountID, job.MediaAssetID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if claimedObjectKey != job.ObjectKey {
		return false, tx.Commit(ctx)
	}
	var objectKey, mediaStatus string
	err = tx.QueryRow(ctx, `SELECT object_key,status FROM media_assets
		WHERE account_id=$1 AND id=$2 FOR UPDATE`, job.AccountID, job.MediaAssetID).Scan(&objectKey, &mediaStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if objectKey != job.ObjectKey || mediaStatus == "deleted" {
		return false, tx.Commit(ctx)
	}
	var storageStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, job.AccountID, job.ObjectKey).Scan(&storageStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if storageStatus == "deleted" {
		return false, tx.Commit(ctx)
	}
	var referenced bool
	if err := tx.QueryRow(ctx, whiteboardMediaReferenceProofSQL, job.AccountID, job.MediaAssetID).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		return false, tx.Commit(ctx)
	}
	command, err := tx.Exec(ctx, `UPDATE media_assets SET status='whiteboard_gc_deleting',updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status<>'deleted'`, job.AccountID, job.MediaAssetID, job.ObjectKey)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, ErrWhiteboardConflict
	}
	command, err = tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_gc_deleting',
		next_delete_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND status<>'deleted'`,
		job.AccountID, job.ObjectKey)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, ErrWhiteboardConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (r *WhiteboardRepository) CompleteWhiteboardMediaGCJob(ctx context.Context, job *WhiteboardMediaGCJob, deleted bool) error {
	if job == nil || job.ClaimToken == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND claim_token=$4 FOR UPDATE`,
		job.ID, job.AccountID, job.MediaAssetID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if claimedObjectKey != job.ObjectKey {
		return tx.Commit(ctx)
	}
	if deleted {
		mediaCommand, err := tx.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status='whiteboard_gc_deleting'`,
			job.AccountID, job.MediaAssetID, job.ObjectKey)
		if err != nil {
			return err
		}
		if mediaCommand.RowsAffected() != 1 {
			return ErrWhiteboardConflict
		}
		storageCommand, err := tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),
			next_delete_at=NULL,delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status='whiteboard_gc_deleting'`,
			job.AccountID, job.ObjectKey)
		if err != nil {
			return err
		}
		if storageCommand.RowsAffected() != 1 {
			return ErrWhiteboardConflict
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
			WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status IN
			('whiteboard_gc_pending','whiteboard_gc_deleting','whiteboard_upload_pending')`,
			job.AccountID, job.MediaAssetID, job.ObjectKey); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',deleted_at=NULL,
			next_delete_at=NULL,delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status IN
			('whiteboard_gc_pending','whiteboard_gc_deleting','whiteboard_upload_pending')`,
			job.AccountID, job.ObjectKey); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND object_key=$4 AND claim_token=$5`,
		job.ID, job.AccountID, job.MediaAssetID, job.ObjectKey, job.ClaimToken); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) RetryWhiteboardMediaGCJob(ctx context.Context, job *WhiteboardMediaGCJob, cause error) error {
	if job == nil || job.ClaimToken == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_media_gc_jobs
		WHERE id=$1 AND account_id=$2 AND media_asset_id=$3 AND claim_token=$4 FOR UPDATE`,
		job.ID, job.AccountID, job.MediaAssetID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && claimedObjectKey != job.ObjectKey) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	availableAt := time.Now().UTC().Add(whiteboardGCRetryDelay(job.Attempts))
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='whiteboard_gc_pending',updated_at=NOW()
		WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status='whiteboard_gc_deleting'`,
		job.AccountID, job.MediaAssetID, job.ObjectKey); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_gc_pending',
		next_delete_at=$3,delete_error=$4,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2 AND status='whiteboard_gc_deleting'`,
		job.AccountID, job.ObjectKey, availableAt, whiteboardGCError(cause)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_media_gc_jobs SET status='pending',claim_token=NULL,
		attempts=attempts+1,last_error=$3,available_at=$4,updated_at=NOW()
		WHERE id=$1 AND claim_token=$2`, job.ID, job.ClaimToken, whiteboardGCError(cause), availableAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) ClaimWhiteboardSnapshotGCJob(ctx context.Context) (*WhiteboardSnapshotGCJob, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	job := &WhiteboardSnapshotGCJob{ClaimToken: uuid.New()}
	err = tx.QueryRow(ctx, `SELECT id,account_id,object_key,attempts
		FROM whiteboard_snapshot_gc_jobs
		WHERE (status='pending' AND available_at<=NOW())
			OR (status='processing' AND updated_at<NOW()-INTERVAL '10 minutes')
		ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1`).Scan(
		&job.ID, &job.AccountID, &job.ObjectKey, &job.Attempts)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_snapshot_gc_jobs
		SET status='processing',claim_token=$2,updated_at=NOW() WHERE id=$1`, job.ID, job.ClaimToken); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return job, nil
}

func (r *WhiteboardRepository) PrepareWhiteboardSnapshotGCDeletion(ctx context.Context, job *WhiteboardSnapshotGCJob) (bool, error) {
	if job == nil || job.ID == uuid.Nil || job.AccountID == uuid.Nil || job.ClaimToken == uuid.Nil {
		return false, ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_snapshot_gc_jobs
		WHERE id=$1 AND account_id=$2 AND claim_token=$3 AND status='processing' FOR UPDATE`,
		job.ID, job.AccountID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	if claimedObjectKey != job.ObjectKey {
		return false, tx.Commit(ctx)
	}
	var storageStatus string
	err = tx.QueryRow(ctx, `SELECT status FROM storage_objects
		WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, job.AccountID, job.ObjectKey).Scan(&storageStatus)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && storageStatus == "deleted") {
		return false, tx.Commit(ctx)
	}
	if err != nil {
		return false, err
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whiteboard_revisions
		WHERE account_id=$1 AND snapshot_object_key=$2)`, job.AccountID, job.ObjectKey).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		return false, tx.Commit(ctx)
	}
	command, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_deleting',
		next_delete_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND status<>'deleted'`,
		job.AccountID, job.ObjectKey)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() != 1 {
		return false, ErrWhiteboardConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (r *WhiteboardRepository) CompleteWhiteboardSnapshotGCJob(ctx context.Context, job *WhiteboardSnapshotGCJob, deleted bool) error {
	if job == nil || job.ClaimToken == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_snapshot_gc_jobs
		WHERE id=$1 AND account_id=$2 AND claim_token=$3 FOR UPDATE`, job.ID, job.AccountID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if claimedObjectKey != job.ObjectKey {
		return tx.Commit(ctx)
	}
	if deleted {
		command, err := tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),
			next_delete_at=NULL,delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status='whiteboard_snapshot_deleting'`,
			job.AccountID, job.ObjectKey)
		if err != nil {
			return err
		}
		if command.RowsAffected() != 1 {
			return ErrWhiteboardConflict
		}
	} else {
		if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='active',deleted_at=NULL,
			next_delete_at=NULL,delete_error='',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status IN
			('whiteboard_snapshot_pending','whiteboard_snapshot_deleting','whiteboard_snapshot_uploading')`,
			job.AccountID, job.ObjectKey); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM whiteboard_snapshot_gc_jobs
		WHERE id=$1 AND account_id=$2 AND object_key=$3 AND claim_token=$4`,
		job.ID, job.AccountID, job.ObjectKey, job.ClaimToken); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *WhiteboardRepository) RetryWhiteboardSnapshotGCJob(ctx context.Context, job *WhiteboardSnapshotGCJob, cause error) error {
	if job == nil || job.ClaimToken == uuid.Nil {
		return ErrWhiteboardInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var claimedObjectKey string
	err = tx.QueryRow(ctx, `SELECT object_key FROM whiteboard_snapshot_gc_jobs
		WHERE id=$1 AND account_id=$2 AND claim_token=$3 FOR UPDATE`, job.ID, job.AccountID, job.ClaimToken).Scan(&claimedObjectKey)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && claimedObjectKey != job.ObjectKey) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	availableAt := time.Now().UTC().Add(whiteboardGCRetryDelay(job.Attempts))
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='whiteboard_snapshot_pending',
		next_delete_at=$3,delete_error=$4,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2 AND status='whiteboard_snapshot_deleting'`,
		job.AccountID, job.ObjectKey, availableAt, whiteboardGCError(cause)); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE whiteboard_snapshot_gc_jobs SET status='pending',claim_token=NULL,
		attempts=attempts+1,last_error=$3,available_at=$4,updated_at=NOW()
		WHERE id=$1 AND claim_token=$2`, job.ID, job.ClaimToken, whiteboardGCError(cause), availableAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
