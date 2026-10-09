package repository

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/minio/minio-go/v7"
	"github.com/naperu/clarin/internal/storage"
)

const contactAvatarHashPrefix = "contact_avatar:"

var ErrAvatarStorageLimit = errors.New("storage limit reached")

type ContactAvatarRecord struct {
	ContactID          uuid.UUID  `json:"contact_id"`
	AccountID          uuid.UUID  `json:"-"`
	MediaAssetID       *uuid.UUID `json:"media_asset_id,omitempty"`
	AvatarURL          *string    `json:"avatar_url,omitempty"`
	Source             *string    `json:"source,omitempty"`
	Revision           int64      `json:"revision"`
	UpdatedAt          *time.Time `json:"updated_at,omitempty"`
	WhatsAppCheckedAt  *time.Time `json:"whatsapp_checked_at,omitempty"`
	WhatsAppCheckError *string    `json:"whatsapp_check_error,omitempty"`
	AutomaticFetchAt   *time.Time `json:"automatic_fetch_at,omitempty"`
	ObjectKey          *string    `json:"-"`
	ContentType        *string    `json:"content_type,omitempty"`
	SizeBytes          *int64     `json:"size_bytes,omitempty"`
}

type SaveContactAvatarOptions struct {
	OnlyIfEmpty bool
}

type ContactAvatarRepository struct {
	db *pgxpool.Pool
}

func NewContactAvatarRepository(db *pgxpool.Pool) *ContactAvatarRepository {
	return &ContactAvatarRepository{db: db}
}

func (r *ContactAvatarRepository) Get(ctx context.Context, accountID, contactID uuid.UUID) (*ContactAvatarRecord, error) {
	record := &ContactAvatarRecord{}
	err := r.db.QueryRow(ctx, `
		SELECT c.id,c.account_id,c.avatar_media_asset_id,c.avatar_url,c.avatar_source,
		       COALESCE(c.avatar_revision,0),c.avatar_updated_at,c.avatar_whatsapp_checked_at,
		       c.avatar_whatsapp_check_error,c.avatar_auto_fetched_at,
		       ma.object_key,ma.content_type,ma.size_bytes
		FROM contacts c
		LEFT JOIN media_assets ma ON ma.id=c.avatar_media_asset_id AND ma.account_id=c.account_id AND ma.status='active'
		WHERE c.account_id=$1 AND c.id=$2
	`, accountID, contactID).Scan(
		&record.ContactID, &record.AccountID, &record.MediaAssetID, &record.AvatarURL, &record.Source,
		&record.Revision, &record.UpdatedAt, &record.WhatsAppCheckedAt,
		&record.WhatsAppCheckError, &record.AutomaticFetchAt,
		&record.ObjectKey, &record.ContentType, &record.SizeBytes,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return record, nil
}

// ClaimAutomaticFetch guarantees that automatic WhatsApp photo retrieval is
// attempted at most once for a Contact. Manual refresh remains available.
func (r *ContactAvatarRepository) ClaimAutomaticFetch(ctx context.Context, accountID, contactID uuid.UUID) (bool, error) {
	var claimed bool
	err := r.db.QueryRow(ctx, `
		UPDATE contacts
		SET avatar_auto_fetched_at=NOW()
		WHERE account_id=$1 AND id=$2 AND avatar_auto_fetched_at IS NULL
		RETURNING TRUE
	`, accountID, contactID).Scan(&claimed)
	if err == pgx.ErrNoRows {
		return false, nil
	}
	return claimed, err
}

func (r *ContactAvatarRepository) MarkWhatsAppCheck(ctx context.Context, accountID, contactID uuid.UUID, checkErr string) error {
	checkErr = strings.TrimSpace(checkErr)
	_, err := r.db.Exec(ctx, `
		UPDATE contacts
		SET avatar_whatsapp_checked_at=NOW(), avatar_whatsapp_check_error=NULLIF($3,''), avatar_checked_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, contactID, checkErr)
	return err
}

func (r *ContactAvatarRepository) Save(ctx context.Context, store *storage.Storage, accountID, contactID uuid.UUID, source string, jpegBytes []byte, options SaveContactAvatarOptions) (saved *ContactAvatarRecord, saveErr error) {
	if store == nil {
		return nil, fmt.Errorf("storage not configured")
	}
	if source != "manual" && source != "whatsapp" {
		return nil, fmt.Errorf("invalid avatar source")
	}
	if len(jpegBytes) == 0 {
		return nil, fmt.Errorf("avatar image is empty")
	}

	hashBytes := sha256.Sum256(jpegBytes)
	contentHash := contactAvatarHashPrefix + fmt.Sprintf("%x", hashBytes[:])
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var oldAssetID *uuid.UUID
	var oldURL *string
	if err := tx.QueryRow(ctx, `
		SELECT avatar_media_asset_id,avatar_url FROM contacts
		WHERE account_id=$1 AND id=$2 FOR UPDATE
	`, accountID, contactID).Scan(&oldAssetID, &oldURL); err != nil {
		return nil, err
	}
	if options.OnlyIfEmpty && (oldAssetID != nil || (oldURL != nil && strings.TrimSpace(*oldURL) != "")) {
		if err := tx.Commit(ctx); err != nil {
			return nil, err
		}
		return r.Get(ctx, accountID, contactID)
	}
	// The Contact and asset locks remain owned by the same transaction until
	// attachment commits. In particular, a request waiting for the Contact must
	// not keep an earlier, unlocked observation of an active shared asset.
	assetID, _, uploadedKey, restored, err := r.ensureAsset(ctx, tx, store, accountID, contactID, contentHash, jpegBytes)
	attached := false
	defer func() {
		if attached {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
		if uploadedKey != "" {
			// A failed attachment still has a durable, reference-checked GC path;
			// never delete an object on an ambiguous transaction commit result.
			if cleanupErr := r.trackUnattachedUpload(cleanupCtx, accountID, uploadedKey, contentHash, int64(len(jpegBytes))); cleanupErr != nil {
				saveErr = errors.Join(saveErr, fmt.Errorf("register unattached avatar cleanup: %w", cleanupErr))
			}
		} else if assetID != uuid.Nil {
			_ = r.ScheduleAssetGC(cleanupCtx, accountID, assetID)
		}
	}()
	if err != nil {
		return nil, err
	}

	// A previously broken attachment needs a new content URL even when its
	// deduplicated ID stayed the same: mounted/cached failed images must reload.
	changed := oldAssetID == nil || *oldAssetID != assetID || restored
	var revision int64
	err = tx.QueryRow(ctx, contactAvatarUpdateSQL, accountID, contactID, assetID, source, restored).Scan(&revision)
	if err != nil {
		return nil, err
	}
	avatarURL := fmt.Sprintf("/api/contact-avatars/%s/content?v=%d", contactID, revision)
	if _, err := tx.Exec(ctx, `UPDATE contacts SET avatar_url=$3 WHERE account_id=$1 AND id=$2`, accountID, contactID, avatarURL); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	attached = true

	if changed && oldAssetID != nil && *oldAssetID != assetID {
		_ = r.ScheduleAssetGC(ctx, accountID, *oldAssetID)
	}
	return r.Get(ctx, accountID, contactID)
}

// Keep the source parameter explicitly typed everywhere it is reused. PostgreSQL
// otherwise infers VARCHAR from the assignment and TEXT from the CASE comparisons,
// rejecting the statement before execution with "inconsistent types deduced".
const contactAvatarUpdateSQL = `
		UPDATE contacts
		SET avatar_media_asset_id=$3,
		    avatar_source=$4::VARCHAR(20),
		    avatar_revision=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 OR $5::BOOLEAN THEN COALESCE(avatar_revision,0)+1 ELSE COALESCE(avatar_revision,0) END,
		    avatar_updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 OR $5::BOOLEAN THEN NOW() ELSE COALESCE(avatar_updated_at,NOW()) END,
		    avatar_whatsapp_checked_at=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NOW() ELSE avatar_whatsapp_checked_at END,
		    avatar_whatsapp_check_error=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NULL ELSE avatar_whatsapp_check_error END,
		    avatar_checked_at=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NOW() ELSE avatar_checked_at END,
		    updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 OR $5::BOOLEAN THEN NOW() ELSE updated_at END
		WHERE account_id=$1 AND id=$2
		RETURNING avatar_revision
`

func (r *ContactAvatarRepository) ensureAsset(ctx context.Context, tx pgx.Tx, store *storage.Storage, accountID, contactID uuid.UUID, contentHash string, data []byte) (uuid.UUID, string, string, bool, error) {
	// Serialize new rows for this content; existing rows also stay locked while
	// the file is restored and attached. GC holds this same row during deletion.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, accountID.String()+":"+contentHash); err != nil {
		return uuid.Nil, "", "", false, err
	}
	var existingID uuid.UUID
	var existingKey, existingStatus, filename string
	err := tx.QueryRow(ctx, `
		SELECT id,object_key,status,filename FROM media_assets
		WHERE account_id=$1 AND content_hash=$2 FOR UPDATE
	`, accountID, contentHash).Scan(&existingID, &existingKey, &existingStatus, &filename)
	if err != nil && err != pgx.ErrNoRows {
		return uuid.Nil, "", "", false, err
	}
	newAsset := err == pgx.ErrNoRows
	objectKey := existingKey
	uploadedKey := ""
	if newAsset || existingStatus != "active" {
		alreadyStored := int64(0)
		if !newAsset {
			info, infoErr := store.GetFileInfo(ctx, objectKey)
			if infoErr == nil {
				alreadyStored = info.Size
			} else if code := minio.ToErrorResponse(infoErr).Code; code != "NoSuchKey" && code != "NoSuchObject" {
				return existingID, objectKey, "", false, infoErr
			}
		}
		var storageLimit int64
		if err := tx.QueryRow(ctx, `SELECT storage_limit_bytes FROM accounts WHERE id=$1`, accountID).Scan(&storageLimit); err != nil {
			return existingID, objectKey, "", false, err
		}
		if storageLimit > 0 {
			used, _, usageErr := store.UsagePrefix(ctx, accountID.String()+"/")
			if usageErr != nil {
				return existingID, objectKey, "", false, usageErr
			}
			if used-alreadyStored+int64(len(data)) > storageLimit {
				return existingID, objectKey, "", false, ErrAvatarStorageLimit
			}
		}
		if newAsset {
			filename = uuid.NewString() + ".jpg"
			objectKey = storage.PrivateObjectKey(accountID, "avatars", contactID.String(), filename)
		}
		// Reuse the existing key when restoring pending/deleted content, avoiding
		// an orphaned old inventory row on each same-photo replacement.
		if _, err := store.UploadObject(ctx, objectKey, data, "image/jpeg"); err != nil {
			return existingID, objectKey, "", false, err
		}
		// Restoring a deleted asset also writes physical bytes. If attachment
		// rolls back, its old deleted inventory must enter reference-safe GC.
		uploadedKey = objectKey
		if newAsset {
			err = tx.QueryRow(ctx, `
				INSERT INTO media_assets (account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at)
				VALUES ($1,$2,$3,'avatar','image/jpeg',$4,$5,'active',NOW()) RETURNING id
			`, accountID, contentHash, objectKey, filename, len(data)).Scan(&existingID)
		} else {
			_, err = tx.Exec(ctx, `UPDATE media_assets SET status='active',deleted_at=NULL,updated_at=NOW()
				WHERE id=$1 AND account_id=$2`, existingID, accountID)
		}
		if err != nil {
			return existingID, objectKey, uploadedKey, false, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (account_id,object_key,media_type,content_type,filename,size_bytes,source,status,updated_at)
		SELECT account_id,object_key,'avatar',content_type,filename,size_bytes,'contact_avatar','active',NOW()
		FROM media_assets WHERE id=$1 AND account_id=$2
		ON CONFLICT (account_id,object_key) DO UPDATE
		SET media_type='avatar',content_type=EXCLUDED.content_type,filename=EXCLUDED.filename,
		    size_bytes=EXCLUDED.size_bytes,source='contact_avatar',status='active',deleted_at=NULL,
		    delete_error='',next_delete_at=NULL,updated_at=NOW()
	`, existingID, accountID); err != nil {
		return existingID, objectKey, uploadedKey, false, err
	}
	return existingID, objectKey, uploadedKey, !newAsset && existingStatus != "active", nil
}

// Keep failed uploads in both inventories for the ordinary worker. A dedicated
// orphan hash cannot compete with another request creating the canonical hash.
func (r *ContactAvatarRepository) trackUnattachedUpload(ctx context.Context, accountID uuid.UUID, key, hash string, size int64) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var assetID uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM media_assets WHERE account_id=$1 AND object_key=$2 FOR UPDATE`, accountID, key).Scan(&assetID)
	if err == pgx.ErrNoRows {
		filename := key[strings.LastIndex(key, "/")+1:]
		err = tx.QueryRow(ctx, `INSERT INTO media_assets
			(account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at)
			VALUES ($1,$2,$3,'avatar','image/jpeg',$4,$5,'avatar_gc_pending',NOW()) RETURNING id`,
			accountID, hash+":orphan:"+uuid.NewString(), key, filename, size).Scan(&assetID)
	}
	if err != nil {
		return err
	}
	if err := scheduleLockedAvatarGC(ctx, tx, accountID, assetID, key); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ContactAvatarRepository) Remove(ctx context.Context, accountID, contactID uuid.UUID) (*ContactAvatarRecord, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var oldAssetID *uuid.UUID
	if err := tx.QueryRow(ctx, `
		SELECT avatar_media_asset_id FROM contacts WHERE account_id=$1 AND id=$2 FOR UPDATE
	`, accountID, contactID).Scan(&oldAssetID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE contacts
		SET avatar_media_asset_id=NULL,avatar_url=NULL,avatar_source=NULL,
		    avatar_revision=COALESCE(avatar_revision,0)+1,avatar_updated_at=NOW(),updated_at=NOW()
		WHERE account_id=$1 AND id=$2
	`, accountID, contactID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if oldAssetID != nil {
		_ = r.ScheduleAssetGC(ctx, accountID, *oldAssetID)
	}
	return r.Get(ctx, accountID, contactID)
}

// ScheduleAssetGC only transitions an object when no Contact in the same
// account references it. Lock first, then check references in a new statement
// so an attachment committed while waiting is visible in READ COMMITTED.
func (r *ContactAvatarRepository) ScheduleAssetGC(ctx context.Context, accountID, assetID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var key string
	err = tx.QueryRow(ctx, `SELECT object_key FROM media_assets
		WHERE account_id=$1 AND id=$2 AND content_hash LIKE $3 || '%'
		AND status NOT IN ('deleted','avatar_gc_deleting') FOR UPDATE`, accountID, assetID, contactAvatarHashPrefix).Scan(&key)
	if err == pgx.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if err := scheduleLockedAvatarGC(ctx, tx, accountID, assetID, key); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func scheduleLockedAvatarGC(ctx context.Context, tx pgx.Tx, accountID, assetID uuid.UUID, key string) error {
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND avatar_media_asset_id=$2)`, accountID, assetID).Scan(&referenced); err != nil {
		return err
	}
	if referenced {
		return nil
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='avatar_gc_pending',updated_at=NOW() WHERE id=$1 AND account_id=$2`, assetID, accountID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO storage_objects
		(account_id,object_key,media_type,content_type,filename,size_bytes,source,status,next_delete_at,updated_at)
		SELECT account_id,object_key,'avatar',content_type,filename,size_bytes,'contact_avatar','avatar_gc_pending',NOW(),NOW()
		FROM media_assets WHERE id=$1 AND account_id=$2 AND object_key=$3
		ON CONFLICT(account_id,object_key) DO UPDATE SET status='avatar_gc_pending',next_delete_at=NOW(),delete_error='',updated_at=NOW()`, assetID, accountID, key)
	return err
}

func (r *ContactAvatarRepository) DrainGC(ctx context.Context, store *storage.Storage, limit int) (int, error) {
	if store == nil {
		return 0, fmt.Errorf("storage not configured")
	}
	if limit <= 0 || limit > 100 {
		limit = 25
	}
	rows, err := r.db.Query(ctx, `
		SELECT ma.id,ma.account_id,ma.object_key
		FROM media_assets ma
		JOIN storage_objects so ON so.account_id=ma.account_id AND so.object_key=ma.object_key
		WHERE ma.status='avatar_gc_pending' AND so.status='avatar_gc_pending'
		  AND COALESCE(so.next_delete_at,so.updated_at)<=NOW()
		ORDER BY so.updated_at,ma.id LIMIT $1
	`, limit)
	if err != nil {
		return 0, err
	}
	type item struct {
		id, accountID uuid.UUID
		key           string
	}
	items := make([]item, 0, limit)
	for rows.Next() {
		var value item
		if err := rows.Scan(&value.id, &value.accountID, &value.key); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, value)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	deleted := 0
	for _, value := range items {
		removed, err := r.deleteUnreferencedAvatar(ctx, store, value.accountID, value.id, value.key)
		if err != nil {
			return deleted, err
		}
		if removed {
			deleted++
		}
	}
	return deleted, nil
}

func (r *ContactAvatarRepository) deleteUnreferencedAvatar(ctx context.Context, store *storage.Storage, accountID, assetID uuid.UUID, key string) (bool, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err := tx.QueryRow(ctx, `SELECT status FROM media_assets WHERE id=$1 AND account_id=$2 AND object_key=$3 FOR UPDATE`, assetID, accountID, key).Scan(&status); err != nil {
		if err == pgx.ErrNoRows {
			return false, nil
		}
		return false, err
	}
	if status != "avatar_gc_pending" {
		return false, nil
	}
	var referenced bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM contacts WHERE account_id=$1 AND avatar_media_asset_id=$2)`, accountID, assetID).Scan(&referenced); err != nil {
		return false, err
	}
	if referenced {
		return false, nil
	}
	// Do not release the asset lock between this reference check and S3 deletion:
	// a concurrent Save cannot attach it until deletion and inventory commit.
	if err := store.DeleteFile(ctx, key); err != nil {
		if _, dbErr := tx.Exec(ctx, `UPDATE storage_objects SET delete_attempts=delete_attempts+1,
			delete_error=$3,next_delete_at=NOW()+INTERVAL '15 minutes',updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2`, accountID, key, err.Error()); dbErr != nil {
			return false, dbErr
		}
		return false, tx.Commit(ctx)
	}
	if _, err := tx.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW() WHERE id=$1 AND account_id=$2`, assetID, accountID); err != nil {
		return false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),delete_error='',next_delete_at=NULL,updated_at=NOW()
		WHERE account_id=$1 AND object_key=$2`, accountID, key); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}
