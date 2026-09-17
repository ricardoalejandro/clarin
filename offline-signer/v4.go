package main

import (
	"crypto/ecdsa"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

type v4Signer struct {
	key          *ecdsa.PrivateKey
	keys         []jose.JSONWebKey
	version      int
	serverOrigin string
	now          func() time.Time
}

type v4Lease struct {
	Issuer                    string   `json:"iss"`
	Audience                  string   `json:"aud"`
	IssuedAt                  int64    `json:"iat"`
	NotBefore                 int64    `json:"nbf"`
	ExpiresAt                 int64    `json:"exp"`
	ID                        string   `json:"jti"`
	Version                   int      `json:"version"`
	BrowserProfileID          string   `json:"browser_profile_id"`
	UserID                    string   `json:"user_id"`
	AccountID                 string   `json:"account_id"`
	GrantID                   string   `json:"grant_id"`
	CredentialEpoch           int64    `json:"credential_epoch"`
	AuthorityEpoch            int64    `json:"authority_epoch"`
	GrantRevision             int64    `json:"grant_revision"`
	SelectionRevision         int64    `json:"selection_revision"`
	SelectionDigest           string   `json:"selection_digest"`
	Actions                   []string `json:"actions"`
	MaxStorageBytes           int64    `json:"max_storage_bytes"`
	BrowserKeyThumbprint      string   `json:"browser_key_thumbprint"`
	GrantSigningKeyThumbprint string   `json:"grant_signing_key_thumbprint"`
	LoginBindingSHA256        string   `json:"login_binding_sha256"`
}

func validV4Origin(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" || u.String() != value {
		return false
	}
	return u.Scheme == "https" || u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}

func v4KeyID(version int) string { return fmt.Sprintf("clarin-offline-v4-leases-%d", version) }

func loadV4Signer(directory, versionText, origin string) (*v4Signer, error) {
	if origin == "" {
		origin = "https://clarin.naperu.cloud"
	}
	if !validV4Origin(origin) {
		return nil, errors.New("invalid v4 server origin")
	}
	version := 4
	if versionText != "" {
		var err error
		version, err = strconv.Atoi(versionText)
		if err != nil || version < 4 || version > 1000000 {
			return nil, errors.New("invalid v4 key version")
		}
	}
	paths, err := filepath.Glob(filepath.Join(directory, "offline-v4-leases-*.key"))
	if err != nil {
		return nil, err
	}
	for _, path := range paths {
		v, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "offline-v4-leases-"), ".key"))
		if err != nil || v < 4 || v > version {
			return nil, errors.New("invalid v4 key history or downgrade")
		}
	}
	key, err := loadOrCreateKey(filepath.Join(directory, fmt.Sprintf("offline-v4-leases-%d.key", version)))
	if err != nil {
		return nil, err
	}
	paths, err = filepath.Glob(filepath.Join(directory, "offline-v4-leases-*.key"))
	if err != nil {
		return nil, err
	}
	keys := []jose.JSONWebKey{}
	for _, path := range paths {
		v, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "offline-v4-leases-"), ".key"))
		old, err := loadOrCreateKey(path)
		if err != nil {
			return nil, err
		}
		keys = append(keys, jose.JSONWebKey{Key: &old.PublicKey, KeyID: v4KeyID(v), Algorithm: string(jose.ES256), Use: "sig"})
	}
	return &v4Signer{key: key, keys: keys, version: version, serverOrigin: origin, now: time.Now}, nil
}

func (s *v4Signer) publicKeys(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, jose.JSONWebKeySet{Keys: s.keys})
}

func (s *v4Signer) validateLease(l v4Lease) bool {
	now := s.now().Unix()
	if l.Issuer != "clarin-offline-v4" || l.Audience != s.serverOrigin || l.Version != 4 || l.IssuedAt < now-60 || l.IssuedAt > now+60 || l.NotBefore != l.IssuedAt || l.ExpiresAt <= l.IssuedAt || l.ExpiresAt-l.IssuedAt > 86400 {
		return false
	}
	for _, id := range []string{l.ID, l.BrowserProfileID, l.UserID, l.AccountID, l.GrantID} {
		if !validV3ID(id) {
			return false
		}
	}
	for _, revision := range []int64{l.CredentialEpoch, l.AuthorityEpoch, l.GrantRevision, l.SelectionRevision} {
		if revision < 1 {
			return false
		}
	}
	if l.MaxStorageBytes < 1<<20 || l.MaxStorageBytes > 5<<30 || !validThumbprint(l.BrowserKeyThumbprint) || !validThumbprint(l.GrantSigningKeyThumbprint) || l.BrowserKeyThumbprint == l.GrantSigningKeyThumbprint {
		return false
	}
	for _, h := range []string{l.SelectionDigest, l.LoginBindingSHA256} {
		raw, err := hex.DecodeString(h)
		if err != nil || len(raw) != 32 || hex.EncodeToString(raw) != h {
			return false
		}
	}
	if len(l.Actions) < 1 || len(l.Actions) > 6 {
		return false
	}
	seen := map[string]bool{}
	for _, action := range l.Actions {
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

func (s *v4Signer) signLease(w http.ResponseWriter, r *http.Request) {
	var lease v4Lease
	if decodeV3Request(w, r, &lease) != nil || !s.validateLease(lease) {
		writeJSON(w, 400, map[string]string{"error": "invalid_offline_v4_lease"})
		return
	}
	options := new(jose.SignerOptions).WithType("clarin-offline-v4-lease+jwt").WithHeader("kid", v4KeyID(s.version))
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: s.key}, options)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "offline_signing_failed"})
		return
	}
	raw, err := json.Marshal(lease)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "offline_signing_failed"})
		return
	}
	signed, err := signer.Sign(raw)
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "offline_signing_failed"})
		return
	}
	token, err := signed.CompactSerialize()
	if err != nil {
		writeJSON(w, 500, map[string]string{"error": "offline_signing_failed"})
		return
	}
	writeJSON(w, 200, map[string]any{"token": token, "key_id": v4KeyID(s.version), "key_version": s.version})
}
