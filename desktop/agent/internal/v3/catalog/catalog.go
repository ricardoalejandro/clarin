package catalog

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
	_ "modernc.org/sqlite"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
	"github.com/naperu/clarin-offline-agent/internal/v3/serviceprotect"
)

var (
	ErrNotFound        = errors.New("not_found")
	ErrTupleMismatch   = errors.New("grant_tuple_mismatch")
	ErrUnlockThrottled = errors.New("unlock_throttled")
	ErrClockRollback   = errors.New("clock_rollback")
	ErrBootstrapReplay = errors.New("grant_bootstrap_replayed")
	ErrQuotaExceeded   = errors.New("quota_exceeded")
)

type Store struct {
	db        *sql.DB
	path      string
	protector serviceprotect.Protector
	origin    string
}

type Installation struct {
	ID               string
	Origin           string
	SigningKey       *ecdsa.PrivateKey
	EncryptionKey    *ecdsa.PrivateKey
	SigningJWK       jose.JSONWebKey
	EncryptionJWK    jose.JSONWebKey
	PrincipalHashKey []byte
	Counter          int64
	TrustedTime      time.Time
}

func (i *Installation) Destroy() {
	if i == nil {
		return
	}
	zero(i.PrincipalHashKey)
	i.PrincipalHashKey = nil
	i.SigningKey = nil
	i.EncryptionKey = nil
}

type Principal struct {
	ID          string    `json:"windows_principal_id"`
	SIDHash     string    `json:"sid_hash"`
	DisplayName string    `json:"display_name,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

type BrowserProfile struct {
	ID                string          `json:"browser_profile_id"`
	PrincipalID       string          `json:"windows_principal_id"`
	DPoPJWK           jose.JSONWebKey `json:"dpop_jwk"`
	DPoPThumbprint    string          `json:"dpop_thumbprint"`
	State             string          `json:"state"`
	Epoch             int64           `json:"profile_epoch"`
	Label             string          `json:"browser_label,omitempty"`
	ServiceDescriptor string          `json:"service_descriptor,omitempty"`
	SignerPublicKeys  []byte          `json:"signer_public_keys,omitempty"`
	CreatedAt         time.Time       `json:"created_at"`
}

type Grant struct {
	Tuple                     model.Tuple `json:"tuple"`
	State                     string      `json:"state"`
	Actions                   []string    `json:"actions"`
	QuotaBytes                int64       `json:"quota_bytes"`
	DisplayUser               string      `json:"display_user"`
	DisplayAccount            string      `json:"display_account"`
	Lease                     string      `json:"lease"`
	SignerPublicKeys          []byte      `json:"signer_public_keys"`
	ServiceDescriptor         string      `json:"service_descriptor"`
	TransportCapability       []byte      `json:"transport_capability"`
	WrappedSecrets            []byte      `json:"wrapped_secrets"`
	GrantSigningJWK           []byte      `json:"grant_signing_jwk"`
	GrantEncryptionJWK        []byte      `json:"grant_encryption_jwk"`
	ServerIntakeJWK           []byte      `json:"server_intake_jwk"`
	BrowserThumbprint         string      `json:"browser_thumbprint"`
	GrantSigningThumbprint    string      `json:"grant_signing_thumbprint"`
	GrantEncryptionThumbprint string      `json:"grant_encryption_thumbprint"`
	SelectionRevision         int64       `json:"selection_revision"`
	SelectionDigest           string      `json:"selection_digest"`
	LoginBindingSHA256        string      `json:"login_binding_sha256"`
	LeaseExpiresAt            time.Time   `json:"lease_expires_at"`
	LastSyncAt                time.Time   `json:"last_sync_at"`
	NextSequence              int64       `json:"next_sequence"`
	// BootstrapJTI is write-only input used to make initial grant preparation
	// replay-proof. It is never returned as grant metadata.
	BootstrapJTI string `json:"-"`
}

type Selection struct {
	GrantID      string    `json:"grant_id"`
	SelectionID  string    `json:"selection_id"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   string    `json:"resource_id"`
	Label        string    `json:"label"`
	Readiness    string    `json:"readiness"`
	HeadVersion  int64     `json:"head_version"`
	ContentHash  string    `json:"content_hash,omitempty"`
	ItemCount    int64     `json:"item_count"`
	ByteSize     int64     `json:"byte_size"`
	LastSyncedAt time.Time `json:"last_synced_at,omitempty"`
	ErrorCode    string    `json:"error_code,omitempty"`
}

func Open(root, origin string, protector serviceprotect.Protector) (*Store, error) {
	canonicalOrigin, err := validateOrigin(origin)
	if err != nil {
		return nil, err
	}
	if protector == nil || strings.TrimSpace(root) == "" {
		return nil, errors.New("catalog root and service protector are required")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(root, "catalog-v3.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db, path: path, protector: protector, origin: canonicalOrigin}
	if err := store.initialize(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	_ = os.Chmod(path, 0o600)
	return store, nil
}

func (s *Store) initialize(ctx context.Context) error {
	statements := []string{
		`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=FULL`, `PRAGMA foreign_keys=ON`, `PRAGMA temp_store=MEMORY`, `PRAGMA secure_delete=ON`, `PRAGMA busy_timeout=5000`,
		`CREATE TABLE IF NOT EXISTS installation (
			id INTEGER PRIMARY KEY CHECK(id=1), installation_id TEXT NOT NULL UNIQUE, origin TEXT NOT NULL,
			signing_private BLOB NOT NULL, encryption_private BLOB NOT NULL, signing_jwk BLOB NOT NULL, encryption_jwk BLOB NOT NULL,
			principal_hash_key BLOB NOT NULL, counter INTEGER NOT NULL DEFAULT 0 CHECK(counter>=0), trusted_time INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS principals (
			principal_id TEXT PRIMARY KEY, sid_hash TEXT NOT NULL UNIQUE, display_name BLOB NOT NULL, created_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS browser_profiles (
			browser_profile_id TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(principal_id), dpop_jwk BLOB NOT NULL,
			dpop_thumbprint TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')), epoch INTEGER NOT NULL DEFAULT 1,
			label BLOB NOT NULL, service_descriptor BLOB NOT NULL DEFAULT '', signer_public_keys BLOB NOT NULL DEFAULT '', created_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS browser_principal_idx ON browser_profiles(principal_id,state)`,
		`CREATE TABLE IF NOT EXISTS grants (
			grant_id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, principal_id TEXT NOT NULL, browser_profile_id TEXT NOT NULL,
			authorization_id TEXT NOT NULL, user_id TEXT NOT NULL, account_id TEXT NOT NULL,
			state TEXT NOT NULL CHECK(state IN ('pending','preparing','available','expired','revoked','error')),
			actions BLOB NOT NULL, quota_bytes INTEGER NOT NULL, display_user BLOB NOT NULL, display_account BLOB NOT NULL,
			lease BLOB NOT NULL DEFAULT '', signer_public_keys BLOB NOT NULL DEFAULT '', service_descriptor BLOB NOT NULL DEFAULT '',
			transport_capability BLOB NOT NULL DEFAULT '', wrapped_secrets BLOB NOT NULL DEFAULT '', grant_signing_jwk BLOB NOT NULL DEFAULT '', grant_encryption_jwk BLOB NOT NULL DEFAULT '', server_intake_jwk BLOB NOT NULL DEFAULT '',
			browser_thumbprint TEXT NOT NULL, grant_signing_thumbprint TEXT NOT NULL DEFAULT '', grant_encryption_thumbprint TEXT NOT NULL DEFAULT '',
			selection_revision INTEGER NOT NULL DEFAULT 0, selection_digest TEXT NOT NULL DEFAULT '', login_binding_sha256 TEXT NOT NULL DEFAULT '', lease_expires_at INTEGER NOT NULL DEFAULT 0,
			last_sync_at INTEGER NOT NULL DEFAULT 0, next_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_sequence>0),
			UNIQUE(browser_profile_id,user_id,account_id),
			FOREIGN KEY(browser_profile_id) REFERENCES browser_profiles(browser_profile_id)
		)`,
		`CREATE INDEX IF NOT EXISTS grant_browser_idx ON grants(browser_profile_id,state,grant_id)`,
		`CREATE TABLE IF NOT EXISTS used_bootstraps (
			jti TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE, tuple_binding TEXT NOT NULL, consumed_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS selections (
			grant_id TEXT NOT NULL REFERENCES grants(grant_id) ON DELETE CASCADE, selection_id TEXT NOT NULL,
			module TEXT NOT NULL CHECK(module IN ('tasks','contacts','programs','whiteboards')), resource_type TEXT NOT NULL, resource_id TEXT NOT NULL,
			label BLOB NOT NULL, readiness TEXT NOT NULL CHECK(readiness IN ('preparing','available','error')),
			head_version INTEGER NOT NULL DEFAULT 0 CHECK(head_version>=0), content_hash TEXT NOT NULL DEFAULT '',
			item_count INTEGER NOT NULL DEFAULT 0 CHECK(item_count>=0), byte_size INTEGER NOT NULL DEFAULT 0 CHECK(byte_size>=0),
			last_synced_at INTEGER NOT NULL DEFAULT 0, error_code TEXT NOT NULL DEFAULT '',
			PRIMARY KEY(grant_id,selection_id), UNIQUE(grant_id,module,resource_type,resource_id)
		)`,
		`CREATE INDEX IF NOT EXISTS selections_page_idx ON selections(grant_id,module,selection_id)`,
		`CREATE TABLE IF NOT EXISTS unlock_throttle (
			grant_id TEXT PRIMARY KEY REFERENCES grants(grant_id) ON DELETE CASCADE, failures INTEGER NOT NULL DEFAULT 0,
			next_allowed_at INTEGER NOT NULL DEFAULT 0, last_attempt_at INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS control_high_water (
			scope TEXT NOT NULL, scope_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), updated_at INTEGER NOT NULL,
			PRIMARY KEY(scope,scope_id)
		)`,
		`CREATE TABLE IF NOT EXISTS sync_state (
			grant_id TEXT PRIMARY KEY REFERENCES grants(grant_id) ON DELETE CASCADE,
			snapshot_cursor TEXT NOT NULL DEFAULT ''
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("initialize offline catalog: %w", err)
		}
	}
	// Additive compatibility for local v3 catalogs produced by an earlier
	// candidate. This preserves their pending grants and outboxes.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE browser_profiles ADD COLUMN signer_public_keys BLOB NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate offline catalog signer ring: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE grants ADD COLUMN server_intake_jwk BLOB NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate offline catalog intake key: %w", err)
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE grants ADD COLUMN login_binding_sha256 TEXT NOT NULL DEFAULT ''`); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("migrate offline catalog login binding: %w", err)
	}
	return nil
}

// NextSnapshotBatch prioritizes never-ready selections, then rotates through
// every authorized selection (including available ones). This is necessary
// because the server inventory is not a push channel: periodic signed
// snapshots are how online edits eventually refresh an offline cache without
// starving selections after the first four.
func (s *Store) NextSnapshotBatch(ctx context.Context, grantID string, limit int) ([]string, error) {
	if !canonicalUUID(grantID) || limit < 1 || limit > 4 {
		return nil, errors.New("snapshot batch scope rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO sync_state(grant_id) VALUES(?) ON CONFLICT(grant_id) DO NOTHING`, grantID); err != nil {
		return nil, err
	}
	var cursor string
	if err := tx.QueryRowContext(ctx, `SELECT snapshot_cursor FROM sync_state WHERE grant_id=?`, grantID).Scan(&cursor); err != nil {
		return nil, err
	}
	items := make([]string, 0, limit)
	rows, err := tx.QueryContext(ctx, `SELECT selection_id FROM selections WHERE grant_id=? AND readiness<>'available' ORDER BY selection_id LIMIT ?`, grantID, limit)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		items, seen[id] = append(items, id), struct{}{}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, condition := range []string{"selection_id>?", "selection_id<=?"} {
		if len(items) == limit {
			break
		}
		query := `SELECT selection_id FROM selections WHERE grant_id=? AND ` + condition + ` ORDER BY selection_id LIMIT ?`
		rows, err = tx.QueryContext(ctx, query, grantID, cursor, limit-len(items)+len(seen))
		if err != nil {
			return nil, err
		}
		for rows.Next() && len(items) < limit {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			if _, duplicate := seen[id]; duplicate {
				continue
			}
			items, seen[id] = append(items, id), struct{}{}
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	if len(items) > 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE sync_state SET snapshot_cursor=? WHERE grant_id=?`, items[len(items)-1], grantID); err != nil {
			return nil, err
		}
	}
	return items, tx.Commit()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) EnsureInstallation(ctx context.Context) (*Installation, error) {
	installation, err := s.loadInstallation(ctx)
	if err == nil {
		return installation, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	id := uuid.NewString()
	signing, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	encryption, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	signingJWK, err := cryptokit.PublicJWK(&signing.PublicKey, "clarin-offline-installation-signing-"+id, "sig", "ES256")
	if err != nil {
		return nil, err
	}
	encryptionJWK, err := cryptokit.PublicJWK(&encryption.PublicKey, "clarin-offline-service-encryption-"+id, "enc", "ECDH-ES+A256KW")
	if err != nil {
		return nil, err
	}
	signingProtected, err := s.protectPrivate(signing, "installation-signing:"+id)
	if err != nil {
		return nil, err
	}
	encryptionProtected, err := s.protectPrivate(encryption, "service-encryption:"+id)
	if err != nil {
		return nil, err
	}
	hashKey := make([]byte, 32)
	if _, err := rand.Read(hashKey); err != nil {
		return nil, err
	}
	protectedHashKey, err := s.protector.Protect(hashKey, "principal-hash:"+id)
	if err != nil {
		zero(hashKey)
		return nil, err
	}
	signingRaw, _ := json.Marshal(signingJWK)
	encryptionRaw, _ := json.Marshal(encryptionJWK)
	_, err = s.db.ExecContext(ctx, `INSERT INTO installation(id,installation_id,origin,signing_private,encryption_private,signing_jwk,encryption_jwk,principal_hash_key) VALUES(1,?,?,?,?,?,?,?)`, id, s.origin, signingProtected, encryptionProtected, signingRaw, encryptionRaw, protectedHashKey)
	if err != nil {
		zero(hashKey)
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return s.loadInstallation(ctx)
		}
		return nil, err
	}
	return &Installation{ID: id, Origin: s.origin, SigningKey: signing, EncryptionKey: encryption, SigningJWK: signingJWK, EncryptionJWK: encryptionJWK, PrincipalHashKey: hashKey}, nil
}

func (s *Store) loadInstallation(ctx context.Context) (*Installation, error) {
	var id, origin string
	var signingProtected, encryptionProtected, signingRaw, encryptionRaw, hashProtected []byte
	var counter, trustedMillis int64
	err := s.db.QueryRowContext(ctx, `SELECT installation_id,origin,signing_private,encryption_private,signing_jwk,encryption_jwk,principal_hash_key,counter,trusted_time FROM installation WHERE id=1`).
		Scan(&id, &origin, &signingProtected, &encryptionProtected, &signingRaw, &encryptionRaw, &hashProtected, &counter, &trustedMillis)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if origin != s.origin {
		return nil, errors.New("configured Clarin origin does not match installation")
	}
	signing, err := s.unprotectPrivate(signingProtected, "installation-signing:"+id)
	if err != nil {
		return nil, err
	}
	encryption, err := s.unprotectPrivate(encryptionProtected, "service-encryption:"+id)
	if err != nil {
		return nil, err
	}
	var signingJWK, encryptionJWK jose.JSONWebKey
	if json.Unmarshal(signingRaw, &signingJWK) != nil || json.Unmarshal(encryptionRaw, &encryptionJWK) != nil {
		return nil, errors.New("installation public keys are corrupt")
	}
	hashKey, err := s.protector.Unprotect(hashProtected, "principal-hash:"+id)
	if err != nil || len(hashKey) != 32 {
		return nil, errors.New("installation principal key is unavailable")
	}
	return &Installation{ID: id, Origin: origin, SigningKey: signing, EncryptionKey: encryption, SigningJWK: signingJWK, EncryptionJWK: encryptionJWK, PrincipalHashKey: hashKey, Counter: counter, TrustedTime: time.UnixMilli(trustedMillis).UTC()}, nil
}

func (s *Store) NextCounter(ctx context.Context) (int64, error) {
	var counter int64
	err := s.db.QueryRowContext(ctx, `UPDATE installation SET counter=counter+1 WHERE id=1 RETURNING counter`).Scan(&counter)
	return counter, err
}

func (s *Store) CheckClock(ctx context.Context, now time.Time) error {
	var trustedMillis int64
	if err := s.db.QueryRowContext(ctx, `SELECT trusted_time FROM installation WHERE id=1`).Scan(&trustedMillis); err != nil {
		return err
	}
	if trustedMillis > 0 && now.UTC().Before(time.UnixMilli(trustedMillis).Add(-2*time.Minute)) {
		return ErrClockRollback
	}
	return nil
}

func (s *Store) AdvanceTrustedTime(ctx context.Context, serverTime, observedAt time.Time) error {
	serverTime, observedAt = serverTime.UTC(), observedAt.UTC()
	if serverTime.After(observedAt.Add(5 * time.Minute)) {
		return errors.New("server time is implausibly in the future")
	}
	millis := serverTime.UnixMilli()
	_, err := s.db.ExecContext(ctx, `UPDATE installation SET trusted_time=CASE WHEN trusted_time<? THEN ? ELSE trusted_time END WHERE id=1`, millis, millis)
	return err
}

func (s *Store) EnsurePrincipal(ctx context.Context, windowsSID, displayName string) (*Principal, error) {
	installation, err := s.loadInstallation(ctx)
	if err != nil {
		return nil, err
	}
	defer installation.Destroy()
	windowsSID = strings.TrimSpace(windowsSID)
	if windowsSID == "" || len(windowsSID) > 256 {
		return nil, errors.New("Windows SID rejected")
	}
	mac := hmac.New(sha256.New, installation.PrincipalHashKey)
	_, _ = mac.Write([]byte(windowsSID))
	sidHash := hex.EncodeToString(mac.Sum(nil))
	var principalID string
	var protectedName []byte
	var createdAt int64
	err = s.db.QueryRowContext(ctx, `SELECT principal_id,display_name,created_at FROM principals WHERE sid_hash=?`, sidHash).Scan(&principalID, &protectedName, &createdAt)
	if err == nil {
		name, decryptErr := s.protector.Unprotect(protectedName, "principal-display:"+principalID)
		if decryptErr != nil {
			return nil, decryptErr
		}
		return &Principal{ID: principalID, SIDHash: sidHash, DisplayName: string(name), CreatedAt: time.UnixMilli(createdAt).UTC()}, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	principalID = uuid.NewString()
	if len([]rune(displayName)) > 200 {
		displayName = ""
	}
	protectedName, err = s.protector.Protect([]byte(displayName), "principal-display:"+principalID)
	if err != nil {
		return nil, err
	}
	createdAt = time.Now().UTC().UnixMilli()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO principals(principal_id,sid_hash,display_name,created_at) VALUES(?,?,?,?)`, principalID, sidHash, protectedName, createdAt); err != nil {
		return nil, err
	}
	return &Principal{ID: principalID, SIDHash: sidHash, DisplayName: displayName, CreatedAt: time.UnixMilli(createdAt).UTC()}, nil
}

func (s *Store) Principal(ctx context.Context, id string) (*Principal, error) {
	var item Principal
	var protectedName []byte
	var createdAt int64
	err := s.db.QueryRowContext(ctx, `SELECT principal_id,sid_hash,display_name,created_at FROM principals WHERE principal_id=?`, id).Scan(&item.ID, &item.SIDHash, &protectedName, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	name, err := s.protector.Unprotect(protectedName, "principal-display:"+id)
	if err != nil {
		return nil, err
	}
	item.DisplayName, item.CreatedAt = string(name), time.UnixMilli(createdAt).UTC()
	return &item, nil
}

func (s *Store) CreateBrowserProfile(ctx context.Context, principalID string, dpopJWK jose.JSONWebKey, label string) (*BrowserProfile, error) {
	if _, err := uuid.Parse(principalID); err != nil {
		return nil, errors.New("principal id rejected")
	}
	key, ok := dpopJWK.Key.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() || !dpopJWK.IsPublic() || !dpopJWK.Valid() || dpopJWK.Use != "sig" || dpopJWK.Algorithm != "ES256" {
		return nil, errors.New("browser DPoP key rejected")
	}
	thumbprint, err := cryptokit.Thumbprint(dpopJWK)
	if err != nil {
		return nil, err
	}
	if len([]rune(label)) > 200 {
		return nil, errors.New("browser label is excessive")
	}
	id := uuid.NewString()
	// The browser cannot choose its durable profile identifier. Once the
	// service assigns it, bind the public key's kid to that identifier so both
	// the local DPoP verifier and the backend enrollment proof verify the same
	// public JWK. RFC 7638 thumbprints intentionally do not include kid.
	dpopJWK.KeyID = id
	protectedLabel, err := s.protector.Protect([]byte(label), "browser-label:"+id)
	if err != nil {
		return nil, err
	}
	rawJWK, _ := json.Marshal(dpopJWK.Public())
	now := time.Now().UTC()
	_, err = s.db.ExecContext(ctx, `INSERT INTO browser_profiles(browser_profile_id,principal_id,dpop_jwk,dpop_thumbprint,state,epoch,label,created_at) VALUES(?,?,?,?,?,?,?,?)`, id, principalID, rawJWK, thumbprint, "pending", 1, protectedLabel, now.UnixMilli())
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, errors.New("browser key is already enrolled")
		}
		return nil, err
	}
	return &BrowserProfile{ID: id, PrincipalID: principalID, DPoPJWK: dpopJWK.Public(), DPoPThumbprint: thumbprint, State: "pending", Epoch: 1, Label: label, CreatedAt: now}, nil
}

func (s *Store) BrowserProfile(ctx context.Context, id string) (*BrowserProfile, error) {
	var profile BrowserProfile
	var rawJWK, protectedLabel, descriptor []byte
	var createdAt int64
	err := s.db.QueryRowContext(ctx, `SELECT browser_profile_id,principal_id,dpop_jwk,dpop_thumbprint,state,epoch,label,service_descriptor,signer_public_keys,created_at FROM browser_profiles WHERE browser_profile_id=?`, id).
		Scan(&profile.ID, &profile.PrincipalID, &rawJWK, &profile.DPoPThumbprint, &profile.State, &profile.Epoch, &protectedLabel, &descriptor, &profile.SignerPublicKeys, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(rawJWK, &profile.DPoPJWK); err != nil {
		return nil, errors.New("browser public key is corrupt")
	}
	label, err := s.protector.Unprotect(protectedLabel, "browser-label:"+id)
	if err != nil {
		return nil, err
	}
	profile.Label = string(label)
	profile.ServiceDescriptor = string(descriptor)
	profile.CreatedAt = time.UnixMilli(createdAt).UTC()
	return &profile, nil
}

func (s *Store) ActivateBrowserProfile(ctx context.Context, id, serviceDescriptor string, signerPublicKeys []byte) error {
	if serviceDescriptor == "" || len(serviceDescriptor) > 128<<10 || len(signerPublicKeys) == 0 || len(signerPublicKeys) > 128<<10 {
		return errors.New("service descriptor rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE browser_profiles SET state='active',service_descriptor=?,signer_public_keys=?,epoch=epoch+1 WHERE browser_profile_id=? AND state!='revoked'`, serviceDescriptor, signerPublicKeys, id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) BumpBrowserEpoch(ctx context.Context, id string) (int64, error) {
	var epoch int64
	err := s.db.QueryRowContext(ctx, `UPDATE browser_profiles SET epoch=epoch+1 WHERE browser_profile_id=? RETURNING epoch`, id).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return epoch, err
}

func (s *Store) SaveGrant(ctx context.Context, grant Grant) error {
	if err := grant.Tuple.Validate(); err != nil {
		return err
	}
	if grant.Tuple.InstallationID == "" || grant.QuotaBytes <= 0 || grant.QuotaBytes > model.MaxStorageBytes || grant.BrowserThumbprint == "" || !validSHA256Hex(grant.LoginBindingSHA256) || model.ValidateActions(grant.Actions) != nil {
		return errors.New("grant policy rejected")
	}
	if grant.State == "" {
		grant.State = "preparing"
	}
	if grant.State != "pending" && grant.State != "preparing" && grant.State != "available" && grant.State != "expired" && grant.State != "revoked" && grant.State != "error" {
		return errors.New("grant state rejected")
	}
	grant.SignerPublicKeys = nonNil(grant.SignerPublicKeys)
	grant.GrantSigningJWK = nonNil(grant.GrantSigningJWK)
	grant.GrantEncryptionJWK = nonNil(grant.GrantEncryptionJWK)
	grant.ServerIntakeJWK = nonNil(grant.ServerIntakeJWK)
	actions, _ := json.Marshal(grant.Actions)
	displayUser, err := s.protector.Protect([]byte(grant.DisplayUser), "grant-user:"+grant.Tuple.GrantID)
	if err != nil {
		return err
	}
	displayAccount, err := s.protector.Protect([]byte(grant.DisplayAccount), "grant-account:"+grant.Tuple.GrantID)
	if err != nil {
		return err
	}
	protectedTransport, err := s.protectOptional(grant.TransportCapability, "grant-transport:"+grant.Tuple.GrantID)
	if err != nil {
		return err
	}
	protectedSecrets, err := s.protectOptional(grant.WrappedSecrets, "grant-secrets:"+grant.Tuple.GrantID)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if grant.BootstrapJTI != "" {
		if parsed, parseErr := uuid.Parse(grant.BootstrapJTI); parseErr != nil || parsed.String() != strings.ToLower(grant.BootstrapJTI) {
			return errors.New("grant bootstrap jti rejected")
		}
		var existingGrantID string
		lookupErr := tx.QueryRowContext(ctx, `SELECT grant_id FROM grants WHERE grant_id=?`, grant.Tuple.GrantID).Scan(&existingGrantID)
		if lookupErr == nil {
			return ErrBootstrapReplay
		}
		if !errors.Is(lookupErr, sql.ErrNoRows) {
			return lookupErr
		}
		if _, insertErr := tx.ExecContext(ctx, `INSERT INTO used_bootstraps(jti,grant_id,tuple_binding,consumed_at) VALUES(?,?,?,?)`, grant.BootstrapJTI, grant.Tuple.GrantID, grant.Tuple.Binding(), time.Now().UTC().UnixMilli()); insertErr != nil {
			if strings.Contains(strings.ToLower(insertErr.Error()), "unique") {
				return ErrBootstrapReplay
			}
			return insertErr
		}
	}
	var actualInstallationID, actualPrincipalID, actualBrowserThumbprint string
	err = tx.QueryRowContext(ctx, `SELECT i.installation_id,b.principal_id,b.dpop_thumbprint
		FROM installation i JOIN browser_profiles b ON b.browser_profile_id=? WHERE i.id=1`, grant.Tuple.BrowserProfileID).
		Scan(&actualInstallationID, &actualPrincipalID, &actualBrowserThumbprint)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrTupleMismatch
	}
	if err != nil {
		return err
	}
	if actualInstallationID != grant.Tuple.InstallationID || actualPrincipalID != grant.Tuple.WindowsPrincipalID || actualBrowserThumbprint != grant.BrowserThumbprint {
		return ErrTupleMismatch
	}
	var allocatedQuota int64
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(quota_bytes),0) FROM grants WHERE grant_id<>? AND state NOT IN ('revoked','error')`, grant.Tuple.GrantID).Scan(&allocatedQuota); err != nil {
		return err
	}
	if allocatedQuota > model.MaxStorageBytes-grant.QuotaBytes {
		return ErrQuotaExceeded
	}
	var existingTuple model.Tuple
	err = tx.QueryRowContext(ctx, `SELECT installation_id,principal_id,browser_profile_id,authorization_id,grant_id,user_id,account_id FROM grants WHERE grant_id=?`, grant.Tuple.GrantID).
		Scan(&existingTuple.InstallationID, &existingTuple.WindowsPrincipalID, &existingTuple.BrowserProfileID, &existingTuple.AuthorizationID, &existingTuple.GrantID, &existingTuple.UserID, &existingTuple.AccountID)
	if err == nil && !existingTuple.Equal(grant.Tuple) {
		return ErrTupleMismatch
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO grants(
		grant_id,installation_id,principal_id,browser_profile_id,authorization_id,user_id,account_id,state,actions,quota_bytes,display_user,display_account,
		lease,signer_public_keys,service_descriptor,transport_capability,wrapped_secrets,grant_signing_jwk,grant_encryption_jwk,server_intake_jwk,
		browser_thumbprint,grant_signing_thumbprint,grant_encryption_thumbprint,selection_revision,selection_digest,login_binding_sha256,lease_expires_at,last_sync_at,next_sequence)
		VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(grant_id) DO UPDATE SET state=excluded.state,actions=excluded.actions,quota_bytes=excluded.quota_bytes,
		display_user=excluded.display_user,display_account=excluded.display_account,lease=excluded.lease,signer_public_keys=excluded.signer_public_keys,
		service_descriptor=excluded.service_descriptor,transport_capability=excluded.transport_capability,wrapped_secrets=excluded.wrapped_secrets,
		grant_signing_jwk=excluded.grant_signing_jwk,grant_encryption_jwk=excluded.grant_encryption_jwk,server_intake_jwk=excluded.server_intake_jwk,browser_thumbprint=excluded.browser_thumbprint,
		grant_signing_thumbprint=excluded.grant_signing_thumbprint,grant_encryption_thumbprint=excluded.grant_encryption_thumbprint,
		selection_revision=excluded.selection_revision,selection_digest=excluded.selection_digest,login_binding_sha256=excluded.login_binding_sha256,lease_expires_at=excluded.lease_expires_at,last_sync_at=excluded.last_sync_at`,
		grant.Tuple.GrantID, grant.Tuple.InstallationID, grant.Tuple.WindowsPrincipalID, grant.Tuple.BrowserProfileID, grant.Tuple.AuthorizationID, grant.Tuple.UserID, grant.Tuple.AccountID,
		grant.State, actions, grant.QuotaBytes, displayUser, displayAccount, []byte(grant.Lease), grant.SignerPublicKeys, []byte(grant.ServiceDescriptor), protectedTransport, protectedSecrets,
		grant.GrantSigningJWK, grant.GrantEncryptionJWK, grant.ServerIntakeJWK, grant.BrowserThumbprint, grant.GrantSigningThumbprint, grant.GrantEncryptionThumbprint,
		grant.SelectionRevision, grant.SelectionDigest, grant.LoginBindingSHA256, millis(grant.LeaseExpiresAt), millis(grant.LastSyncAt), max64(1, grant.NextSequence))
	if err != nil {
		return err
	}
	_, _ = tx.ExecContext(ctx, `INSERT INTO unlock_throttle(grant_id) VALUES(?) ON CONFLICT(grant_id) DO NOTHING`, grant.Tuple.GrantID)
	return tx.Commit()
}

func (s *Store) Grant(ctx context.Context, grantID string) (*Grant, error) {
	var grant Grant
	grant.Tuple.GrantID = grantID
	var actions, protectedUser, protectedAccount, lease, descriptor, protectedTransport, protectedSecrets []byte
	var leaseExpires, lastSync int64
	err := s.db.QueryRowContext(ctx, `SELECT installation_id,principal_id,browser_profile_id,authorization_id,user_id,account_id,state,actions,quota_bytes,
		display_user,display_account,lease,signer_public_keys,service_descriptor,transport_capability,wrapped_secrets,grant_signing_jwk,grant_encryption_jwk,server_intake_jwk,
		browser_thumbprint,grant_signing_thumbprint,grant_encryption_thumbprint,selection_revision,selection_digest,login_binding_sha256,lease_expires_at,last_sync_at,next_sequence
		FROM grants WHERE grant_id=?`, grantID).Scan(
		&grant.Tuple.InstallationID, &grant.Tuple.WindowsPrincipalID, &grant.Tuple.BrowserProfileID, &grant.Tuple.AuthorizationID, &grant.Tuple.UserID, &grant.Tuple.AccountID,
		&grant.State, &actions, &grant.QuotaBytes, &protectedUser, &protectedAccount, &lease, &grant.SignerPublicKeys, &descriptor, &protectedTransport, &protectedSecrets,
		&grant.GrantSigningJWK, &grant.GrantEncryptionJWK, &grant.ServerIntakeJWK, &grant.BrowserThumbprint, &grant.GrantSigningThumbprint, &grant.GrantEncryptionThumbprint,
		&grant.SelectionRevision, &grant.SelectionDigest, &grant.LoginBindingSHA256, &leaseExpires, &lastSync, &grant.NextSequence)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(actions, &grant.Actions) != nil || grant.Tuple.Validate() != nil || !validSHA256Hex(grant.LoginBindingSHA256) || model.ValidateActions(grant.Actions) != nil {
		return nil, errors.New("stored grant is corrupt")
	}
	user, err := s.protector.Unprotect(protectedUser, "grant-user:"+grantID)
	if err != nil {
		return nil, err
	}
	account, err := s.protector.Unprotect(protectedAccount, "grant-account:"+grantID)
	if err != nil {
		return nil, err
	}
	transport, err := s.unprotectOptional(protectedTransport, "grant-transport:"+grantID)
	if err != nil {
		return nil, err
	}
	secrets, err := s.unprotectOptional(protectedSecrets, "grant-secrets:"+grantID)
	if err != nil {
		return nil, err
	}
	grant.DisplayUser, grant.DisplayAccount = string(user), string(account)
	grant.Lease, grant.ServiceDescriptor = string(lease), string(descriptor)
	grant.TransportCapability, grant.WrappedSecrets = transport, secrets
	grant.LeaseExpiresAt, grant.LastSyncAt = fromMillis(leaseExpires), fromMillis(lastSync)
	return &grant, nil
}

func (s *Store) GrantsForBrowser(ctx context.Context, browserID, afterGrantID string, limit int) ([]Grant, string, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT grant_id FROM grants WHERE browser_profile_id=? AND grant_id>? ORDER BY grant_id LIMIT ?`, browserID, afterGrantID, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	ids := make([]string, 0, limit+1)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, "", err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(ids) > limit {
		next = ids[limit-1]
		ids = ids[:limit]
	}
	result := make([]Grant, 0, len(ids))
	for _, id := range ids {
		grant, err := s.Grant(ctx, id)
		if err != nil {
			return nil, "", err
		}
		result = append(result, *grant)
	}
	return result, next, nil
}

func (s *Store) TransportGrants(ctx context.Context, limit int) ([]Grant, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT grant_id FROM grants WHERE length(transport_capability)>0 AND state IN ('available','expired','revoked') ORDER BY grant_id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]Grant, 0, len(ids))
	for _, id := range ids {
		grant, err := s.Grant(ctx, id)
		if err != nil {
			return nil, err
		}
		result = append(result, *grant)
	}
	return result, nil
}

func (s *Store) UpdateLastSync(ctx context.Context, grantID string, syncedAt time.Time) error {
	result, err := s.db.ExecContext(ctx, `UPDATE grants SET last_sync_at=? WHERE grant_id=?`, syncedAt.UTC().UnixMilli(), grantID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) SetGrantState(ctx context.Context, grantID, state string) error {
	if state != "available" && state != "expired" && state != "revoked" && state != "error" {
		return errors.New("grant state rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE grants SET state=? WHERE grant_id=?`, state, grantID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrNotFound
	}
	return nil
}

// RevokeGrantAndEraseSecrets destroys the password-wrapped DEK/private keys
// and user-facing labels while retaining only the public verification ring
// and transport capability required to acknowledge the signed wipe control.
func (s *Store) RevokeGrantAndEraseSecrets(ctx context.Context, grantID string) error {
	if !canonicalUUID(grantID) {
		return errors.New("grant identity rejected")
	}
	emptyUser, err := s.protector.Protect([]byte{}, "grant-user:"+grantID)
	if err != nil {
		return err
	}
	emptyAccount, err := s.protector.Protect([]byte{}, "grant-account:"+grantID)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE grants SET state='revoked',display_user=?,display_account=?,lease='',wrapped_secrets='',lease_expires_at=0 WHERE grant_id=?`, emptyUser, emptyAccount, grantID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM selections WHERE grant_id=?`, grantID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM sync_state WHERE grant_id=?`, grantID); err != nil {
		return err
	}
	return tx.Commit()
}

// FinalizeRevokedGrant drops the last transport/public metadata after the
// backend has accepted every local control acknowledgement.
func (s *Store) FinalizeRevokedGrant(ctx context.Context, grantID string) error {
	if !canonicalUUID(grantID) {
		return errors.New("grant identity rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE grants SET transport_capability='',signer_public_keys='',service_descriptor='',grant_signing_jwk='',grant_encryption_jwk='',server_intake_jwk='',grant_signing_thumbprint='',grant_encryption_thumbprint='' WHERE grant_id=? AND state='revoked'`, grantID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AdvanceControlHighWater(ctx context.Context, scope, scopeID string, revision int64) (bool, error) {
	if revision < 1 || scope == "" || scopeID == "" {
		return false, errors.New("control high-water rejected")
	}
	var accepted int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO control_high_water(scope,scope_id,revision,updated_at) VALUES(?,?,?,?)
		ON CONFLICT(scope,scope_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at
		WHERE control_high_water.revision<excluded.revision RETURNING revision`, scope, scopeID, revision, time.Now().UTC().UnixMilli()).Scan(&accepted)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) ReplaceSelections(ctx context.Context, grantID string, revision int64, digest string, selections []Selection) error {
	if _, err := uuid.Parse(grantID); err != nil || revision < 0 || len(selections) > model.MaxGrantResources {
		return errors.New("selection manifest rejected")
	}
	models := make([]model.Selection, 0, len(selections))
	seen := make(map[string]struct{}, len(selections))
	for _, item := range selections {
		selection := model.Selection{SelectionID: item.SelectionID, Module: item.Module, ResourceType: item.ResourceType, ResourceID: item.ResourceID, HeadVersion: item.HeadVersion, ContentHash: item.ContentHash}
		if item.GrantID != grantID || selection.Validate() != nil || (item.Readiness != "preparing" && item.Readiness != "available" && item.Readiness != "error") || len([]rune(item.Label)) > 500 || item.ItemCount < 0 || item.ByteSize < 0 || len(item.ErrorCode) > 100 {
			return errors.New("selection entry rejected")
		}
		if _, duplicate := seen[item.SelectionID]; duplicate {
			return errors.New("duplicate selection id")
		}
		seen[item.SelectionID] = struct{}{}
		models = append(models, selection)
	}
	calculated, err := model.SelectionDigest(models)
	if err != nil || calculated != digest {
		return errors.New("selection digest rejected")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var currentRevision int64
	if err := tx.QueryRowContext(ctx, `SELECT selection_revision FROM grants WHERE grant_id=?`, grantID).Scan(&currentRevision); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if revision < currentRevision {
		return errors.New("stale selection revision")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM selections WHERE grant_id=?`, grantID); err != nil {
		return err
	}
	for _, item := range selections {
		protectedLabel, err := s.protector.Protect([]byte(item.Label), "selection-label:"+grantID+":"+item.SelectionID)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO selections(grant_id,selection_id,module,resource_type,resource_id,label,readiness,head_version,content_hash,item_count,byte_size,last_synced_at,error_code)
			VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, grantID, item.SelectionID, item.Module, item.ResourceType, item.ResourceID, protectedLabel, item.Readiness, item.HeadVersion, item.ContentHash, item.ItemCount, item.ByteSize, millis(item.LastSyncedAt), item.ErrorCode); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE grants SET selection_revision=?,selection_digest=? WHERE grant_id=?`, revision, digest, grantID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Selection(ctx context.Context, grantID, selectionID string) (*Selection, error) {
	var item Selection
	var protectedLabel []byte
	var lastSync int64
	err := s.db.QueryRowContext(ctx, `SELECT grant_id,selection_id,module,resource_type,resource_id,label,readiness,head_version,content_hash,item_count,byte_size,last_synced_at,error_code
		FROM selections WHERE grant_id=? AND selection_id=?`, grantID, selectionID).Scan(&item.GrantID, &item.SelectionID, &item.Module, &item.ResourceType, &item.ResourceID, &protectedLabel, &item.Readiness, &item.HeadVersion, &item.ContentHash, &item.ItemCount, &item.ByteSize, &lastSync, &item.ErrorCode)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	label, err := s.protector.Unprotect(protectedLabel, "selection-label:"+grantID+":"+selectionID)
	if err != nil {
		return nil, err
	}
	item.Label = string(label)
	item.LastSyncedAt = fromMillis(lastSync)
	return &item, nil
}

func (s *Store) ApplySelectionSnapshot(ctx context.Context, grantID, selectionID, module, resourceType, resourceID string, selectionRevision, headVersion int64, contentHash string, itemCount, byteSize int64, syncedAt time.Time) error {
	if !canonicalUUID(grantID) || !canonicalUUID(selectionID) || !canonicalUUID(resourceID) || selectionRevision < 1 || headVersion < 1 || itemCount < 0 || byteSize < 0 || !validSHA256Hex(contentHash) {
		return errors.New("selection snapshot metadata rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE selections SET readiness='available',head_version=?,content_hash=?,item_count=?,byte_size=?,last_synced_at=?,error_code=''
		WHERE grant_id=? AND selection_id=? AND module=? AND resource_type=? AND resource_id=?
		  AND (SELECT selection_revision FROM grants WHERE grant_id=?)=?`,
		headVersion, contentHash, itemCount, byteSize, syncedAt.UTC().UnixMilli(), grantID, selectionID, module, resourceType, resourceID, grantID, selectionRevision)
	if err != nil {
		return err
	}
	if rows, _ := result.RowsAffected(); rows != 1 {
		return errors.New("stale or mismatched selection snapshot")
	}
	return nil
}

func (s *Store) MarkSelectionPreparing(ctx context.Context, grantID, selectionID string) error {
	if !canonicalUUID(grantID) || !canonicalUUID(selectionID) {
		return errors.New("selection identity rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE selections SET readiness='preparing',error_code='' WHERE grant_id=? AND selection_id=?`, grantID, selectionID)
	if err != nil {
		return err
	}
	if rows, _ := result.RowsAffected(); rows != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) MarkSelectionError(ctx context.Context, grantID, selectionID, code string) error {
	if !canonicalUUID(grantID) || !canonicalUUID(selectionID) || strings.TrimSpace(code) == "" || len(code) > 100 {
		return errors.New("selection error state rejected")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE selections SET readiness='error',error_code=? WHERE grant_id=? AND selection_id=?`, code, grantID, selectionID)
	if err != nil {
		return err
	}
	if rows, _ := result.RowsAffected(); rows != 1 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteSelection(ctx context.Context, grantID, selectionID string) error {
	if !canonicalUUID(grantID) || !canonicalUUID(selectionID) {
		return errors.New("selection identity rejected")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM selections WHERE grant_id=? AND selection_id=?`, grantID, selectionID)
	return err
}

func (s *Store) Selections(ctx context.Context, grantID, module, afterSelectionID string, limit int) ([]Selection, string, error) {
	if module != "tasks" && module != "contacts" && module != "programs" && module != "whiteboards" {
		return nil, "", errors.New("selection module rejected")
	}
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT selection_id FROM selections WHERE grant_id=? AND module=? AND selection_id>? ORDER BY selection_id LIMIT ?`, grantID, module, afterSelectionID, limit+1)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	ids := make([]string, 0, limit+1)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, "", err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	next := ""
	if len(ids) > limit {
		next = ids[limit-1]
		ids = ids[:limit]
	}
	result := make([]Selection, 0, len(ids))
	for _, id := range ids {
		item, err := s.Selection(ctx, grantID, id)
		if err != nil {
			return nil, "", err
		}
		result = append(result, *item)
	}
	return result, next, nil
}

func (s *Store) AllocateSequence(ctx context.Context, grantID string) (int64, error) {
	var sequence int64
	err := s.db.QueryRowContext(ctx, `UPDATE grants SET next_sequence=next_sequence+1 WHERE grant_id=? RETURNING next_sequence-1`, grantID).Scan(&sequence)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return sequence, err
}

func (s *Store) CheckUnlock(ctx context.Context, grantID string, now time.Time) (time.Duration, error) {
	if err := s.CheckClock(ctx, now); err != nil {
		return 0, err
	}
	var nextAllowed, lastAttempt int64
	err := s.db.QueryRowContext(ctx, `SELECT next_allowed_at,last_attempt_at FROM unlock_throttle WHERE grant_id=?`, grantID).Scan(&nextAllowed, &lastAttempt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	nowMillis := now.UTC().UnixMilli()
	if lastAttempt > 0 && nowMillis < lastAttempt-int64((2*time.Minute)/time.Millisecond) {
		_, _ = s.db.ExecContext(ctx, `UPDATE unlock_throttle SET next_allowed_at=? WHERE grant_id=?`, now.Add(15*time.Minute).UnixMilli(), grantID)
		return 15 * time.Minute, ErrClockRollback
	}
	if nextAllowed > nowMillis {
		return time.Duration(nextAllowed-nowMillis) * time.Millisecond, ErrUnlockThrottled
	}
	return 0, nil
}

func (s *Store) RecordUnlockFailure(ctx context.Context, grantID string, now time.Time) (time.Duration, error) {
	var failures int
	err := s.db.QueryRowContext(ctx, `UPDATE unlock_throttle SET failures=failures+1,last_attempt_at=? WHERE grant_id=? RETURNING failures`, now.UTC().UnixMilli(), grantID).Scan(&failures)
	if err != nil {
		return 0, err
	}
	delay := time.Second << minInt(failures-1, 9)
	if delay > 15*time.Minute {
		delay = 15 * time.Minute
	}
	_, err = s.db.ExecContext(ctx, `UPDATE unlock_throttle SET next_allowed_at=? WHERE grant_id=?`, now.Add(delay).UTC().UnixMilli(), grantID)
	return delay, err
}

func (s *Store) RecordUnlockSuccess(ctx context.Context, grantID string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE unlock_throttle SET failures=0,next_allowed_at=0,last_attempt_at=? WHERE grant_id=?`, now.UTC().UnixMilli(), grantID)
	return err
}

func (s *Store) protectPrivate(key *ecdsa.PrivateKey, purpose string) ([]byte, error) {
	raw, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	defer zero(raw)
	return s.protector.Protect(raw, purpose)
}

func (s *Store) unprotectPrivate(protected []byte, purpose string) (*ecdsa.PrivateKey, error) {
	raw, err := s.protector.Unprotect(protected, purpose)
	if err != nil {
		return nil, err
	}
	defer zero(raw)
	parsed, err := x509.ParsePKCS8PrivateKey(raw)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok || key.Curve != elliptic.P256() {
		return nil, errors.New("service key is not P-256")
	}
	return key, nil
}

func (s *Store) protectOptional(value []byte, purpose string) ([]byte, error) {
	if len(value) == 0 {
		return []byte{}, nil
	}
	return s.protector.Protect(value, purpose)
}

func (s *Store) unprotectOptional(value []byte, purpose string) ([]byte, error) {
	if len(value) == 0 {
		return nil, nil
	}
	return s.protector.Unprotect(value, purpose)
}

func validateOrigin(raw string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Clarin origin must be an HTTPS origin without path")
	}
	parsed.Path = ""
	return parsed.String(), nil
}

func millis(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UTC().UnixMilli()
}

func fromMillis(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func nonNil(value []byte) []byte {
	if value == nil {
		return []byte{}
	}
	return value
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}

func validSHA256Hex(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// EncodeProtectedProof is used only for bounded, non-PII service proofs. It is
// intentionally not a general-purpose storage API.
func EncodeProtectedProof(value []byte) string { return base64.RawURLEncoding.EncodeToString(value) }
