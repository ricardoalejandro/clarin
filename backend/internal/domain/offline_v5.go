package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const (
	OfflineV5ProtocolVersion = 5
	OfflineV5MaxLeaseSeconds = 24 * 60 * 60
	OfflineV5MaxResources    = 20

	OfflineV5ActionTasksRead                    = "tasks.read"
	OfflineV5ActionTasksCreate                  = "tasks.create"
	OfflineV5ActionTasksUpdate                  = "tasks.update"
	OfflineV5ActionTasksComplete                = "tasks.complete"
	OfflineV5ActionTasksReopen                  = "tasks.reopen"
	OfflineV5ActionTasksComment                 = "tasks.comments.create"
	OfflineV5ActionContactsRead                 = "contacts.read"
	OfflineV5ActionContactsUpdate               = "contacts.update"
	OfflineV5ActionContactsObserve              = "contacts.observations.create"
	OfflineV5ActionProgramsRead                 = "programs.read"
	OfflineV5ActionProgramsUpdate               = "programs.update"
	OfflineV5ActionProgramsParticipantAdd       = "programs.participants.add"
	OfflineV5ActionProgramsParticipantLifecycle = "programs.participants.lifecycle.update"
	OfflineV5ActionProgramsSessionUpsert        = "programs.sessions.upsert"
	OfflineV5ActionProgramsAttendance           = "programs.attendance.set"
	OfflineV5ActionProgramsObservation          = "programs.observations.create"
	OfflineV5ActionProgramsGoals                = "programs.goals.update"
	OfflineV5ActionBoardsRead                   = "whiteboards.read"
	OfflineV5ActionBoardsScene                  = "whiteboards.scene.update"
)

// OfflineV5Grant deliberately authorizes modules, not a client-provided list
// of mutations. Effective mutation capabilities are recalculated from the
// actor's live module/resource ACL every time a manifest is prepared or an
// operation is synchronized.
type OfflineV5Grant struct {
	OfflineV4Grant
	Modules      []string `json:"modules"`
	Capabilities []string `json:"capabilities"`
	V5Revision   int64    `json:"v5_revision"`
}

type OfflineV5Capability struct {
	Action         string    `json:"action"`
	SelectionID    uuid.UUID `json:"selection_id"`
	RootResourceID uuid.UUID `json:"root_resource_id"`
	ResourceType   string    `json:"resource_type"`
	ResourceID     uuid.UUID `json:"resource_id"`
}

type OfflineV5ManifestRoot struct {
	SelectionID  uuid.UUID `json:"selection_id"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   uuid.UUID `json:"resource_id"`
	HeadVersion  int64     `json:"head_version"`
	ContentHash  string    `json:"content_hash"`
}

type OfflineV5ManifestDependency struct {
	RootSelectionID uuid.UUID `json:"root_selection_id"`
	Module          string    `json:"module"`
	ResourceType    string    `json:"resource_type"`
	ResourceID      string    `json:"resource_id"`
	Mode            string    `json:"mode"`
}

type OfflineV5EntityVersion struct {
	EntityType string `json:"entity_type"`
	EntityID   string `json:"entity_id"`
	Version    int64  `json:"version"`
}

// OfflineV5ChunkHash binds a snapshot digest to the exact selected root and
// head version. A plain list of hashes is insufficient because it lets a
// client accidentally associate an otherwise valid payload with another
// selected resource.
type OfflineV5ChunkHash struct {
	SelectionID uuid.UUID `json:"selection_id"`
	HeadVersion int64     `json:"head_version"`
	ContentHash string    `json:"content_hash"`
}

// CanonicalJSON contains the exact UTF-8 bytes, base64url encoded without
// padding, whose SHA-256 is Digest. Clients must hash those bytes rather than
// reserializing this view. The detached ES256 lease signs Digest through its
// selection_digest claim.
type OfflineV5Manifest struct {
	ProtocolVersion   int                           `json:"protocol_version"`
	ID                uuid.UUID                     `json:"id"`
	Revision          int64                         `json:"revision"`
	BrowserProfileID  uuid.UUID                     `json:"browser_profile_id"`
	GrantID           uuid.UUID                     `json:"grant_id"`
	UserID            uuid.UUID                     `json:"user_id"`
	AccountID         uuid.UUID                     `json:"account_id"`
	Username          string                        `json:"username"`
	AccountName       string                        `json:"account_name"`
	SelectionRevision int64                         `json:"selection_revision"`
	SelectionDigest   string                        `json:"selection_digest"`
	CredentialEpoch   int64                         `json:"credential_epoch"`
	AuthorityEpoch    int64                         `json:"authority_epoch"`
	GrantRevision     int64                         `json:"grant_revision"`
	Roots             []OfflineV5ManifestRoot       `json:"roots"`
	Dependencies      []OfflineV5ManifestDependency `json:"dependencies"`
	Capabilities      []OfflineV5Capability         `json:"capabilities"`
	EntityVersions    []OfflineV5EntityVersion      `json:"entity_versions"`
	ChunkHashes       []OfflineV5ChunkHash          `json:"chunk_hashes"`
	Digest            string                        `json:"digest"`
	CanonicalJSON     string                        `json:"canonical_json"`
	IssuedAt          time.Time                     `json:"issued_at"`
	ExpiresAt         time.Time                     `json:"expires_at"`
	MaxStorageBytes   int64                         `json:"max_storage_bytes"`
}

type OfflineV5Snapshot struct {
	ProtocolVersion  int             `json:"protocol_version"`
	ManifestID       uuid.UUID       `json:"manifest_id"`
	ManifestRevision int64           `json:"manifest_revision"`
	SelectionID      uuid.UUID       `json:"selection_id"`
	RootSelectionID  uuid.UUID       `json:"root_selection_id"`
	RootResourceID   uuid.UUID       `json:"root_resource_id"`
	Module           string          `json:"module"`
	ResourceType     string          `json:"resource_type"`
	ResourceID       uuid.UUID       `json:"resource_id"`
	Dependency       bool            `json:"dependency"`
	HeadVersion      int64           `json:"head_version"`
	ContentHash      string          `json:"content_hash"`
	Payload          json.RawMessage `json:"payload"`
	PayloadJSON      string          `json:"payload_json"`
	Tombstone        bool            `json:"tombstone"`
	GeneratedAt      time.Time       `json:"generated_at"`
}

type OfflineV5Operation struct {
	ProtocolVersion      int             `json:"protocol_version"`
	BrowserProfileID     uuid.UUID       `json:"browser_profile_id"`
	GrantID              uuid.UUID       `json:"grant_id"`
	UserID               uuid.UUID       `json:"user_id"`
	AccountID            uuid.UUID       `json:"account_id"`
	ManifestID           uuid.UUID       `json:"manifest_id"`
	ManifestRevision     int64           `json:"manifest_revision"`
	SelectionID          uuid.UUID       `json:"selection_id"`
	SelectionRevision    int64           `json:"selection_revision"`
	CredentialEpoch      int64           `json:"credential_epoch"`
	AuthorityEpoch       int64           `json:"authority_epoch"`
	OperationID          uuid.UUID       `json:"operation_id"`
	DependsOnOperationID *uuid.UUID      `json:"depends_on_operation_id,omitempty"`
	Action               string          `json:"action"`
	ResourceID           uuid.UUID       `json:"resource_id"`
	BaseVersion          int64           `json:"base_version"`
	Base                 json.RawMessage `json:"base,omitempty"`
	Payload              json.RawMessage `json:"payload"`
	OccurredAt           time.Time       `json:"occurred_at"`
}

type OfflineV5Conflict struct {
	Fields []string        `json:"fields"`
	Base   json.RawMessage `json:"base,omitempty"`
	Local  json.RawMessage `json:"local,omitempty"`
	Server json.RawMessage `json:"server,omitempty"`
}

type OfflineV5OperationResult struct {
	OperationID   uuid.UUID          `json:"operation_id"`
	Status        string             `json:"status"`
	ErrorCode     string             `json:"error_code,omitempty"`
	ResourceID    uuid.UUID          `json:"resource_id,omitempty"`
	ServerVersion int64              `json:"server_version,omitempty"`
	Result        json.RawMessage    `json:"result,omitempty"`
	Conflict      *OfflineV5Conflict `json:"conflict,omitempty"`
}
