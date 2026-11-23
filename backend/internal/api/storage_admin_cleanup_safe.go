package api

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The old global scan is only a candidate list. Destruction requires a fresh
// proof under the same tenant barrier used by user cleanup/reference writers.
// Administrative intents are separate from recoverable user media.
func (s *Server) storageAdminRemoveOrphan(ctx context.Context, actorID uuid.UUID, item adminStorageOrphanItem, minAgeDays int) (int64, error) {
	accountID, err := uuid.Parse(item.AccountID)
	if err != nil || actorID == uuid.Nil || !storageSelfServiceValidKey(accountID, item.ObjectKey) {
		return 0, fmt.Errorf("La identidad del archivo no es válida.")
	}
	tx, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, storageSelfServiceReferenceLock, accountID); err != nil {
		return 0, err
	}
	if _, err = tx.Exec(ctx, `UPDATE storage_reference_epochs SET version=version+1 WHERE account_id=$1`, accountID); err != nil {
		return 0, err
	}
	var state string
	err = tx.QueryRow(ctx, `SELECT state FROM storage_admin_delete_intents WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, item.ObjectKey).Scan(&state)
	if err != nil && err != pgx.ErrNoRows {
		return 0, err
	}
	if state == "purged" {
		return 0, nil
	}
	if state == "" {
		refs, e := storageSelfServiceObjectReferences(ctx, tx, accountID, item.ObjectKey, s.storage)
		if e != nil {
			return 0, e
		}
		if len(refs) > 0 {
			return 0, fmt.Errorf("El archivo tiene usos vigentes y se conserva.")
		}
		var retained bool
		err = tx.QueryRow(ctx, `SELECT
		 EXISTS(SELECT 1 FROM storage_media_trash WHERE account_id=$1 AND object_key=$2 AND state IN ('trash','purging'))
		 OR EXISTS(SELECT 1 FROM storage_removed_references WHERE account_id=$1 AND object_key=$2 AND state IN ('removed','purging'))
		 OR EXISTS(SELECT 1 FROM storage_upload_ownership WHERE account_id=$1 AND object_key=$2 AND state='active')
		 OR EXISTS(SELECT 1 FROM media_assets WHERE account_id=$1 AND object_key=$2 AND (status='active' AND NOT (`+storageLinkPreviewAssetSQL+`) OR (`+storageLinkPreviewAssetLeaseSQL+`)))`, accountID, item.ObjectKey).Scan(&retained)
		if err != nil {
			return 0, err
		}
		if retained {
			return 0, fmt.Errorf("El archivo conserva una carga, un inventario activo o una recuperación pendiente.")
		}
		info, e := s.storage.GetFileInfo(ctx, item.ObjectKey)
		if e != nil {
			return 0, e
		}
		if info.Size != item.SizeBytes || !info.LastModified.Equal(item.LastModified) || info.LastModified.After(time.Now().Add(-time.Duration(minAgeDays)*24*time.Hour)) {
			return 0, fmt.Errorf("El archivo cambió o no cumple la antigüedad revisada.")
		}
		if _, err = tx.Exec(ctx, `INSERT INTO storage_admin_delete_intents(account_id,object_key,actor_id,size_bytes) VALUES($1,$2,$3,$4)`, accountID, item.ObjectKey, actorID, info.Size); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE media_assets SET status='deleting',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey); err != nil {
			return 0, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	finish, err := s.repos.DB().Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer finish.Rollback(context.Background())
	if err = finish.QueryRow(ctx, `SELECT state FROM storage_admin_delete_intents WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, item.ObjectKey).Scan(&state); err != nil {
		return 0, err
	}
	if state == "purged" {
		return 0, nil
	}
	// After commit the reference trigger rejects this exact key on every writer.
	// An interrupted/ambiguous delete remains explicitly retryable.
	var freed int64
	info, err := s.storage.GetFileInfo(ctx, item.ObjectKey)
	if err == nil {
		if err = s.storage.DeleteFile(ctx, item.ObjectKey); err != nil {
			return 0, err
		}
		_, verifyErr := s.storage.GetFileInfo(ctx, item.ObjectKey)
		if !storageSelfServiceObjectMissing(verifyErr) {
			return 0, fmt.Errorf("No se pudo verificar el borrado físico.")
		}
		freed = info.Size
	} else if !storageSelfServiceObjectMissing(err) {
		return 0, err
	}
	if _, err = finish.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey); err != nil {
		return 0, err
	}
	if _, err = finish.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey); err != nil {
		return 0, err
	}
	if _, err = finish.Exec(ctx, `UPDATE storage_admin_delete_intents SET state='purged',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, accountID, item.ObjectKey); err != nil {
		return 0, err
	}
	if err = finish.Commit(ctx); err != nil {
		return 0, err
	}
	s.storageSelfServicePublishChanged(accountID, "changed")
	return freed, nil
}

func (s *Server) storageAdminPendingOrphans(ctx context.Context) ([]adminStorageOrphanItem, error) {
	rows, err := s.repos.DB().Query(ctx, `SELECT i.object_key,i.account_id::text,a.name,i.size_bytes,i.created_at FROM storage_admin_delete_intents i JOIN accounts a ON a.id=i.account_id WHERE i.state='purging' ORDER BY i.account_id,i.object_key`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []adminStorageOrphanItem{}
	for rows.Next() {
		var item adminStorageOrphanItem
		if err = rows.Scan(&item.ObjectKey, &item.AccountID, &item.AccountName, &item.SizeBytes, &item.LastModified); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
