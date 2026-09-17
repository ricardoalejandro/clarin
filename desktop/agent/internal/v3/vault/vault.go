package vault

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

var (
	ErrOperationIDReuse = errors.New("operation_id_reuse")
	ErrEnvelopeIDReuse  = errors.New("envelope_id_reuse")
	ErrOutboxFull       = errors.New("outbox_full")
	ErrQuotaExceeded    = errors.New("quota_exceeded")
	ErrGrantMismatch    = errors.New("grant_tuple_mismatch")
)

type Store struct {
	db    *sql.DB
	path  string
	tuple model.Tuple
	quota int64
}

type Resource struct {
	SelectionID  string          `json:"selection_id"`
	Module       string          `json:"module"`
	ResourceType string          `json:"resource_type"`
	ResourceID   string          `json:"resource_id"`
	Revision     int64           `json:"revision"`
	Payload      json.RawMessage `json:"payload"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

type PendingEnvelope struct {
	OperationID string    `json:"operation_id"`
	Sequence    int64     `json:"sequence"`
	Envelope    string    `json:"envelope"`
	ContentHash string    `json:"content_hash"`
	Attempts    int       `json:"attempts"`
	CreatedAt   time.Time `json:"created_at"`
}

type InboxEnvelope struct {
	EnvelopeID  string    `json:"envelope_id"`
	Kind        string    `json:"kind"`
	Envelope    string    `json:"envelope"`
	ContentHash string    `json:"content_hash"`
	ClaimedHash string    `json:"claimed_hash,omitempty"`
	ReceivedAt  time.Time `json:"received_at"`
}

// ConflictRecord is private grant data. ClientChange and ServerResult are
// encrypted with the grant DEK before persistence; the table never contains a
// readable task title or server rejection payload.
type ConflictRecord struct {
	OperationID  string          `json:"operation_id"`
	SelectionID  string          `json:"selection_id"`
	ResourceID   string          `json:"resource_id"`
	Status       string          `json:"status"`
	ErrorCode    string          `json:"error_code,omitempty"`
	ClientChange json.RawMessage `json:"client_change"`
	ServerResult json.RawMessage `json:"server_result,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
}

func Open(root string, tuple model.Tuple, quota int64) (*Store, error) {
	if err := tuple.Validate(); err != nil {
		return nil, err
	}
	if quota <= 0 || quota > model.MaxStorageBytes {
		return nil, ErrQuotaExceeded
	}
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("vault root is required")
	}
	dir := filepath.Join(root, "grants", tuple.GrantID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "vault-v3.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db, path: path, tuple: tuple, quota: quota}
	if err := store.initialize(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return store, nil
}

func (s *Store) initialize(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA journal_mode=WAL`,
		`PRAGMA synchronous=FULL`,
		`PRAGMA foreign_keys=ON`,
		`PRAGMA temp_store=MEMORY`,
		`PRAGMA secure_delete=ON`,
		`PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS grant_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS resources (
			selection_id TEXT NOT NULL,
			module TEXT NOT NULL,
			resource_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			revision INTEGER NOT NULL CHECK(revision >= 0),
			sealed_record BLOB NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (module, resource_type, resource_id)
		)`,
		`CREATE INDEX IF NOT EXISTS resources_page_idx ON resources(module, resource_id)`,
		`CREATE TABLE IF NOT EXISTS sealed_inbox (
			envelope_id TEXT PRIMARY KEY,
			kind TEXT NOT NULL CHECK(kind IN ('snapshot','receipt','control')),
			sealed_jwe TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			claimed_hash TEXT NOT NULL DEFAULT '',
			received_at INTEGER NOT NULL,
			processed_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS sealed_inbox_pending_idx ON sealed_inbox(processed_at, received_at)`,
		`CREATE TABLE IF NOT EXISTS outbox (
			operation_id TEXT PRIMARY KEY,
			sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0),
			sealed_jwe TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			intent_hash TEXT NOT NULL DEFAULT '',
			attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
			next_attempt_at INTEGER,
			created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS outbox_send_idx ON outbox(next_attempt_at, sequence)`,
		`CREATE TABLE IF NOT EXISTS receipts (
			operation_id TEXT PRIMARY KEY,
			sealed_jwe TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			request_hash TEXT NOT NULL DEFAULT '',
			intent_hash TEXT NOT NULL DEFAULT '',
			received_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS conflicts (
			operation_id TEXT PRIMARY KEY,
			selection_id TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			status TEXT NOT NULL CHECK(status IN ('conflict','rejected')),
			sealed_record BLOB NOT NULL,
			created_at INTEGER NOT NULL,
			resolved_at INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS conflicts_open_idx ON conflicts(resolved_at,created_at,operation_id)`,
	} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize encrypted grant vault: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE sealed_inbox ADD COLUMN claimed_hash TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate sealed inbox claimed hash: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE receipts ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate receipts request hash: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE outbox ADD COLUMN intent_hash TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate outbox intent hash: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE receipts ADD COLUMN intent_hash TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate receipt intent hash: %w", err)
	}
	rawTuple, err := json.Marshal(s.tuple)
	if err != nil {
		return err
	}
	var existing []byte
	err = s.db.QueryRowContext(ctx, `SELECT value FROM grant_meta WHERE key='tuple'`).Scan(&existing)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		_, err = s.db.ExecContext(ctx, `INSERT INTO grant_meta(key,value) VALUES('tuple',?)`, rawTuple)
		return err
	case err != nil:
		return err
	case !equalJSON(existing, rawTuple):
		return ErrGrantMismatch
	default:
		return nil
	}
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Path() string { return s.path }

func (s *Store) Tuple() model.Tuple { return s.tuple }

func (s *Store) SaveProtectedGrantMaterial(ctx context.Context, wrappedSecrets, lease []byte) error {
	if len(wrappedSecrets) == 0 || len(wrappedSecrets) > 128<<10 || len(lease) == 0 || len(lease) > 128<<10 {
		return errors.New("protected grant material rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for key, value := range map[string][]byte{"wrapped_secrets": wrappedSecrets, "lease": lease} {
		if _, err := tx.ExecContext(ctx, `INSERT INTO grant_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value); err != nil {
			return err
		}
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(wrappedSecrets)+len(lease))); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ProtectedGrantMaterial(ctx context.Context) (wrappedSecrets, lease []byte, err error) {
	for key, target := range map[string]*[]byte{"wrapped_secrets": &wrappedSecrets, "lease": &lease} {
		if scanErr := s.db.QueryRowContext(ctx, `SELECT value FROM grant_meta WHERE key=?`, key).Scan(target); scanErr != nil {
			return nil, nil, scanErr
		}
	}
	return wrappedSecrets, lease, nil
}

func (s *Store) PutResource(ctx context.Context, dek []byte, resource Resource) error {
	if !validUUID(resource.SelectionID) {
		return errors.New("resource selection id rejected")
	}
	if err := model.ValidateLocalResource(resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision); err != nil {
		return err
	}
	if len(resource.Payload) == 0 || !json.Valid(resource.Payload) {
		return errors.New("resource payload is invalid")
	}
	sealed, err := cryptokit.SealRecord(dek, cryptokit.RecordAAD(s.tuple, resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision), resource.Payload)
	if err != nil {
		return err
	}
	now := resource.UpdatedAt.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO resources(selection_id,module,resource_type,resource_id,revision,sealed_record,updated_at)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(module,resource_type,resource_id) DO UPDATE SET
		selection_id=excluded.selection_id, revision=excluded.revision, sealed_record=excluded.sealed_record, updated_at=excluded.updated_at
		WHERE excluded.revision >= resources.revision`, resource.SelectionID, resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision, sealed, now.UnixMilli()); err != nil {
		return err
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(sealed))); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DeleteResource(ctx context.Context, module, resourceType, resourceID string) error {
	if module == "" || resourceType == "" || resourceID == "" {
		return errors.New("resource identity is required")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM resources WHERE module=? AND resource_type=? AND resource_id=?`, module, resourceType, resourceID)
	return err
}

func (s *Store) DeleteSelection(ctx context.Context, selectionID string) error {
	if !validUUID(selectionID) {
		return errors.New("selection identity rejected")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM resources WHERE selection_id=?`, selectionID)
	return err
}

func (s *Store) ListResources(ctx context.Context, dek []byte, module, afterResourceID string, limit int) ([]Resource, string, error) {
	return s.listResources(ctx, dek, module, "", afterResourceID, limit)
}

func (s *Store) ListResourcesForSelection(ctx context.Context, dek []byte, module, selectionID, afterResourceID string, limit int) ([]Resource, string, error) {
	if !validUUID(selectionID) {
		return nil, "", errors.New("resource selection rejected")
	}
	return s.listResources(ctx, dek, module, selectionID, afterResourceID, limit)
}

func (s *Store) listResources(ctx context.Context, dek []byte, module, selectionID, afterResourceID string, limit int) ([]Resource, string, error) {
	if !validModule(module) || (afterResourceID != "" && !validUUID(afterResourceID)) {
		return nil, "", errors.New("resource page scope rejected")
	}
	limit = normalizeLimit(limit)
	query := `SELECT selection_id,module,resource_type,resource_id,revision,sealed_record,updated_at
		FROM resources WHERE module=? AND resource_id>? ORDER BY resource_id LIMIT ?`
	args := []any{module, afterResourceID, limit + 1}
	if selectionID != "" {
		query = `SELECT selection_id,module,resource_type,resource_id,revision,sealed_record,updated_at
			FROM resources WHERE module=? AND selection_id=? AND resource_id>? ORDER BY resource_id LIMIT ?`
		args = []any{module, selectionID, afterResourceID, limit + 1}
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := make([]Resource, 0, limit)
	next := ""
	for rows.Next() {
		var item Resource
		var sealed []byte
		var updatedAt int64
		if err := rows.Scan(&item.SelectionID, &item.Module, &item.ResourceType, &item.ResourceID, &item.Revision, &sealed, &updatedAt); err != nil {
			return nil, "", err
		}
		if len(items) == limit {
			next = items[len(items)-1].ResourceID
			break
		}
		plain, err := cryptokit.OpenRecord(dek, cryptokit.RecordAAD(s.tuple, item.Module, item.ResourceType, item.ResourceID, item.Revision), sealed)
		if err != nil {
			return nil, "", fmt.Errorf("open resource %s: %w", item.ResourceID, err)
		}
		item.Payload = append(json.RawMessage(nil), plain...)
		for index := range plain {
			plain[index] = 0
		}
		item.UpdatedAt = time.UnixMilli(updatedAt).UTC()
		items = append(items, item)
	}
	return items, next, rows.Err()
}

func (s *Store) Resource(ctx context.Context, dek []byte, module, resourceType, resourceID string) (*Resource, error) {
	var item Resource
	var sealed []byte
	var updatedAt int64
	err := s.db.QueryRowContext(ctx, `SELECT selection_id,module,resource_type,resource_id,revision,sealed_record,updated_at FROM resources WHERE module=? AND resource_type=? AND resource_id=?`, module, resourceType, resourceID).
		Scan(&item.SelectionID, &item.Module, &item.ResourceType, &item.ResourceID, &item.Revision, &sealed, &updatedAt)
	if err != nil {
		return nil, err
	}
	plain, err := cryptokit.OpenRecord(dek, cryptokit.RecordAAD(s.tuple, item.Module, item.ResourceType, item.ResourceID, item.Revision), sealed)
	if err != nil {
		return nil, err
	}
	item.Payload = append(json.RawMessage(nil), plain...)
	for index := range plain {
		plain[index] = 0
	}
	item.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	return &item, nil
}

func (s *Store) EnqueueSealed(ctx context.Context, operationID string, sequence int64, envelope string) (bool, error) {
	if !validUUID(operationID) || sequence < 1 || len(envelope) == 0 || len(envelope) > 2<<20 {
		return false, errors.New("sealed operation rejected")
	}
	hash := sha256.Sum256([]byte(envelope))
	contentHash := hex.EncodeToString(hash[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var existingIntent string
	err = tx.QueryRowContext(ctx, `SELECT intent_hash FROM outbox WHERE operation_id=? UNION ALL SELECT intent_hash FROM receipts WHERE operation_id=? LIMIT 1`, operationID, operationID).Scan(&existingIntent)
	if err == nil {
		if existingIntent == contentHash {
			return true, tx.Commit()
		}
		return false, ErrOperationIDReuse
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM outbox`).Scan(&count); err != nil {
		return false, err
	}
	if count >= model.MaxPendingCommands {
		return false, ErrOutboxFull
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO outbox(operation_id,sequence,sealed_jwe,content_hash,intent_hash,created_at) VALUES(?,?,?,?,?,?)`, operationID, sequence, envelope, contentHash, contentHash, time.Now().UTC().UnixMilli()); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return false, ErrOperationIDReuse
		}
		return false, err
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(envelope))); err != nil {
		return false, err
	}
	return false, tx.Commit()
}

// EnqueueSealedAndPutResource makes the durable command and its optimistic
// local projection one SQLite transaction. A crash can therefore never show a
// local edit that was not also placed in the sealed outbox.
func (s *Store) EnqueueSealedAndPutResource(ctx context.Context, operationID string, sequence int64, envelope, intentHash string, dek []byte, resource Resource) (bool, error) {
	if !validUUID(operationID) || sequence < 1 || len(envelope) == 0 || len(envelope) > 2<<20 || !validSHA256Hex(intentHash) {
		return false, errors.New("sealed operation rejected")
	}
	if !validUUID(resource.SelectionID) {
		return false, errors.New("resource selection id rejected")
	}
	if err := model.ValidateLocalResource(resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision); err != nil {
		return false, err
	}
	if len(resource.Payload) == 0 || !json.Valid(resource.Payload) {
		return false, errors.New("resource payload is invalid")
	}
	sealedRecord, err := cryptokit.SealRecord(dek, cryptokit.RecordAAD(s.tuple, resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision), resource.Payload)
	if err != nil {
		return false, err
	}
	digest := sha256.Sum256([]byte(envelope))
	contentHash := hex.EncodeToString(digest[:])
	now := resource.UpdatedAt.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	duplicate, err := enqueueTx(ctx, tx, operationID, sequence, envelope, contentHash, intentHash)
	if err != nil || duplicate {
		if duplicate {
			return true, tx.Commit()
		}
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO resources(selection_id,module,resource_type,resource_id,revision,sealed_record,updated_at)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(module,resource_type,resource_id) DO UPDATE SET
		selection_id=excluded.selection_id, revision=excluded.revision, sealed_record=excluded.sealed_record, updated_at=excluded.updated_at
		WHERE excluded.revision >= resources.revision`, resource.SelectionID, resource.Module, resource.ResourceType, resource.ResourceID, resource.Revision, sealedRecord, now.UnixMilli()); err != nil {
		return false, err
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(envelope)+len(sealedRecord))); err != nil {
		return false, err
	}
	return false, tx.Commit()
}

func enqueueTx(ctx context.Context, tx *sql.Tx, operationID string, sequence int64, envelope, contentHash, intentHash string) (bool, error) {
	var existingIntent string
	err := tx.QueryRowContext(ctx, `SELECT intent_hash FROM outbox WHERE operation_id=? UNION ALL SELECT intent_hash FROM receipts WHERE operation_id=? LIMIT 1`, operationID, operationID).Scan(&existingIntent)
	if err == nil {
		if existingIntent == intentHash {
			return true, nil
		}
		return false, ErrOperationIDReuse
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM outbox`).Scan(&count); err != nil {
		return false, err
	}
	if count >= model.MaxPendingCommands {
		return false, ErrOutboxFull
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO outbox(operation_id,sequence,sealed_jwe,content_hash,intent_hash,created_at) VALUES(?,?,?,?,?,?)`, operationID, sequence, envelope, contentHash, intentHash, time.Now().UTC().UnixMilli()); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return false, ErrOperationIDReuse
		}
		return false, err
	}
	return false, nil
}

func (s *Store) PendingEnvelopes(ctx context.Context, now time.Time, limit int) ([]PendingEnvelope, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT operation_id,sequence,sealed_jwe,content_hash,attempts,created_at FROM outbox
		WHERE next_attempt_at IS NULL OR next_attempt_at<=? ORDER BY sequence LIMIT ?`, now.UTC().UnixMilli(), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]PendingEnvelope, 0, limit)
	for rows.Next() {
		var item PendingEnvelope
		var createdAt int64
		if err := rows.Scan(&item.OperationID, &item.Sequence, &item.Envelope, &item.ContentHash, &item.Attempts, &createdAt); err != nil {
			return nil, err
		}
		item.CreatedAt = time.UnixMilli(createdAt).UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) MarkAttempt(ctx context.Context, operationIDs []string, nextAttempt time.Time) error {
	if len(operationIDs) == 0 || len(operationIDs) > 100 {
		return errors.New("attempt batch rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, operationID := range operationIDs {
		if !validUUID(operationID) {
			return errors.New("attempt operation id rejected")
		}
		if _, err := tx.ExecContext(ctx, `UPDATE outbox SET attempts=attempts+1,next_attempt_at=? WHERE operation_id=?`, nextAttempt.UTC().UnixMilli(), operationID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) StoreInbox(ctx context.Context, item InboxEnvelope) (bool, error) {
	if !validEnvelopeID(item.EnvelopeID, item.Kind) || (item.Kind != "snapshot" && item.Kind != "receipt" && item.Kind != "control") || len(item.Envelope) == 0 || len(item.Envelope) > 32<<20 || (item.ClaimedHash != "" && !validSHA256Hex(item.ClaimedHash)) {
		return false, errors.New("sealed inbox envelope rejected")
	}
	digest := sha256.Sum256([]byte(item.Envelope))
	hash := hex.EncodeToString(digest[:])
	if item.ContentHash != "" && item.ContentHash != hash {
		return false, errors.New("sealed inbox hash rejected")
	}
	if item.ReceivedAt.IsZero() {
		item.ReceivedAt = time.Now().UTC()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	var existingHash, existingClaimedHash, existingKind string
	var existingSize int64
	var processedAt sql.NullInt64
	err = tx.QueryRowContext(ctx, `SELECT content_hash,claimed_hash,kind,LENGTH(sealed_jwe),processed_at FROM sealed_inbox WHERE envelope_id=?`, item.EnvelopeID).Scan(&existingHash, &existingClaimedHash, &existingKind, &existingSize, &processedAt)
	if err == nil {
		if existingClaimedHash != item.ClaimedHash || existingKind != item.Kind {
			return false, ErrEnvelopeIDReuse
		}
		if existingHash == hash || processedAt.Valid {
			return true, tx.Commit()
		}
		// ECDH-ES encryption and ES256 signatures are randomized. A retry may
		// therefore carry different outer bytes for the same signed snapshot
		// head or operation receipt. Before unlock we can dedupe only by the
		// immutable semantic binding supplied by the protocol; nested JWS
		// verification still gates application. Controls have no claimed hash
		// and retain strict byte identity until verified.
		if item.ClaimedHash == "" || (item.Kind != "snapshot" && item.Kind != "receipt") {
			return false, ErrEnvelopeIDReuse
		}
		if growth := int64(len(item.Envelope)) - existingSize; growth > 0 {
			if err := enforceTxQuota(ctx, tx, s.quota, growth); err != nil {
				return false, err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE sealed_inbox SET sealed_jwe=?,content_hash=?,received_at=? WHERE envelope_id=? AND processed_at IS NULL`, item.Envelope, hash, item.ReceivedAt.UnixMilli(), item.EnvelopeID); err != nil {
			return false, err
		}
		return true, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO sealed_inbox(envelope_id,kind,sealed_jwe,content_hash,claimed_hash,received_at) VALUES(?,?,?,?,?,?)`, item.EnvelopeID, item.Kind, item.Envelope, hash, item.ClaimedHash, item.ReceivedAt.UnixMilli()); err != nil {
		return false, err
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(item.Envelope))); err != nil {
		return false, err
	}
	return false, tx.Commit()
}

func (s *Store) Inbox(ctx context.Context, limit int) ([]InboxEnvelope, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT envelope_id,kind,sealed_jwe,content_hash,claimed_hash,received_at FROM sealed_inbox WHERE processed_at IS NULL ORDER BY received_at,envelope_id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]InboxEnvelope, 0, limit)
	for rows.Next() {
		var item InboxEnvelope
		var receivedAt int64
		if err := rows.Scan(&item.EnvelopeID, &item.Kind, &item.Envelope, &item.ContentHash, &item.ClaimedHash, &receivedAt); err != nil {
			return nil, err
		}
		item.ReceivedAt = time.UnixMilli(receivedAt).UTC()
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) MarkInboxProcessed(ctx context.Context, envelopeID string, processedAt time.Time) error {
	if !validEnvelopeID(envelopeID, "") {
		return errors.New("inbox envelope id rejected")
	}
	if processedAt.IsZero() {
		processedAt = time.Now().UTC()
	}
	result, err := s.db.ExecContext(ctx, `UPDATE sealed_inbox SET processed_at=? WHERE envelope_id=? AND processed_at IS NULL`, processedAt.UTC().UnixMilli(), envelopeID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		var alreadyProcessed int64
		if err := s.db.QueryRowContext(ctx, `SELECT COALESCE(processed_at,0) FROM sealed_inbox WHERE envelope_id=?`, envelopeID).Scan(&alreadyProcessed); err == nil && alreadyProcessed > 0 {
			return nil
		}
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) PendingControlAcknowledgements(ctx context.Context, limit int) ([]string, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT envelope_id FROM sealed_inbox WHERE kind='control' AND processed_at IS NOT NULL ORDER BY processed_at,envelope_id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		items = append(items, id)
	}
	return items, rows.Err()
}

func (s *Store) ConfirmControlAcknowledgements(ctx context.Context, ids []string) error {
	if len(ids) > 100 {
		return errors.New("control acknowledgement batch rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		if !validUUID(id) {
			return errors.New("control acknowledgement id rejected")
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sealed_inbox WHERE envelope_id=? AND kind='control' AND processed_at IS NOT NULL`, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// WipeGrantData removes every user-data-bearing row and durable write from a
// revoked grant. The signed control being acknowledged may be retained as the
// sole row long enough for the sealed transport plane to confirm delivery.
// The catalog separately destroys the wrapped DEK, which is the cryptographic
// erasure boundary even if filesystem snapshots retain old SQLite pages.
func (s *Store) WipeGrantData(ctx context.Context, preserveControlID string) error {
	if preserveControlID != "" && !validUUID(preserveControlID) {
		return errors.New("wipe control identity rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range []string{
		`DELETE FROM resources`,
		`DELETE FROM outbox`,
		`DELETE FROM receipts`,
		`DELETE FROM conflicts`,
	} {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	if preserveControlID == "" {
		if _, err := tx.ExecContext(ctx, `DELETE FROM sealed_inbox`); err != nil {
			return err
		}
	} else if _, err := tx.ExecContext(ctx, `DELETE FROM sealed_inbox WHERE envelope_id<>?`, preserveControlID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ExpectedOperationHash(ctx context.Context, operationID string) (string, error) {
	if !validUUID(operationID) {
		return "", errors.New("operation identity rejected")
	}
	var hash string
	err := s.db.QueryRowContext(ctx, `SELECT content_hash FROM outbox WHERE operation_id=? UNION ALL SELECT request_hash FROM receipts WHERE operation_id=? LIMIT 1`, operationID, operationID).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrOperationIDReuse
	}
	return hash, err
}

func (s *Store) HasPendingOperation(ctx context.Context, operationID string) (bool, error) {
	if !validUUID(operationID) {
		return false, errors.New("operation identity rejected")
	}
	var exists int
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM outbox WHERE operation_id=?)`, operationID).Scan(&exists)
	return exists == 1, err
}

// ExistingOperation compares a keyed semantic digest, never the randomized
// JWS/JWE bytes. It lets a browser safely retry a lost localhost response
// without producing a second ciphertext or sequence number.
func (s *Store) ExistingOperation(ctx context.Context, operationID, intentHash string) (string, error) {
	if !validUUID(operationID) || !validSHA256Hex(intentHash) {
		return "", errors.New("operation intent rejected")
	}
	var storedIntent, state string
	err := s.db.QueryRowContext(ctx, `SELECT intent_hash,'pending' FROM outbox WHERE operation_id=?
		UNION ALL SELECT intent_hash,'received' FROM receipts WHERE operation_id=? LIMIT 1`, operationID, operationID).Scan(&storedIntent, &state)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if storedIntent == "" || storedIntent != intentHash {
		return "", ErrOperationIDReuse
	}
	return state, nil
}

func (s *Store) CommitReceipt(ctx context.Context, operationID, envelope, requestHash string) error {
	if !validUUID(operationID) || len(envelope) == 0 || len(envelope) > 8<<20 || !validSHA256Hex(requestHash) {
		return errors.New("receipt rejected")
	}
	digest := sha256.Sum256([]byte(envelope))
	hash := hex.EncodeToString(digest[:])
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var expected, intentHash string
	if err := tx.QueryRowContext(ctx, `SELECT content_hash,intent_hash FROM outbox WHERE operation_id=? UNION ALL SELECT request_hash,intent_hash FROM receipts WHERE operation_id=? LIMIT 1`, operationID, operationID).Scan(&expected, &intentHash); err != nil || expected != requestHash || !validSHA256Hex(intentHash) {
		if err != nil {
			return err
		}
		return ErrOperationIDReuse
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO receipts(operation_id,sealed_jwe,content_hash,request_hash,intent_hash,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO UPDATE SET sealed_jwe=excluded.sealed_jwe,content_hash=excluded.content_hash,request_hash=excluded.request_hash,intent_hash=excluded.intent_hash,received_at=excluded.received_at`, operationID, envelope, hash, requestHash, intentHash, time.Now().UTC().UnixMilli()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM outbox WHERE operation_id=?`, operationID); err != nil {
		return err
	}
	return tx.Commit()
}

// StoreConflict preserves the first local version involved in a rejected or
// conflicting command. Retries are idempotent and never overwrite that
// evidence with a later canonical server projection.
func (s *Store) StoreConflict(ctx context.Context, dek []byte, item ConflictRecord) error {
	if !validUUID(item.OperationID) || !validUUID(item.SelectionID) || !validUUID(item.ResourceID) || (item.Status != "conflict" && item.Status != "rejected") || len(item.ErrorCode) > 100 || len(item.ClientChange) == 0 || !json.Valid(item.ClientChange) || len(item.ServerResult) > 2<<20 || len(item.ServerResult) > 0 && !json.Valid(item.ServerResult) {
		return errors.New("conflict record rejected")
	}
	if item.CreatedAt.IsZero() {
		item.CreatedAt = time.Now().UTC()
	}
	raw, err := json.Marshal(item)
	if err != nil {
		return err
	}
	sealed, err := cryptokit.SealRecord(dek, cryptokit.RecordAAD(s.tuple, "tasks", "conflict", item.OperationID, 0), raw)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO conflicts(operation_id,selection_id,resource_id,status,sealed_record,created_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(operation_id) DO NOTHING`, item.OperationID, item.SelectionID, item.ResourceID, item.Status, sealed, item.CreatedAt.UTC().UnixMilli()); err != nil {
		return err
	}
	if err := enforceTxQuota(ctx, tx, s.quota, int64(len(sealed))); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ConflictCount(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM conflicts WHERE resolved_at IS NULL`).Scan(&count)
	return count, err
}

func (s *Store) Conflicts(ctx context.Context, dek []byte, afterOperationID string, limit int) ([]ConflictRecord, string, error) {
	if afterOperationID != "" && !validUUID(afterOperationID) {
		return nil, "", errors.New("conflict cursor rejected")
	}
	limit = normalizeLimit(limit)
	rows, err := s.db.QueryContext(ctx, `SELECT operation_id,sealed_record FROM conflicts
		WHERE resolved_at IS NULL AND operation_id>? ORDER BY operation_id LIMIT ?`, afterOperationID, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	items := make([]ConflictRecord, 0, limit)
	next := ""
	for rows.Next() {
		var operationID string
		var sealed []byte
		if err := rows.Scan(&operationID, &sealed); err != nil {
			return nil, "", err
		}
		if len(items) == limit {
			next = items[len(items)-1].OperationID
			break
		}
		plain, err := cryptokit.OpenRecord(dek, cryptokit.RecordAAD(s.tuple, "tasks", "conflict", operationID, 0), sealed)
		if err != nil {
			return nil, "", err
		}
		var item ConflictRecord
		decoder := json.NewDecoder(bytes.NewReader(plain))
		decoder.DisallowUnknownFields()
		decodeErr := decoder.Decode(&item)
		for index := range plain {
			plain[index] = 0
		}
		if decodeErr != nil || item.OperationID != operationID || !validUUID(item.SelectionID) || !validUUID(item.ResourceID) || (item.Status != "conflict" && item.Status != "rejected") {
			return nil, "", errors.New("stored conflict record corrupt")
		}
		items = append(items, item)
	}
	return items, next, rows.Err()
}

func (s *Store) Counts(ctx context.Context) (resources, pending, inbox int, err error) {
	for query, target := range map[string]*int{
		`SELECT COUNT(*) FROM resources`:                               &resources,
		`SELECT COUNT(*) FROM outbox`:                                  &pending,
		`SELECT COUNT(*) FROM sealed_inbox WHERE processed_at IS NULL`: &inbox,
	} {
		if err = s.db.QueryRowContext(ctx, query).Scan(target); err != nil {
			return 0, 0, 0, err
		}
	}
	return resources, pending, inbox, nil
}

func (s *Store) Size(ctx context.Context) (int64, error) {
	var pageCount, pageSize int64
	if err := s.db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return 0, err
	}
	if err := s.db.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return 0, err
	}
	return pageCount * pageSize, nil
}

func enforceTxQuota(ctx context.Context, tx *sql.Tx, quota, incoming int64) error {
	var pageCount, pageSize int64
	if err := tx.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return err
	}
	if err := tx.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return err
	}
	if pageCount*pageSize+incoming+64*1024 > quota {
		return ErrQuotaExceeded
	}
	return nil
}

func normalizeLimit(limit int) int {
	if limit <= 0 {
		return model.DefaultPageSize
	}
	if limit > model.MaxPageSize {
		return model.MaxPageSize
	}
	return limit
}

func validModule(module string) bool {
	return module == "tasks" || module == "contacts" || module == "programs" || module == "whiteboards"
}

func validUUID(value string) bool {
	// All v3 identifiers are fixed-form canonical UUIDs. Parsing them through a
	// grant Tuple keeps path construction and SQL identities non-ambiguous.
	if len(value) != 36 || value != strings.ToLower(value) {
		return false
	}
	for index, char := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}

func validEnvelopeID(value, kind string) bool {
	if validUUID(value) {
		return true
	}
	if kind != "" && kind != "snapshot" {
		return false
	}
	parts := strings.Split(value, ":")
	if len(parts) != 2 || !validUUID(parts[0]) || len(parts[1]) == 0 || len(parts[1]) > 19 || parts[1][0] == '0' {
		return false
	}
	for _, char := range parts[1] {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func equalJSON(left, right []byte) bool {
	var a, b model.Tuple
	return json.Unmarshal(left, &a) == nil && json.Unmarshal(right, &b) == nil && a.Equal(b)
}
