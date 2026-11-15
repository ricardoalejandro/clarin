package utilities

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/storage"
)

type ObjectStorage interface {
	UploadObject(context.Context, string, []byte, string) (string, error)
	GetFileLimited(context.Context, string, int64) ([]byte, error)
	DeleteFile(context.Context, string) error
}
type Service struct {
	Store          *Store
	Objects        ObjectStorage
	Cipher         *Cipher
	ReferenceCheck func(context.Context, pgx.Tx, uuid.UUID, string) (bool, error)
}
type ContentResult struct {
	Document domain.UtilityDocument `json:"document"`
	Content  domain.UtilityContent  `json:"content"`
}
type ChangeInput struct {
	Slot        string    `json:"slot"`
	BaseVersion int64     `json:"base_version"`
	OperationID uuid.UUID `json:"operation_id"`
	Edits       []Edit    `json:"edits"`
}

func (s *Service) content(ctx context.Context, account, owner, id uuid.UUID, slot string) (domain.UtilityContent, error) {
	var c domain.UtilityContent
	c.Slot = slot
	err := s.Store.DB.QueryRow(ctx, `SELECT version,snapshot_version,object_key,bytes,content_type,indexed_version<version FROM utility_content WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot).Scan(&c.Version, &c.SnapshotVersion, &c.ObjectKey, &c.Bytes, &c.ContentType, &c.Indexing)
	return c, missing(err)
}
func (s *Service) load(ctx context.Context, account, owner, id uuid.UUID, c domain.UtilityContent) ([]byte, error) {
	if s.Objects == nil {
		return nil, ErrVaultUnavailable
	}
	data, err := s.Objects.GetFileLimited(ctx, c.ObjectKey, DocumentLimit+1024)
	if err != nil {
		return nil, err
	}
	if c.SnapshotVersion == c.Version {
		return data, nil
	}
	rows, err := s.Store.DB.Query(ctx, `SELECT version,edits FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4 AND version>$5 AND version<=$6 ORDER BY version`, account, owner, id, c.Slot, c.SnapshotVersion, c.Version)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	text := string(data)
	version := c.SnapshotVersion
	for rows.Next() {
		var revision int64
		var raw []byte
		if err = rows.Scan(&revision, &raw); err != nil {
			return nil, err
		}
		if revision != version+1 {
			return nil, ErrConflict
		}
		var edits []Edit
		if json.Unmarshal(raw, &edits) != nil {
			return nil, ErrInvalid
		}
		text, err = ApplyEdits(text, edits)
		if err != nil {
			return nil, err
		}
		version = revision
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if version != c.Version {
		return nil, ErrConflict
	}
	return []byte(text), nil
}
func (s *Service) ReadContent(ctx context.Context, account, owner, id uuid.UUID, slot string) ([]byte, domain.UtilityContent, error) {
	if !validSlot(slot) {
		return nil, domain.UtilityContent{}, ErrInvalid
	}
	c, err := s.content(ctx, account, owner, id, slot)
	if err != nil {
		return nil, c, err
	}
	data, err := s.load(ctx, account, owner, id, c)
	return data, c, err
}

// prepareObject commits a cleanup candidate BEFORE upload, so an interrupted
// upload or failed attachment always has a durable reclamation path.
func (s *Service) prepareObject(ctx context.Context, account, owner, resource uuid.UUID, bytes int, contentType, kind string) (string, error) {
	key := storage.PrivateObjectKey(account, "utilities", owner.String(), resource.String(), uuid.NewString())
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	// A concurrent account removal can be queued ahead of this separate quota
	// reservation. Bound row-lock waits so no parent transaction can wait on its
	// own child indefinitely while the removal waits for the parent's FK locks.
	if _, err = tx.Exec(ctx, `SET LOCAL lock_timeout='5s'`); err != nil {
		return "", err
	}
	var limit int64
	// Quota reservations must serialize without blocking KEY SHARE locks held
	// by a parent transaction's new document/key foreign keys. FOR UPDATE here
	// deadlocks a document clone waiting on its own upload reservation.
	if err = tx.QueryRow(ctx, `SELECT storage_limit_bytes FROM accounts WHERE id=$1 FOR NO KEY UPDATE`, account).Scan(&limit); err != nil {
		return "", missing(err)
	}
	if limit > 0 {
		var used int64
		if err = tx.QueryRow(ctx, `SELECT COALESCE(sum(size_bytes),0) FROM storage_objects WHERE account_id=$1 AND deleted_at IS NULL AND status<>'deleted'`, account).Scan(&used); err != nil {
			return "", err
		}
		if used+int64(bytes) > limit {
			return "", ErrQuota
		}
	}
	_, err = tx.Exec(ctx, `INSERT INTO storage_objects(account_id,object_key,media_type,content_type,size_bytes,source,status) VALUES($1,$2,$3,$4,$5,'utilities','utility_uploading')`, account, key, kind, contentType, bytes)
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `INSERT INTO utility_objects(account_id,owner_id,object_key,resource_id,bytes) VALUES($1,$2,$3,$4,$5)`, account, owner, key, resource, bytes)
	if err != nil {
		return "", err
	}
	return key, tx.Commit(ctx)
}
func activateObject(ctx context.Context, tx pgx.Tx, account uuid.UUID, key string) error {
	_, err := tx.Exec(ctx, `UPDATE utility_objects SET state='active' WHERE account_id=$1 AND object_key=$2`, account, key)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE storage_objects SET status='active',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, account, key)
	return err
}
func scheduleObject(ctx context.Context, tx pgx.Tx, account uuid.UUID, key string, immediate bool) error {
	if key == "" {
		return nil
	}
	delay := "5 minutes"
	if immediate {
		delay = "0 seconds"
	}
	_, err := tx.Exec(ctx, `UPDATE utility_objects SET state='gc',available_at=NOW()+$3::interval WHERE account_id=$1 AND object_key=$2`, account, key, delay)
	return err
}
func (s *Service) upload(ctx context.Context, account, owner, resource uuid.UUID, data []byte, contentType, kind string) (string, error) {
	if s.Objects == nil {
		return "", ErrVaultUnavailable
	}
	key, err := s.prepareObject(ctx, account, owner, resource, len(data), contentType, kind)
	if err != nil {
		return "", err
	}
	_, err = s.Objects.UploadObject(ctx, key, data, contentType)
	return key, err
}

func (s *Service) WriteContent(ctx context.Context, account, owner, id uuid.UUID, slot, contentType string, version int64, op uuid.UUID, data []byte) (ContentResult, error) {
	var result ContentResult
	if !validSlot(slot) || len(data) > DocumentLimit || version < 0 || op == uuid.Nil {
		return result, ErrInvalid
	}
	if contentType == "" {
		contentType = "text/plain;charset=utf-8"
	}
	// Original imports preserve their exact bytes, BOM and declared encoding.
	// Only the editable panels participate in UTF-8 validation and search.
	if strings.HasPrefix(slot, "original-") {
		contentType = "application/octet-stream"
	}
	if len(contentType) > 100 || strings.ContainsAny(contentType, "\r\n") {
		return result, ErrInvalid
	}
	d, err := s.Store.Get(ctx, account, owner, id)
	if err != nil {
		return result, err
	}
	if d.Type == "criptografia" {
		return result, ErrInvalid
	}
	if (d.Type == "qr" || d.Type == "imagen-base64") && strings.HasPrefix(contentType, "image/") && len(data) > 10*1024*1024 {
		return result, ErrInvalid
	}
	text := strings.HasPrefix(contentType, "text/") || contentType == "application/json" || contentType == "application/xml"
	if text && (!utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0) {
		return result, ErrInvalid
	}
	hash := sha256.Sum256(data)
	value := []any{slot, version, contentType, hex.EncodeToString(hash[:])}
	// Check duplicate before uploading a second 60 MiB object.
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.Store.operation(ctx, tx, account, owner, op, id, value)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	var lockedDocument uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, id).Scan(&lockedDocument); err != nil {
		return result, missing(err)
	}
	var current int64
	var old string
	err = tx.QueryRow(ctx, `SELECT version,object_key FROM utility_content WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4 FOR UPDATE`, account, owner, id, slot).Scan(&current, &old)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	if current != version {
		return result, ErrConflict
	}
	// prepareObject uses its own transaction; no account lock is held here.
	key, err := s.upload(ctx, account, owner, id, data, contentType, "document")
	if err != nil {
		return result, err
	}
	err = tx.QueryRow(ctx, `INSERT INTO utility_content(account_id,owner_id,document_id,slot,version,snapshot_version,object_key,bytes,content_type)
	 VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8) ON CONFLICT(account_id,owner_id,document_id,slot)
	 DO UPDATE SET version=EXCLUDED.version,snapshot_version=EXCLUDED.snapshot_version,object_key=EXCLUDED.object_key,bytes=EXCLUDED.bytes,content_type=EXCLUDED.content_type
	 RETURNING slot,version,bytes,content_type`, account, owner, id, slot, current+1, key, len(data), contentType).Scan(&result.Content.Slot, &result.Content.Version, &result.Content.Bytes, &result.Content.ContentType)
	if err != nil {
		return result, err
	}
	result.Content.Indexing = text
	if _, err = tx.Exec(ctx, `DELETE FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
		return result, err
	}
	if err = activateObject(ctx, tx, account, key); err != nil {
		return result, err
	}
	if err = scheduleObject(ctx, tx, account, old, false); err != nil {
		return result, err
	}
	if text {
		if _, err = tx.Exec(ctx, `INSERT INTO utility_content_jobs(account_id,owner_id,document_id,slot) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, account, owner, id, slot); err != nil {
			return result, err
		}
	} else {
		if _, err = tx.Exec(ctx, `UPDATE utility_content SET indexed_version=version WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
			return result, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM utility_content_jobs WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
			return result, err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_search_chunks WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
		return result, err
	}
	result.Document, err = scanDocument(tx.QueryRow(ctx, `UPDATE utility_documents SET updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 RETURNING `+docColumns, account, owner, id))
	if err != nil {
		return result, err
	}
	if err = fillDocumentSlots(ctx, tx, account, owner, &result.Document); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, op, id, value, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) Changes(ctx context.Context, account, owner, id uuid.UUID, in ChangeInput) (ContentResult, error) {
	var result ContentResult
	if !validSlot(in.Slot) || in.BaseVersion < 1 || len(in.Edits) == 0 || len(in.Edits) > 10000 {
		return result, ErrInvalid
	}
	encoded, err := json.Marshal(in.Edits)
	if err != nil || len(encoded) > 8*1024*1024 {
		return result, ErrInvalid
	}
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return result, err
	}
	defer tx.Rollback(ctx)
	previous, err := s.Store.operation(ctx, tx, account, owner, in.OperationID, id, in)
	if err != nil {
		return result, err
	}
	if previous != nil {
		err = json.Unmarshal(previous, &result)
		return result, err
	}
	var kind string
	if err = tx.QueryRow(ctx, `SELECT type FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE`, account, owner, id).Scan(&kind); err != nil {
		return result, missing(err)
	}
	if kind == "criptografia" {
		return result, ErrInvalid
	}
	c, err := s.content(ctx, account, owner, id, in.Slot)
	if err != nil {
		return result, err
	}
	if c.Version != in.BaseVersion {
		return result, ErrConflict
	}
	if !strings.HasPrefix(c.ContentType, "text/") && c.ContentType != "application/json" && c.ContentType != "application/xml" {
		return result, ErrInvalid
	}
	source, err := s.load(ctx, account, owner, id, c)
	if err != nil {
		return result, err
	}
	updated, err := ApplyEdits(string(source), in.Edits)
	if err != nil {
		return result, err
	}
	c.Version++
	c.Bytes = int64(len(updated))
	c.Indexing = true
	result.Content = c
	_, err = tx.Exec(ctx, `INSERT INTO utility_changes(account_id,owner_id,document_id,slot,version,edits) VALUES($1,$2,$3,$4,$5,$6)`, account, owner, id, in.Slot, c.Version, encoded)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE utility_content SET version=$5,bytes=$6 WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, in.Slot, c.Version, c.Bytes)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO utility_content_jobs(account_id,owner_id,document_id,slot,available_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '30 seconds') ON CONFLICT DO NOTHING`, account, owner, id, in.Slot)
	if err != nil {
		return result, err
	}
	_, err = tx.Exec(ctx, `UPDATE utility_content_jobs SET available_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4 AND (SELECT COALESCE(sum(octet_length(edits::text)),0) FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4)>=8388608`, account, owner, id, in.Slot)
	if err != nil {
		return result, err
	}
	result.Document, err = scanDocument(tx.QueryRow(ctx, `UPDATE utility_documents SET updated_at=NOW() WHERE account_id=$1 AND owner_id=$2 AND id=$3 RETURNING `+docColumns, account, owner, id))
	if err != nil {
		return result, err
	}
	if err = fillDocumentSlots(ctx, tx, account, owner, &result.Document); err != nil {
		return result, err
	}
	if err = recordOperation(ctx, tx, account, owner, in.OperationID, id, in, result); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}

// RunWorkers is deliberately bounded: one object deletion or content checkpoint
// per pass, with PostgreSQL locks coordinating multiple backend instances.
func (s *Service) RunWorkers(ctx context.Context) {
	if s.Store == nil || s.Store.DB == nil || s.Objects == nil {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	var nextContent, nextGC, nextRotation time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			workCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
			if time.Now().After(nextContent) {
				if err := s.processContentJob(workCtx); err != nil {
					log.Printf("[UtilitiesWorker] job=checkpoint code=%s", workerErrorCode(err))
					nextContent = time.Now().Add(10 * time.Second)
				}
			}
			if time.Now().After(nextGC) {
				if err := s.processGC(workCtx); err != nil {
					log.Printf("[UtilitiesWorker] job=cleanup code=%s", workerErrorCode(err))
					nextGC = time.Now().Add(30 * time.Second)
				}
			}
			if time.Now().After(nextRotation) {
				if err := s.rotateVaultKeys(workCtx); err != nil {
					log.Printf("[UtilitiesWorker] job=key_rotation code=%s", workerErrorCode(err))
					nextRotation = time.Now().Add(30 * time.Second)
				}
			}
			_, _ = s.Store.DB.Exec(workCtx, `DELETE FROM utility_operations WHERE created_at<NOW()-INTERVAL '7 days'`)
			cancel()
		}
	}
}
func (s *Service) processContentJob(ctx context.Context) (runErr error) {
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	var account, owner, id uuid.UUID
	var slot string
	defer func() {
		_ = tx.Rollback(ctx)
		if runErr != nil && id != uuid.Nil {
			retryCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _ = s.Store.DB.Exec(retryCtx, `UPDATE utility_content_jobs SET attempts=attempts+1,last_error=$5,available_at=NOW()+INTERVAL '10 seconds' * least(60,attempts+1) WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot, workerErrorCode(runErr))
		}
	}()
	err = tx.QueryRow(ctx, `SELECT account_id,owner_id,document_id,slot FROM utility_content_jobs WHERE available_at<=NOW() ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&account, &owner, &id, &slot)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Canonical lock order matches writes and deletion. A failed try avoids a
	// job-lock/document-lock inversion with the transaction scheduling a job.
	var locked bool
	if err = tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))`, id.String()+slot).Scan(&locked); err != nil || !locked {
		return err
	}
	var found uuid.UUID
	err = tx.QueryRow(ctx, `SELECT id FROM utility_documents WHERE account_id=$1 AND owner_id=$2 AND id=$3 FOR UPDATE NOWAIT`, account, owner, id).Scan(&found)
	if err != nil {
		return err
	}
	c, err := s.content(ctx, account, owner, id, slot)
	if err != nil {
		return err
	}
	data, err := s.load(ctx, account, owner, id, c)
	if err != nil {
		return err
	}
	if c.SnapshotVersion < c.Version {
		key, err := s.upload(ctx, account, owner, id, data, c.ContentType, "document")
		if err != nil {
			return err
		}
		if err = activateObject(ctx, tx, account, key); err != nil {
			return err
		}
		if err = scheduleObject(ctx, tx, account, c.ObjectKey, false); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE utility_content SET object_key=$5,snapshot_version=version WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot, key)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `DELETE FROM utility_changes WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4 AND version<=$5`, account, owner, id, slot, c.Version)
		if err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_search_chunks WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
		return err
	}
	chunks := SearchChunks(string(data))
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"utility_search_chunks"}, []string{"account_id", "owner_id", "document_id", "slot", "version", "position", "body"}, pgx.CopyFromSlice(len(chunks), func(position int) ([]any, error) {
		return []any{account, owner, id, slot, c.Version, position, chunks[position]}, nil
	}))
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE utility_content SET indexed_version=version WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_content_jobs WHERE account_id=$1 AND owner_id=$2 AND document_id=$3 AND slot=$4`, account, owner, id, slot); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Service) processGC(ctx context.Context) error {
	tx, err := s.Store.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Lock a candidate only after its account reference barrier. This keeps
	// reference-writer lock ordering consistent and makes the physical proof
	// stable until the delete and ledger acknowledgement both complete.
	var candidateAccount uuid.UUID
	err = tx.QueryRow(ctx, `SELECT account_id FROM utility_objects WHERE state IN ('gc','uploading') AND available_at<=NOW() ORDER BY available_at LIMIT 1`).Scan(&candidateAccount)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('storage-self-service:'||$1::text,0))`, candidateAccount.String()); err != nil {
		return err
	}
	var account uuid.UUID
	var key string
	err = tx.QueryRow(ctx, `SELECT account_id,object_key FROM utility_objects WHERE account_id=$1 AND state IN ('gc','uploading') AND available_at<=NOW() ORDER BY available_at LIMIT 1 FOR UPDATE SKIP LOCKED`, candidateAccount).Scan(&account, &key)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if !storage.IsUtilityObjectKey(key) || !strings.HasPrefix(key, account.String()+"/_private/utilities/") {
		return ErrInvalid
	}
	var referenced bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM utility_content WHERE account_id=$1 AND object_key=$2) OR EXISTS(SELECT 1 FROM utility_vault WHERE account_id=$1 AND object_key=$2)`, account, key).Scan(&referenced); err != nil {
		return err
	}
	if referenced {
		_, err = tx.Exec(ctx, `UPDATE utility_objects SET state='active' WHERE account_id=$1 AND object_key=$2`, account, key)
		if err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if s.ReferenceCheck != nil {
		if _, err = tx.Exec(ctx, `UPDATE utility_objects SET state='gc' WHERE account_id=$1 AND object_key=$2`, account, key); err != nil {
			return err
		}
		external, e := s.ReferenceCheck(ctx, tx, account, key)
		if e != nil {
			return e
		}
		if external {
			_, err = tx.Exec(ctx, `UPDATE utility_objects SET available_at=NOW()+INTERVAL '1 hour' WHERE account_id=$1 AND object_key=$2`, account, key)
			if err != nil {
				return err
			}
			return tx.Commit(ctx)
		}
	}
	if err = s.Objects.DeleteFile(ctx, key); err != nil {
		_, e := tx.Exec(ctx, `UPDATE utility_objects SET attempts=attempts+1,last_error='object_delete_failed',available_at=NOW()+INTERVAL '1 minute' * least(60,attempts+1) WHERE account_id=$1 AND object_key=$2`, account, key)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(ctx, `UPDATE storage_objects SET delete_attempts=delete_attempts+1,delete_error='utility_gc_retry',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, account, key); e != nil {
			return e
		}
		return tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM utility_objects WHERE account_id=$1 AND object_key=$2`, account, key); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE storage_objects SET status='deleted',deleted_at=NOW(),size_bytes=0,delete_error='',updated_at=NOW() WHERE account_id=$1 AND object_key=$2`, account, key)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Service) String() string {
	return fmt.Sprintf("UtilitiesService(configured=%t)", s.Cipher != nil)
}

func workerErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrQuota):
		return "storage_quota_exceeded"
	case errors.Is(err, ErrVaultUnavailable):
		return "vault_unavailable"
	case errors.Is(err, ErrConflict):
		return "source_changed"
	case errors.Is(err, ErrInvalid):
		return "invalid_content"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "cancelled"
	default:
		return "unavailable"
	}
}
