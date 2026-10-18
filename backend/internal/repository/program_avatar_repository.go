package repository

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

const programAvatarHashPrefix = "program_avatar:"

var ErrProgramAvatarConflict = errors.New("program avatar changed")

// SaveAvatar shares the proven Contact image inventory/GC implementation while
// keeping a distinct namespace and entity identity. nil data removes the photo.
func (r *ProgramRepository) SaveAvatar(ctx context.Context, store *storage.Storage, accountID, programID uuid.UUID, expectedRevision int64, data []byte) (saved *domain.Program, saveErr error) {
	if expectedRevision < 0 {
		return nil, ErrProgramAvatarConflict
	}
	if data != nil && store == nil {
		return nil, errors.New("storage not configured")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('storage-self-service:' || $1::text,0))`, accountID); err != nil {
		return nil, err
	}
	var revision int64
	var oldAsset *uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT avatar_revision,avatar_media_asset_id FROM programs WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, programID).Scan(&revision, &oldAsset); err != nil {
		return nil, err
	}
	if revision != expectedRevision {
		return nil, ErrProgramAvatarConflict
	}
	var nextAsset *uuid.UUID
	var restored bool
	if data != nil {
		if len(data) == 0 {
			return nil, errors.New("avatar image is empty")
		}
		assets := NewContactAvatarRepository(r.db)
		hash := fmt.Sprintf("%s%x", programAvatarHashPrefix, sha256.Sum256(data))
		assetID, _, uploadedKey, wasRestored, assetErr := assets.ensureAsset(ctx, tx, store, accountID, programID, hash, data)
		attached := false
		defer func() {
			if attached {
				return
			}
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = tx.Rollback(cleanupCtx)
			if uploadedKey != "" {
				saveErr = errors.Join(saveErr, assets.trackUnattachedUpload(cleanupCtx, accountID, uploadedKey, hash, int64(len(data))))
			} else if assetID != uuid.Nil {
				saveErr = errors.Join(saveErr, assets.ScheduleAssetGC(cleanupCtx, accountID, assetID))
			}
		}()
		if assetErr != nil {
			return nil, assetErr
		}
		nextAsset = &assetID
		restored = wasRestored
		if _, err = tx.Exec(ctx, programAvatarAttachQuery, accountID, programID, nextAsset, restored); err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
		attached = true
	} else {
		if _, err = tx.Exec(ctx, programAvatarAttachQuery, accountID, programID, nextAsset, false); err != nil {
			return nil, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
	}
	return r.GetByID(ctx, accountID, programID)
}

const programAvatarAttachQuery = `UPDATE programs SET avatar_media_asset_id=$3::uuid,
 avatar_revision=avatar_revision+CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3::uuid OR $4::boolean THEN 1 ELSE 0 END,
 avatar_updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3::uuid OR $4::boolean THEN NOW() ELSE avatar_updated_at END,
 updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3::uuid OR $4::boolean THEN NOW() ELSE updated_at END
 WHERE account_id=$1 AND id=$2`

func (r *ProgramRepository) AvatarContent(ctx context.Context, accountID, programID uuid.UUID) (string, int64, error) {
	var key string
	var revision int64
	err := r.db.QueryRow(ctx, `SELECT ma.object_key,p.avatar_revision FROM programs p JOIN media_assets ma ON ma.account_id=p.account_id AND ma.id=p.avatar_media_asset_id AND ma.status='active' WHERE p.account_id=$1 AND p.id=$2`, accountID, programID).Scan(&key, &revision)
	return key, revision, err
}
