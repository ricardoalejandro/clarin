package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const (
	OfflineV3ProtocolVersion = 3
	OfflineV3MaxLeaseSeconds = 72 * 60 * 60
	OfflineV3MaxResources    = 20
	OfflineV3MaxAccounts     = 5

	OfflineV3ActionTasksRead       = "tasks.read"
	OfflineV3ActionTasksCreate     = "tasks.create"
	OfflineV3ActionTasksComplete   = "tasks.complete"
	OfflineV3ActionContactsRead    = "contacts.read"
	OfflineV3ActionProgramsRead    = "programs.read"
	OfflineV3ActionWhiteboardsRead = "whiteboards.read"
)

var OfflineV3ActionModule = map[string]string{
	OfflineV3ActionTasksRead:       OfflineModuleTasks,
	OfflineV3ActionTasksCreate:     OfflineModuleTasks,
	OfflineV3ActionTasksComplete:   OfflineModuleTasks,
	OfflineV3ActionContactsRead:    OfflineModuleContacts,
	OfflineV3ActionProgramsRead:    OfflineModulePrograms,
	OfflineV3ActionWhiteboardsRead: OfflineModuleWhiteboards,
}

type OfflineV3JWK struct {
	Kty string `json:"kty"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
	Use string `json:"use,omitempty"`
	Alg string `json:"alg,omitempty"`
	Kid string `json:"kid,omitempty"`
}

type OfflineV3Tuple struct {
	InstallationID     uuid.UUID `json:"installation_id"`
	WindowsPrincipalID uuid.UUID `json:"windows_principal_id"`
	BrowserProfileID   uuid.UUID `json:"browser_profile_id"`
	AuthorizationID    uuid.UUID `json:"authorization_id"`
	GrantID            uuid.UUID `json:"grant_id"`
	UserID             uuid.UUID `json:"user_id"`
	AccountID          uuid.UUID `json:"account_id"`
}

type OfflineV3EnrollmentRequest struct {
	ID                        uuid.UUID  `json:"id"`
	InstallationID            uuid.UUID  `json:"installation_id"`
	WindowsPrincipalID        uuid.UUID  `json:"windows_principal_id"`
	BrowserProfileID          uuid.UUID  `json:"browser_profile_id"`
	AuthorizationID           uuid.UUID  `json:"authorization_id"`
	UserID                    uuid.UUID  `json:"user_id"`
	UserDisplayName           string     `json:"user_display_name,omitempty"`
	DisplayName               string     `json:"display_name"`
	PrincipalDisplayName      string     `json:"principal_display_name"`
	InstallationKeyThumbprint string     `json:"installation_key_thumbprint"`
	ServiceKeyThumbprint      string     `json:"service_key_thumbprint"`
	BrowserKeyThumbprint      string     `json:"browser_key_thumbprint"`
	ClientVersion             string     `json:"client_version"`
	State                     string     `json:"state"`
	RequestedAt               time.Time  `json:"requested_at"`
	DecidedAt                 *time.Time `json:"decided_at,omitempty"`
	DecidedBy                 *uuid.UUID `json:"decided_by,omitempty"`
}

type OfflineV3Grant struct {
	OfflineV3Tuple
	UserDisplayName           string     `json:"display_user"`
	AccountName               string     `json:"account_name"`
	State                     string     `json:"state"`
	Actions                   []string   `json:"actions"`
	EffectiveActions          []string   `json:"effective_actions"`
	MaxResources              int        `json:"max_resources"`
	QuotaBytes                int64      `json:"quota_bytes"`
	MaxOfflineSeconds         int        `json:"max_offline_seconds"`
	CredentialEpoch           int64      `json:"credential_epoch"`
	AuthorityEpoch            int64      `json:"authority_epoch"`
	InstallationRevision      int64      `json:"installation_revision"`
	PrincipalRevision         int64      `json:"principal_revision"`
	BrowserRevision           int64      `json:"browser_revision"`
	AuthorizationRevision     int64      `json:"authorization_revision"`
	GrantRevision             int64      `json:"grant_revision"`
	SelectionRevision         int64      `json:"selection_revision"`
	SelectionDigest           string     `json:"selection_digest"`
	BrowserKeyThumbprint      string     `json:"browser_key_thumbprint"`
	GrantSigningThumbprint    string     `json:"grant_signing_key_thumbprint,omitempty"`
	GrantEncryptionThumbprint string     `json:"grant_encryption_key_thumbprint,omitempty"`
	KeysReady                 bool       `json:"keys_ready"`
	CreatedAt                 time.Time  `json:"created_at"`
	UpdatedAt                 time.Time  `json:"updated_at"`
	LastLeaseExpiresAt        *time.Time `json:"lease_expires_at,omitempty"`
	LastSyncAt                *time.Time `json:"last_sync_at,omitempty"`
}

type OfflineV3Selection struct {
	ID           uuid.UUID `json:"selection_id"`
	GrantID      uuid.UUID `json:"grant_id,omitempty"`
	AccountID    uuid.UUID `json:"account_id,omitempty"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   uuid.UUID `json:"resource_id"`
	Label        string    `json:"label,omitempty"`
	HeadVersion  int64     `json:"head_version"`
	ContentHash  string    `json:"content_hash,omitempty"`
	UpdatedAt    time.Time `json:"updated_at,omitempty"`
}

type OfflineV3Snapshot struct {
	ProtocolVersion   int             `json:"protocol_version"`
	GrantID           uuid.UUID       `json:"grant_id"`
	UserID            uuid.UUID       `json:"user_id"`
	AccountID         uuid.UUID       `json:"account_id"`
	SelectionID       uuid.UUID       `json:"selection_id"`
	Module            string          `json:"module"`
	ResourceType      string          `json:"resource_type"`
	ResourceID        uuid.UUID       `json:"resource_id"`
	SelectionRevision int64           `json:"selection_revision"`
	HeadVersion       int64           `json:"head_version"`
	ContentHash       string          `json:"content_hash"`
	Payload           json.RawMessage `json:"payload"`
	Tombstone         bool            `json:"tombstone"`
	GeneratedAt       time.Time       `json:"generated_at"`
}

type OfflineV3Operation struct {
	ProtocolVersion      int             `json:"protocol_version"`
	GrantID              uuid.UUID       `json:"grant_id"`
	UserID               uuid.UUID       `json:"user_id"`
	AccountID            uuid.UUID       `json:"account_id"`
	BrowserProfileID     uuid.UUID       `json:"browser_profile_id"`
	OperationID          uuid.UUID       `json:"operation_id"`
	Action               string          `json:"action"`
	SelectionID          uuid.UUID       `json:"selection_id"`
	ResourceID           uuid.UUID       `json:"resource_id"`
	SelectionRevision    int64           `json:"selection_revision"`
	CredentialEpoch      int64           `json:"credential_epoch"`
	AuthorityEpoch       int64           `json:"authority_epoch"`
	BaseVersion          int64           `json:"base_version"`
	DependsOnOperationID *uuid.UUID      `json:"depends_on_operation_id,omitempty"`
	Payload              json.RawMessage `json:"payload"`
	OccurredAt           time.Time       `json:"occurred_at"`
}

type OfflineV3OperationResult struct {
	OperationID   uuid.UUID       `json:"operation_id"`
	Status        string          `json:"status"`
	ErrorCode     string          `json:"error_code,omitempty"`
	ResourceID    uuid.UUID       `json:"resource_id,omitempty"`
	ServerVersion int64           `json:"server_version,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}

type OfflineV3Control struct {
	ID             uuid.UUID  `json:"id"`
	InstallationID uuid.UUID  `json:"installation_id"`
	GrantID        *uuid.UUID `json:"grant_id,omitempty"`
	AccountID      *uuid.UUID `json:"account_id,omitempty"`
	Scope          string     `json:"scope"`
	ScopeID        uuid.UUID  `json:"scope_id"`
	Revision       int64      `json:"revision"`
	Action         string     `json:"action"`
	Reason         string     `json:"reason"`
	Token          string     `json:"token"`
	KeyID          string     `json:"key_id"`
	KeyVersion     int        `json:"key_version"`
	CreatedAt      time.Time  `json:"created_at"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
}
