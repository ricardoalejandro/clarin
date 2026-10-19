package repository

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ReserveLinkPreviewMedia records the object before uploading any bytes. A
// process failure leaves an inventoried orphan, never an invisible S3 object.
// Reservations are leases; concurrent deliveries may omit the optional image
// rather than upload the same thumbnail twice or attach unfinished bytes.
func (r *MediaAssetRepository) ReserveLinkPreviewMedia(ctx context.Context, accountID uuid.UUID, hash string, size int64) (id uuid.UUID, key string, reused bool, err error) {
	if accountID == uuid.Nil || !strings.HasPrefix(hash, "link_preview:") || len(hash) != len("link_preview:")+64 || size < 1 || size > 128<<10 {
		return id, "", false, fmt.Errorf("invalid link preview reservation")
	}
	if _, err = hex.DecodeString(strings.TrimPrefix(hash, "link_preview:")); err != nil {
		return id, "", false, fmt.Errorf("invalid link preview hash")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return id, "", false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:'||$1::text,0))`, accountID); err != nil {
		return id, "", false, err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('link-preview-upload:'||$1::text,0))`, accountID); err != nil {
		return id, "", false, err
	}
	var status string
	var updated time.Time
	err = tx.QueryRow(ctx, `SELECT id,object_key,status,updated_at FROM media_assets WHERE account_id=$1 AND content_hash=$2 FOR UPDATE`, accountID, hash).Scan(&id, &key, &status, &updated)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return id, "", false, err
	}
	if err == nil && status == "active" {
		if !validLinkPreviewObjectKey(accountID, key) {
			return id, "", false, fmt.Errorf("invalid stored link preview object")
		}
		_, err = tx.Exec(ctx, `UPDATE media_assets SET updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, id)
		if err == nil {
			err = tx.Commit(ctx)
		}
		return id, key, true, err
	}
	if err == nil && (strings.Contains(status, "deleting") || (status == "link_preview_uploading" && time.Since(updated) < 10*time.Minute)) {
		return id, "", false, ErrMediaAssetDeletionInProgress
	}
	if id != uuid.Nil {
		var retained bool
		if err = tx.QueryRow(ctx, `SELECT clarin_storage_has_live_references($1,$2,$3) OR EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging')) OR EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging'))`, accountID, key, id).Scan(&retained); err != nil {
			return id, "", false, err
		}
		if retained {
			return id, "", false, ErrMediaAssetDeletionInProgress
		}
	}
	var limit, used int64
	if err = tx.QueryRow(ctx, `SELECT COALESCE(storage_limit_bytes,0) FROM accounts WHERE id=$1`, accountID).Scan(&limit); err != nil {
		return id, "", false, err
	}
	if err = tx.QueryRow(ctx, `SELECT COALESCE(SUM(size_bytes),0) FROM storage_objects WHERE account_id=$1 AND status<>'deleted'`, accountID).Scan(&used); err != nil {
		return id, "", false, err
	}
	if limit > 0 && used+size > limit {
		return id, "", false, fmt.Errorf("account storage limit reached")
	}
	// Never reuse a retired physical key: a previous purge may still be retrying.
	key = accountID.String() + "/link-previews/" + strings.TrimPrefix(hash, "link_preview:") + ".jpg"
	if id != uuid.Nil {
		key = accountID.String() + "/link-previews/" + strings.TrimPrefix(hash, "link_preview:") + "-" + uuid.NewString() + ".jpg"
	}
	err = tx.QueryRow(ctx, `INSERT INTO media_assets(account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status)
	VALUES($1,$2,$3,'image','image/jpeg','link-preview.jpg',$4,'link_preview_uploading')
	ON CONFLICT(account_id,content_hash) DO UPDATE SET object_key=EXCLUDED.object_key,size_bytes=EXCLUDED.size_bytes,status='link_preview_uploading',deleted_at=NULL,updated_at=NOW()
	RETURNING id`, accountID, hash, key, size).Scan(&id)
	if err != nil {
		return id, "", false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,filename,size_bytes,source,status)
	VALUES($1,$2,'image','image/jpeg','link-preview.jpg',$3,'link_preview','active')`, accountID, key, size)
	if err == nil {
		err = tx.Commit(ctx)
	}
	return id, key, false, err
}

func (r *MediaAssetRepository) CompleteLinkPreviewMedia(ctx context.Context, accountID, id uuid.UUID, key string, uploaded bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:'||$1::text,0))`, accountID); err != nil {
		return err
	}
	status := "orphan"
	if uploaded {
		status = "active"
	}
	tag, err := tx.Exec(ctx, `UPDATE media_assets SET status=$4,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND object_key=$3 AND status='link_preview_uploading'`, accountID, id, key, status)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrMediaAssetDeletionInProgress
	}
	_, err = tx.Exec(ctx, `UPDATE storage_objects SET status=$3,updated_at=NOW() WHERE account_id=$1 AND object_key=$2 AND source='link_preview'`, accountID, key, status)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
