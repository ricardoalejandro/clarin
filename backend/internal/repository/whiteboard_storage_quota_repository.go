package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// reserveWhiteboardStorageQuotaTx serializes inventory reservations per
// account. The storage_objects row itself is the durable reservation, so two
// concurrent uploads cannot both pass the same remaining quota.
func reserveWhiteboardStorageQuotaTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, objectKey string, requestedBytes int64) error {
	if accountID == uuid.Nil || objectKey == "" || requestedBytes <= 0 {
		return ErrWhiteboardInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "whiteboard-storage:"+accountID.String()); err != nil {
		return err
	}
	var limit int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(storage_limit_bytes,0) FROM accounts WHERE id=$1`, accountID).Scan(&limit); err != nil {
		return err
	}
	if limit <= 0 {
		return nil
	}
	var used int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(size_bytes),0) FROM storage_objects
		WHERE account_id=$1 AND status<>'deleted'`, accountID).Scan(&used); err != nil {
		return err
	}
	var existingSize int64
	var existingStatus string
	err := tx.QueryRow(ctx, `SELECT size_bytes,status FROM storage_objects
		WHERE account_id=$1 AND object_key=$2`, accountID, objectKey).Scan(&existingSize, &existingStatus)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	delta := whiteboardQuotaDelta(requestedBytes, existingSize, existingStatus, err == nil)
	if used > limit-delta {
		return ErrWhiteboardStorageLimit
	}
	return nil
}

func whiteboardQuotaDelta(requestedBytes, existingSize int64, existingStatus string, exists bool) int64 {
	if !exists || existingStatus == "deleted" {
		return requestedBytes
	}
	if requestedBytes > existingSize {
		return requestedBytes - existingSize
	}
	return 0
}
