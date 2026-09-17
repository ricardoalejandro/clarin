package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const (
	OfflineModuleWhiteboards = "whiteboards"
	OfflineModuleTasks       = "tasks"
	OfflineModuleContacts    = "contacts"
	OfflineModulePrograms    = "programs"

	OfflineResourceWhiteboard = "whiteboard"
	OfflineResourceTaskList   = "task_list"
	OfflineResourceContact    = "contact"
	OfflineResourceProgram    = "program"
	OfflineEntityTask         = "task"

	OfflineOperationApplied          = "applied"
	OfflineOperationNoop             = "noop"
	OfflineOperationConflict         = "conflict"
	OfflineOperationRejected         = "rejected"
	OfflineOperationDependencyFailed = "dependency_failed"

	OfflineBitLockerEnabled  = "enabled"
	OfflineBitLockerDisabled = "disabled"
	OfflinePostureUnknown    = "unknown"

	OfflineWindowsHelloConfigured    = "configured"
	OfflineWindowsHelloNotConfigured = "not_configured"
)

type OfflineDevicePosture struct {
	BitLocker    string `json:"bitlocker"`
	WindowsHello string `json:"windows_hello"`
}

func NormalizeOfflineDevicePosture(posture OfflineDevicePosture) (OfflineDevicePosture, bool) {
	if posture.BitLocker == "" {
		posture.BitLocker = OfflinePostureUnknown
	}
	if posture.WindowsHello == "" {
		posture.WindowsHello = OfflinePostureUnknown
	}
	validBitLocker := posture.BitLocker == OfflineBitLockerEnabled || posture.BitLocker == OfflineBitLockerDisabled || posture.BitLocker == OfflinePostureUnknown
	validWindowsHello := posture.WindowsHello == OfflineWindowsHelloConfigured || posture.WindowsHello == OfflineWindowsHelloNotConfigured || posture.WindowsHello == OfflinePostureUnknown
	return posture, validBitLocker && validWindowsHello
}

func OfflineDevicePostureRequiresRiskAcknowledgement(posture OfflineDevicePosture) bool {
	return posture.BitLocker != OfflineBitLockerEnabled || posture.WindowsHello != OfflineWindowsHelloConfigured
}

type OfflineTerminal struct {
	ID                 uuid.UUID      `json:"id"`
	UserID             uuid.UUID      `json:"user_id"`
	UserDisplayName    string         `json:"user_display_name,omitempty"`
	DisplayName        string         `json:"display_name"`
	Platform           string         `json:"platform"`
	WindowsSIDHash     *string        `json:"windows_sid_hash,omitempty"`
	State              string         `json:"state"`
	ClientVersion      *string        `json:"client_version,omitempty"`
	BitLockerStatus    string         `json:"bitlocker_status"`
	WindowsHelloStatus string         `json:"windows_hello_status"`
	PostureReportedAt  *time.Time     `json:"posture_reported_at,omitempty"`
	RequestedAt        *time.Time     `json:"requested_at,omitempty"`
	ApprovedAt         *time.Time     `json:"approved_at,omitempty"`
	RejectedAt         *time.Time     `json:"rejected_at,omitempty"`
	MaxStorageBytes    int64          `json:"max_storage_bytes"`
	PolicyRevision     int64          `json:"policy_revision"`
	CreatedBy          uuid.UUID      `json:"created_by"`
	CreatedAt          time.Time      `json:"created_at"`
	ActivatedAt        *time.Time     `json:"activated_at,omitempty"`
	RevokedAt          *time.Time     `json:"revoked_at,omitempty"`
	LastSeenAt         *time.Time     `json:"last_seen_at,omitempty"`
	UpdatedAt          time.Time      `json:"updated_at"`
	LastSyncAt         *time.Time     `json:"last_sync_at,omitempty"`
	WipeRequiredAt     *time.Time     `json:"wipe_required_at,omitempty"`
	WipeAcknowledgedAt *time.Time     `json:"wipe_acknowledged_at,omitempty"`
	UsedStorageBytes   int64          `json:"used_storage_bytes"`
	Grants             []OfflineGrant `json:"grants"`
}

type OfflineGrant struct {
	ID                uuid.UUID       `json:"id"`
	TerminalID        uuid.UUID       `json:"terminal_id"`
	UserID            uuid.UUID       `json:"user_id"`
	AccountID         uuid.UUID       `json:"account_id"`
	AccountName       string          `json:"account_name,omitempty"`
	Modules           []string        `json:"modules"`
	Actions           json.RawMessage `json:"actions"`
	MaxOfflineSeconds int             `json:"max_offline_seconds"`
	QuotaBytes        int64           `json:"quota_bytes"`
	State             string          `json:"state"`
	PolicyRevision    int64           `json:"policy_revision"`
	SelectionRevision int64           `json:"selection_revision"`
	CreatedAt         time.Time       `json:"created_at"`
	UpdatedAt         time.Time       `json:"updated_at"`
}

type OfflineResourceSelection struct {
	ID           uuid.UUID `json:"id,omitempty"`
	GrantID      uuid.UUID `json:"grant_id,omitempty"`
	AccountID    uuid.UUID `json:"account_id,omitempty"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   uuid.UUID `json:"resource_id"`
	Label        string    `json:"label,omitempty"`
	Subtitle     string    `json:"subtitle,omitempty"`
	HeadVersion  int64     `json:"head_version,omitempty"`
	UpdatedAt    time.Time `json:"updated_at,omitempty"`
}

type OfflineGrantInput struct {
	AccountID         uuid.UUID                  `json:"account_id"`
	Modules           []string                   `json:"modules"`
	Actions           json.RawMessage            `json:"actions"`
	MaxOfflineSeconds int                        `json:"max_offline_seconds"`
	QuotaBytes        int64                      `json:"quota_bytes"`
	Resources         []OfflineResourceSelection `json:"resources"`
}

// OfflineInventoryItem is the small, non-sensitive comparison unit exchanged
// on every sync. Payloads are fetched only when this head differs from the
// encrypted local projection.
type OfflineInventoryItem struct {
	SelectionID  uuid.UUID `json:"selection_id"`
	Module       string    `json:"module"`
	ResourceType string    `json:"resource_type"`
	ResourceID   uuid.UUID `json:"resource_id"`
	HeadVersion  int64     `json:"head_version"`
	ContentHash  string    `json:"content_hash,omitempty"`
}

type OfflineClientInventoryItem struct {
	SelectionID uuid.UUID `json:"selection_id"`
	HeadVersion int64     `json:"head_version"`
	ContentHash string    `json:"content_hash,omitempty"`
}

type OfflineOperation struct {
	OperationID      uuid.UUID       `json:"operation_id"`
	DependsOn        []uuid.UUID     `json:"depends_on,omitempty"`
	SelectionID      uuid.UUID       `json:"selection_id,omitempty"`
	Module           string          `json:"module"`
	ResourceType     string          `json:"resource_type"`
	ResourceID       uuid.UUID       `json:"resource_id"`
	OperationType    string          `json:"operation_type"`
	BaseVersion      int64           `json:"base_version"`
	Base             json.RawMessage `json:"base,omitempty"`
	Patch            json.RawMessage `json:"patch"`
	ClientOccurredAt time.Time       `json:"client_occurred_at"`
}

type OfflineOperationResult struct {
	OperationID   uuid.UUID       `json:"operation_id"`
	Status        string          `json:"status"`
	ResourceID    uuid.UUID       `json:"resource_id,omitempty"`
	ServerVersion int64           `json:"server_version,omitempty"`
	ConflictID    *uuid.UUID      `json:"conflict_id,omitempty"`
	ErrorCode     string          `json:"error_code,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}

type OfflineControlDirective struct {
	ID               uuid.UUID `json:"id"`
	TerminalID       uuid.UUID `json:"terminal_id"`
	DirectiveType    string    `json:"directive_type"`
	Payload          string    `json:"payload"`
	Signature        string    `json:"signature"`
	SignerKeyVersion int       `json:"signer_key_version"`
	CreatedAt        time.Time `json:"created_at"`
}

type OfflineConflict struct {
	ID            uuid.UUID       `json:"id"`
	TerminalID    uuid.UUID       `json:"terminal_id"`
	OperationID   uuid.UUID       `json:"operation_id"`
	Module        string          `json:"module"`
	ResourceType  string          `json:"resource_type"`
	ResourceID    uuid.UUID       `json:"resource_id"`
	ServerVersion int64           `json:"server_version"`
	BaseVersion   int64           `json:"base_version"`
	BaseValue     json.RawMessage `json:"base_value"`
	ServerValue   json.RawMessage `json:"server_value"`
	ClientValue   json.RawMessage `json:"client_value"`
	ConflictPaths []string        `json:"conflict_paths"`
	Status        string          `json:"status"`
	CreatedAt     time.Time       `json:"created_at"`
}

func OfflineModuleForResourceType(resourceType string) (string, bool) {
	switch resourceType {
	case OfflineResourceWhiteboard:
		return OfflineModuleWhiteboards, true
	case OfflineResourceTaskList:
		return OfflineModuleTasks, true
	case OfflineResourceContact:
		return OfflineModuleContacts, true
	case OfflineResourceProgram:
		return OfflineModulePrograms, true
	default:
		return "", false
	}
}

func OfflineModuleForOperationResourceType(resourceType string) (string, bool) {
	if resourceType == OfflineEntityTask {
		return OfflineModuleTasks, true
	}
	return OfflineModuleForResourceType(resourceType)
}

type OfflineAuditEvent struct {
	ID         int64           `json:"id"`
	TerminalID *uuid.UUID      `json:"terminal_id,omitempty"`
	AccountID  *uuid.UUID      `json:"account_id,omitempty"`
	ActorID    *uuid.UUID      `json:"actor_id,omitempty"`
	EventType  string          `json:"event_type"`
	Metadata   json.RawMessage `json:"metadata"`
	CreatedAt  time.Time       `json:"created_at"`
}
