package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const (
	OfflineV4ProtocolVersion = 4
	OfflineV4MaxLeaseSeconds = 24 * 60 * 60
	OfflineV4MaxResources    = 20
)

// OfflineV4Tuple identifies a browser registration, never a Windows principal
// or an attested physical computer. It is immutable for the life of a grant.
type OfflineV4Tuple struct {
	BrowserProfileID uuid.UUID `json:"browser_profile_id"`
	UserID           uuid.UUID `json:"user_id"`
	AccountID        uuid.UUID `json:"account_id"`
	GrantID          uuid.UUID `json:"grant_id"`
}

type OfflineV4Grant struct {
	OfflineV4Tuple
	AccountName       string    `json:"account_name"`
	Username          string    `json:"username"`
	BrowserName       string    `json:"browser_name"`
	DisplayName       string    `json:"display_name"`
	State             string    `json:"state"`
	Actions           []string  `json:"actions"`
	MaxResources      int       `json:"max_resources"`
	QuotaBytes        int64     `json:"quota_bytes"`
	MaxOfflineSeconds int       `json:"max_offline_seconds"`
	Revision          int64     `json:"revision"`
	SelectionRevision int64     `json:"selection_revision"`
	SelectionDigest   string    `json:"selection_digest"`
	CredentialEpoch   int64     `json:"credential_epoch"`
	AuthorityEpoch    int64     `json:"authority_epoch"`
	CreatedAt         time.Time `json:"created_at"`
}

type OfflineV4Enrollment struct {
	ID               uuid.UUID          `json:"id"`
	BrowserProfileID uuid.UUID          `json:"browser_profile_id"`
	UserID           uuid.UUID          `json:"user_id"`
	Username         string             `json:"username"`
	BrowserName      string             `json:"browser_name"`
	DisplayName      string             `json:"display_name"`
	State            string             `json:"state"`
	RequestedAt      time.Time          `json:"requested_at"`
	Accounts         []OfflineV4Account `json:"accounts"`
}

type OfflineV4Account struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

type OfflineV4Challenge struct {
	ID        uuid.UUID `json:"challenge_id"`
	Nonce     string    `json:"nonce"`
	ExpiresAt time.Time `json:"expires_at"`
}

type OfflineV4Lease struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	ExpiresAt int64  `json:"exp"`
	ID        string `json:"jti"`
	Version   int    `json:"version"`
	OfflineV4Tuple
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

// Resource payloads retain the v3 allow-listed module projection, not its
// transport or native authority. ProtocolVersion is always 4 on this wire.
type OfflineV4Snapshot struct {
	OfflineV4Tuple
	ProtocolVersion   int             `json:"protocol_version"`
	SelectionID       uuid.UUID       `json:"selection_id"`
	Module            string          `json:"module"`
	ResourceType      string          `json:"resource_type"`
	ResourceID        uuid.UUID       `json:"resource_id"`
	SelectionRevision int64           `json:"selection_revision"`
	HeadVersion       int64           `json:"head_version"`
	ContentHash       string          `json:"content_hash"`
	Payload           json.RawMessage `json:"payload"`
	PayloadJSON       string          `json:"payload_json"`
	Tombstone         bool            `json:"tombstone"`
	GeneratedAt       time.Time       `json:"generated_at"`
}
