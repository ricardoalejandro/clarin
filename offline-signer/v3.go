package main

import (
	"bytes"
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

// v3 uses a separate key from the legacy sign-any-digest interface. A v1
// signature can never authorize a v3 lease or control, even with equal claims.
type v3Signer struct {
	key          *ecdsa.PrivateKey
	version      int
	keys         []jose.JSONWebKey
	now          func() time.Time
	intakeKeys   map[string]*ecdsa.PrivateKey
	serverOrigin string
}

const (
	v3Issuer                = "clarin-offline-v3"
	v3MaxLeaseSeconds int64 = 72 * 60 * 60
	v3MaxStorageBytes int64 = 5 * 1024 * 1024 * 1024
)

type v3Lease struct {
	Issuer                       string   `json:"iss"`
	Audience                     string   `json:"aud"`
	IssuedAt                     int64    `json:"iat"`
	NotBefore                    int64    `json:"nbf"`
	ExpiresAt                    int64    `json:"exp"`
	ID                           string   `json:"jti"`
	Version                      int      `json:"version"`
	InstallationID               string   `json:"installation_id"`
	WindowsPrincipalID           string   `json:"windows_principal_id"`
	BrowserProfileID             string   `json:"browser_profile_id"`
	AuthorizationID              string   `json:"authorization_id"`
	GrantID                      string   `json:"grant_id"`
	UserID                       string   `json:"user_id"`
	AccountID                    string   `json:"account_id"`
	LoginBindingSHA256           string   `json:"login_binding_sha256"`
	CredentialEpoch              int64    `json:"credential_epoch"`
	AuthorityEpoch               int64    `json:"authority_epoch"`
	InstallationRevision         int64    `json:"installation_revision"`
	PrincipalRevision            int64    `json:"principal_revision"`
	BrowserRevision              int64    `json:"browser_revision"`
	AuthorizationRevision        int64    `json:"authorization_revision"`
	GrantRevision                int64    `json:"grant_revision"`
	SelectionRevision            int64    `json:"selection_revision"`
	SelectionDigest              string   `json:"selection_digest"`
	Actions                      []string `json:"actions"`
	MaxStorageBytes              int64    `json:"max_storage_bytes"`
	BrowserKeyThumbprint         string   `json:"browser_key_thumbprint"`
	GrantSigningKeyThumbprint    string   `json:"grant_signing_key_thumbprint,omitempty"`
	GrantEncryptionKeyThumbprint string   `json:"grant_encryption_key_thumbprint,omitempty"`
}

// Controls contain only opaque identifiers and fixed reason codes, never data
// from a resource. They remain deliverable after its read permission is gone.
type v3Control struct {
	Issuer         string `json:"iss"`
	Audience       string `json:"aud"`
	IssuedAt       int64  `json:"iat"`
	NotBefore      int64  `json:"nbf"`
	ExpiresAt      int64  `json:"exp"`
	ID             string `json:"jti"`
	Version        int    `json:"version"`
	InstallationID string `json:"installation_id"`
	Scope          string `json:"scope"`
	ScopeID        string `json:"scope_id"`
	Revision       int64  `json:"revision"`
	Action         string `json:"action"`
	Reason         string `json:"reason"`
}

var v3UUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func validV3ID(id string) bool {
	return v3UUID.MatchString(id) && id != "00000000-0000-0000-0000-000000000000"
}

func v3KeyID(version int) string { return fmt.Sprintf("clarin-offline-v3-leases-%d", version) }

func loadV3Signer(directory, configuredVersion string) (*v3Signer, error) {
	version := 3
	if configuredVersion != "" {
		parsed, err := strconv.Atoi(configuredVersion)
		if err != nil || parsed < 3 || parsed > 1000000 {
			return nil, errors.New("invalid v3 signing key version")
		}
		version = parsed
	}
	paths, err := filepath.Glob(filepath.Join(directory, "offline-v3-leases-*.key"))
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		oldVersion, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "offline-v3-leases-"), ".key"))
		if err != nil || oldVersion < 3 {
			return nil, errors.New("invalid v3 signing key filename")
		}
		if oldVersion > version {
			return nil, errors.New("refusing v3 signing key downgrade")
		}
	}
	keyPath := filepath.Join(directory, fmt.Sprintf("offline-v3-leases-%d.key", version))
	key, err := loadOrCreateKey(keyPath)
	if err != nil {
		return nil, err
	}
	paths, err = filepath.Glob(filepath.Join(directory, "offline-v3-leases-*.key"))
	if err != nil {
		return nil, err
	}
	s := &v3Signer{key: key, version: version, now: time.Now}
	s.serverOrigin = os.Getenv("OFFLINE_V3_SERVER_ORIGIN")
	if s.serverOrigin == "" {
		s.serverOrigin = "https://clarin.naperu.cloud"
	}
	if !validV3Origin(s.serverOrigin) {
		return nil, errors.New("invalid v3 server origin")
	}
	for _, path := range paths {
		oldVersion, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "offline-v3-leases-"), ".key"))
		oldKey, err := loadOrCreateKey(path)
		if err != nil {
			return nil, err
		}
		s.keys = append(s.keys, jose.JSONWebKey{Key: &oldKey.PublicKey, KeyID: v3KeyID(oldVersion), Use: "sig", Algorithm: string(jose.ES256)})
	}
	sort.Slice(s.keys, func(i, j int) bool { return s.keys[i].KeyID < s.keys[j].KeyID })
	s.intakeKeys, err = loadV3IntakeKeys(directory, version)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (s *v3Signer) publicKeys(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"keys": s.keys, "key_id": v3KeyID(s.version), "key_version": s.version})
}

func (s *v3Signer) validTime(issuer, audience, expected, id string, version int, issuedAt, notBefore, expiresAt int64) bool {
	now := s.now().Unix()
	return issuer == v3Issuer && audience == expected && validV3ID(id) && version == 3 &&
		issuedAt >= now-300 && issuedAt <= now+30 && notBefore >= issuedAt-30 && notBefore <= issuedAt &&
		expiresAt > now && expiresAt > issuedAt && expiresAt-issuedAt <= v3MaxLeaseSeconds
}

func validThumbprint(value string) bool {
	raw, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(raw) == 32 && base64.RawURLEncoding.EncodeToString(raw) == value
}

func (s *v3Signer) validateLease(lease v3Lease) bool {
	return s.validateGrantAuthority(lease, "clarin-offline-unlock", v3MaxLeaseSeconds, true)
}

func (s *v3Signer) validateGrantAuthority(lease v3Lease, audience string, maxSeconds int64, requireGrantKeys bool) bool {
	if !s.validTime(lease.Issuer, lease.Audience, audience, lease.ID, lease.Version, lease.IssuedAt, lease.NotBefore, lease.ExpiresAt) || lease.ExpiresAt-lease.IssuedAt > maxSeconds {
		return false
	}
	for _, id := range []string{lease.InstallationID, lease.WindowsPrincipalID, lease.BrowserProfileID, lease.AuthorizationID, lease.GrantID, lease.UserID, lease.AccountID} {
		if !validV3ID(id) {
			return false
		}
	}
	for _, revision := range []int64{lease.CredentialEpoch, lease.AuthorityEpoch, lease.InstallationRevision, lease.PrincipalRevision, lease.BrowserRevision, lease.AuthorizationRevision, lease.GrantRevision, lease.SelectionRevision} {
		if revision < 1 {
			return false
		}
	}
	if lease.MaxStorageBytes < 1 || lease.MaxStorageBytes > v3MaxStorageBytes {
		return false
	}
	digest, err := hex.DecodeString(lease.SelectionDigest)
	if err != nil || len(digest) != 32 || hex.EncodeToString(digest) != lease.SelectionDigest {
		return false
	}
	// Match the authenticated canonical login exactly. An identifier is not an
	// additional secret, but a selected grant alone must not choose identity.
	loginDigest, err := hex.DecodeString(lease.LoginBindingSHA256)
	if err != nil || len(loginDigest) != 32 || hex.EncodeToString(loginDigest) != lease.LoginBindingSHA256 {
		return false
	}
	thumbprints := []string{lease.BrowserKeyThumbprint}
	if requireGrantKeys {
		thumbprints = append(thumbprints, lease.GrantSigningKeyThumbprint, lease.GrantEncryptionKeyThumbprint)
	}
	for _, thumbprint := range thumbprints {
		if !validThumbprint(thumbprint) {
			return false
		}
	}
	// Different purpose keys are mandatory; sharing a key couples operation
	// signing, browser possession and data decryption across trust boundaries.
	if requireGrantKeys && (lease.BrowserKeyThumbprint == lease.GrantSigningKeyThumbprint || lease.BrowserKeyThumbprint == lease.GrantEncryptionKeyThumbprint || lease.GrantSigningKeyThumbprint == lease.GrantEncryptionKeyThumbprint) {
		return false
	}
	if !requireGrantKeys && (lease.GrantSigningKeyThumbprint != "" || lease.GrantEncryptionKeyThumbprint != "") {
		return false
	}
	if len(lease.Actions) < 1 || len(lease.Actions) > 6 {
		return false
	}
	seen := make(map[string]bool, len(lease.Actions))
	for _, action := range lease.Actions {
		switch action {
		case "tasks.read", "tasks.create", "tasks.complete", "contacts.read", "programs.read", "whiteboards.read":
		default:
			return false
		}
		if seen[action] {
			return false
		}
		seen[action] = true
	}
	return !(seen["tasks.create"] || seen["tasks.complete"]) || seen["tasks.read"]
}

func (s *v3Signer) signLease(w http.ResponseWriter, r *http.Request) {
	var lease v3Lease
	if decodeV3Request(w, r, &lease) != nil || !s.validateLease(lease) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_lease"})
		return
	}
	s.signTyped(w, lease, "clarin-offline-lease+jwt")
}

func (s *v3Signer) signGrantBootstrap(w http.ResponseWriter, r *http.Request) {
	var bootstrap v3Lease
	if decodeV3Request(w, r, &bootstrap) != nil || !s.validateGrantAuthority(bootstrap, "clarin-offline-local-service", 600, false) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_grant_bootstrap"})
		return
	}
	s.signTyped(w, bootstrap, "clarin-offline-grant-bootstrap+jwt")
}

func (s *v3Signer) signControl(w http.ResponseWriter, r *http.Request) {
	var control v3Control
	if decodeV3Request(w, r, &control) != nil || !s.validTime(control.Issuer, control.Audience, "clarin-offline-control", control.ID, control.Version, control.IssuedAt, control.NotBefore, control.ExpiresAt) || !validV3ID(control.InstallationID) || !validV3ID(control.ScopeID) || control.Revision < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_control"})
		return
	}
	valid := true
	switch control.Scope {
	case "installation", "windows_principal", "browser_profile", "authorization", "grant", "selection":
	default:
		valid = false
	}
	switch control.Action {
	case "lock", "wipe":
	default:
		valid = false
	}
	switch control.Reason {
	case "admin_revoked", "credential_changed", "authority_changed", "account_disabled", "user_disabled", "selection_removed", "security_lock":
	default:
		valid = false
	}
	if control.Scope == "installation" && control.ScopeID != control.InstallationID {
		valid = false
	}
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_control"})
		return
	}
	s.signTyped(w, control, "clarin-offline-control+jwt")
}

func (s *v3Signer) signTyped(w http.ResponseWriter, value any, typ string) {
	keyID := v3KeyID(s.version)
	options := new(jose.SignerOptions).WithType(jose.ContentType(typ)).WithHeader("kid", keyID)
	js, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: s.key}, options)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "offline_signing_failed"})
		return
	}
	raw, err := json.Marshal(value)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "offline_signing_failed"})
		return
	}
	signed, err := js.Sign(raw)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "offline_signing_failed"})
		return
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "offline_signing_failed"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "key_id": keyID, "key_version": s.version})
}

// Reject ambiguous representations (duplicates, unknown/case-folded names,
// extra documents). Never sign a user-supplied digest or raw claim map in v3.
func decodeV3Request(w http.ResponseWriter, r *http.Request, value any) error {
	return decodeV3RequestLimit(w, r, value, 16384)
}

func decodeV3RequestLimit(w http.ResponseWriter, r *http.Request, value any, limit int64) error {
	return decodeV3RequestBounds(w, r, value, limit, 4)
}

func decodeV3RequestBounds(w http.ResponseWriter, r *http.Request, value any, limit int64, maxDepth int) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := checkV3JSONValueDepth(decoder, 0, maxDepth); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return errors.New("object required")
	}
	typeOf := reflect.TypeOf(value)
	if typeOf.Kind() != reflect.Pointer || typeOf.Elem().Kind() != reflect.Struct {
		return errors.New("typed request required")
	}
	typeOf = typeOf.Elem()
	allowed := make(map[string]bool, typeOf.NumField())
	for i := 0; i < typeOf.NumField(); i++ {
		field := typeOf.Field(i)
		name := strings.Split(field.Tag.Get("json"), ",")[0]
		if name != "" && name != "-" {
			allowed[name] = true
		}
	}
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return errors.New("unknown field")
		}
	}
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	return decoder.Decode(value)
}

func checkV3JSONValue(decoder *json.Decoder, depth int) error {
	return checkV3JSONValueDepth(decoder, depth, 4)
}

func checkV3JSONValueDepth(decoder *json.Decoder, depth, maxDepth int) error {
	if depth > maxDepth {
		return errors.New("nested JSON")
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			if !ok || seen[name] {
				return errors.New("duplicate field")
			}
			seen[name] = true
			if err := checkV3JSONValueDepth(decoder, depth+1, maxDepth); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := checkV3JSONValueDepth(decoder, depth+1, maxDepth); err != nil {
				return err
			}
		}
	default:
		return errors.New("invalid JSON delimiter")
	}
	_, err = decoder.Token()
	return err
}
