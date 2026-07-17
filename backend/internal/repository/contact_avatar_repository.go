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

func (r *ContactAvatarRepository) Save(ctx context.Context, store *storage.Storage, accountID, contactID uuid.UUID, source string, jpegBytes []byte, options SaveContactAvatarOptions) (*ContactAvatarRecord, error) {
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
	assetID, objectKey, uploadedKey, err := r.ensureAsset(ctx, store, accountID, contactID, contentHash, jpegBytes)
	if err != nil {
		return nil, err
	}
	if uploadedKey != "" && uploadedKey != objectKey {
		_ = store.DeleteFile(ctx, uploadedKey)
	}
	assetAttached := false
	defer func() {
		if assetAttached {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = r.ScheduleAssetGC(cleanupCtx, accountID, assetID)
	}()

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

	changed := oldAssetID == nil || *oldAssetID != assetID
	var revision int64
	err = tx.QueryRow(ctx, contactAvatarUpdateSQL, accountID, contactID, assetID, source).Scan(&revision)
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
	assetAttached = true

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
		    avatar_revision=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 THEN COALESCE(avatar_revision,0)+1 ELSE COALESCE(avatar_revision,0) END,
		    avatar_updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 THEN NOW() ELSE COALESCE(avatar_updated_at,NOW()) END,
		    avatar_whatsapp_checked_at=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NOW() ELSE avatar_whatsapp_checked_at END,
		    avatar_whatsapp_check_error=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NULL ELSE avatar_whatsapp_check_error END,
		    avatar_checked_at=CASE WHEN $4::VARCHAR(20)='whatsapp' THEN NOW() ELSE avatar_checked_at END,
		    updated_at=CASE WHEN avatar_media_asset_id IS DISTINCT FROM $3 THEN NOW() ELSE updated_at END
		WHERE account_id=$1 AND id=$2
		RETURNING avatar_revision
`

func (r *ContactAvatarRepository) ensureAsset(ctx context.Context, store *storage.Storage, accountID, contactID uuid.UUID, contentHash string, data []byte) (uuid.UUID, string, string, error) {
	var existingID uuid.UUID
	var existingKey string
	err := r.db.QueryRow(ctx, `
		SELECT id,object_key FROM media_assets
		WHERE account_id=$1 AND content_hash=$2 AND status='active'
	`, accountID, contentHash).Scan(&existingID, &existingKey)
	if err == nil {
		return existingID, existingKey, "", nil
	}
	if err != pgx.ErrNoRows {
		return uuid.Nil, "", "", err
	}

	var storageLimit int64
	if err := r.db.QueryRow(ctx, `SELECT storage_limit_bytes FROM accounts WHERE id=$1`, accountID).Scan(&storageLimit); err != nil {
		return uuid.Nil, "", "", err
	}
	if storageLimit > 0 {
		used, _, usageErr := store.UsagePrefix(ctx, accountID.String()+"/")
		if usageErr != nil {
			return uuid.Nil, "", "", usageErr
		}
		if used+int64(len(data)) > storageLimit {
			return uuid.Nil, "", "", ErrAvatarStorageLimit
		}
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, "", "", err
	}
	defer tx.Rollback(ctx)
	// Serialize the short upload window by account and content. Without this
	// lock, two requests could upload the same hash and leave a loser object.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, accountID.String()+":"+contentHash); err != nil {
		return uuid.Nil, "", "", err
	}
	if err := tx.QueryRow(ctx, `SELECT id,object_key FROM media_assets
		WHERE account_id=$1 AND content_hash=$2 AND status='active'`, accountID, contentHash).Scan(&existingID, &existingKey); err == nil {
		if err := tx.Commit(ctx); err != nil {
			return uuid.Nil, "", "", err
		}
		return existingID, existingKey, "", nil
	} else if err != pgx.ErrNoRows {
		return uuid.Nil, "", "", err
	}

	filename := uuid.NewString() + ".jpg"
	uploadedKey := storage.PrivateObjectKey(accountID, "avatars", contactID.String(), filename)
	if _, err := store.UploadObject(ctx, uploadedKey, data, "image/jpeg"); err != nil {
		return uuid.Nil, "", "", err
	}

	var assetID uuid.UUID
	var canonicalKey string
	err = tx.QueryRow(ctx, `
		INSERT INTO media_assets (account_id,content_hash,object_key,media_type,content_type,filename,size_bytes,status,updated_at)
		VALUES ($1,$2,$3,'avatar','image/jpeg',$4,$5,'active',NOW())
		ON CONFLICT (account_id,content_hash) DO UPDATE
		SET object_key=CASE WHEN media_assets.status='active' THEN media_assets.object_key ELSE EXCLUDED.object_key END,
		    media_type='avatar',content_type='image/jpeg',
		    filename=CASE WHEN media_assets.status='active' THEN media_assets.filename ELSE EXCLUDED.filename END,
		    size_bytes=CASE WHEN media_assets.status='active' THEN media_assets.size_bytes ELSE EXCLUDED.size_bytes END,
		    status='active',deleted_at=NULL,updated_at=NOW()
		RETURNING id,object_key
	`, accountID, contentHash, uploadedKey, filename, len(data)).Scan(&assetID, &canonicalKey)
	if err != nil {
		_ = store.DeleteFile(ctx, uploadedKey)
		return uuid.Nil, "", "", err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO storage_objects (account_id,object_key,media_type,content_type,filename,size_bytes,source,status,updated_at)
		SELECT account_id,object_key,'avatar',content_type,filename,size_bytes,'contact_avatar','active',NOW()
		FROM media_assets WHERE id=$1 AND account_id=$2
		ON CONFLICT (account_id,object_key) DO UPDATE
		SET media_type='avatar',content_type=EXCLUDED.content_type,filename=EXCLUDED.filename,
		    size_bytes=EXCLUDED.size_bytes,source='contact_avatar',status='active',deleted_at=NULL,
		    delete_error='',next_delete_at=NULL,updated_at=NOW()
	`, assetID, accountID); err != nil {
		_ = store.DeleteFile(ctx, uploadedKey)
		return uuid.Nil, "", "", err
	}
	if err := tx.Commit(ctx); err != nil {
		_ = store.DeleteFile(ctx, uploadedKey)
		return uuid.Nil, "", "", err
	}
	return assetID, canonicalKey, uploadedKey, nil
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
// account references it. The worker repeats the check immediately before the
// physical delete, making replacement and deduplication race-safe.
func (r *ContactAvatarRepository) ScheduleAssetGC(ctx context.Context, accountID, assetID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		WITH candidate AS (
			SELECT ma.id,ma.object_key FROM media_assets ma
			WHERE ma.account_id=$1 AND ma.id=$2
			  AND ma.content_hash LIKE $3 || '%'
			  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id=$1 AND c.avatar_media_asset_id=ma.id)
		)
		UPDATE media_assets ma SET status='avatar_gc_pending',updated_at=NOW()
		FROM candidate c WHERE ma.id=c.id
	`, accountID, assetID, contactAvatarHashPrefix)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
		UPDATE storage_objects so
		SET status='avatar_gc_pending',next_delete_at=NOW(),delete_error='',updated_at=NOW()
		WHERE so.account_id=$1 AND EXISTS (
			SELECT 1 FROM media_assets ma WHERE ma.id=$2 AND ma.account_id=$1
			  AND ma.object_key=so.object_key AND ma.status='avatar_gc_pending'
		)
	`, accountID, assetID)
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

	deleted := 0
	for _, value := range items {
		var claimed bool
		err := r.db.QueryRow(ctx, `
			WITH claimed AS (
				UPDATE media_assets ma SET status='avatar_gc_deleting',updated_at=NOW()
				WHERE ma.id=$1 AND ma.account_id=$2 AND ma.status='avatar_gc_pending'
				  AND ma.object_key=$3
				  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.account_id=$2 AND c.avatar_media_asset_id=ma.id)
				RETURNING ma.id
			)
			UPDATE storage_objects so SET status='avatar_gc_deleting',updated_at=NOW()
			WHERE so.account_id=$2 AND so.object_key=$3 AND so.status='avatar_gc_pending'
			  AND EXISTS (SELECT 1 FROM claimed)
			RETURNING TRUE
		`, value.id, value.accountID, value.key).Scan(&claimed)
		if err == pgx.ErrNoRows {
			continue
		}
		if err != nil {
			return deleted, err
		}
		if !claimed {
			continue
		}
		if err := store.DeleteFile(ctx, value.key); err != nil {
			_, _ = r.db.Exec(ctx, `UPDATE media_assets SET status='avatar_gc_pending',updated_at=NOW()
				WHERE id=$1 AND account_id=$2 AND status='avatar_gc_deleting'`, value.id, value.accountID)
			_, _ = r.db.Exec(ctx, `UPDATE storage_objects SET status='avatar_gc_pending',delete_attempts=delete_attempts+1,
				delete_error=$3,next_delete_at=NOW()+INTERVAL '15 minutes',updated_at=NOW()
				WHERE account_id=$1 AND object_key=$2 AND status='avatar_gc_deleting'`, value.accountID, value.key, err.Error())
			continue
		}
		_, err = r.db.Exec(ctx, `UPDATE media_assets SET status='deleted',deleted_at=NOW(),updated_at=NOW()
			WHERE id=$1 AND account_id=$2 AND status='avatar_gc_deleting'`, value.id, value.accountID)
		if err != nil {
			return deleted, err
		}
		if _, err = r.db.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),delete_error='',next_delete_at=NULL,updated_at=NOW()
			WHERE account_id=$1 AND object_key=$2 AND status='avatar_gc_deleting'`, value.accountID, value.key); err != nil {
			return deleted, err
		}
		deleted++
	}
	return deleted, nil
}
