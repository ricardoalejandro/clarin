package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/service"
)

// A use is a business attachment, not a database mirror or a physical object.
// Internal source locators never come from client supplied SQL or JSON paths.
type storageSelfServiceUse struct {
	UseID         string     `json:"use_id"`
	Type          string     `json:"type"`
	Label         string     `json:"label"`
	ContextLabel  string     `json:"context_label,omitempty"`
	Href          string     `json:"href,omitempty"`
	CreatedAt     *time.Time `json:"created_at,omitempty"`
	CanRemove     bool       `json:"can_remove"`
	BlockedReason string     `json:"blocked_reason,omitempty"`
	Adapter       string     `json:"-"`
	AccountID     uuid.UUID  `json:"-"`
	ObjectKey     string     `json:"-"`
	SourceID      uuid.UUID  `json:"-"`
	ParentID      uuid.UUID  `json:"-"`
	Slot          string     `json:"-"`
	Filename      string     `json:"-"`
	Fingerprint   string     `json:"-"`
	ReferenceIDs  []string   `json:"-"`
}

type storageUseActor struct {
	AccountID uuid.UUID
	UserID    uuid.UUID
	Claims    *service.JWTClaims
}

// Snapshots are private recovery data. Each adapter owns Before/After and must
// compare the current domain state before restoring, never overwrite new edits.
type storageUseSnapshot struct {
	Version      int             `json:"version"`
	Adapter      string          `json:"adapter"`
	UseID        string          `json:"use_id"`
	AccountID    uuid.UUID       `json:"account_id"`
	ObjectKey    string          `json:"object_key"`
	SourceID     uuid.UUID       `json:"source_id"`
	ParentID     uuid.UUID       `json:"parent_id"`
	Slot         string          `json:"slot"`
	Type         string          `json:"type"`
	Label        string          `json:"label"`
	ContextLabel string          `json:"context_label,omitempty"`
	Href         string          `json:"href,omitempty"`
	Before       json.RawMessage `json:"before"`
	After        json.RawMessage `json:"after"`
}

// List returns only actor-authorized uses. Hidden dependencies remain physical
// retention blockers and are reported to the browser only as retained_elsewhere.
// Detach and Restore run under the account storage barrier in the caller's tx.
// They must recheck domain ACL/lifecycle and preserve all unrelated source data.
type storageUseAdapter interface {
	Name() string
	List(context.Context, *Server, storageSelfServiceQuerier, storageUseActor, string) ([]storageSelfServiceUse, error)
	Detach(context.Context, *Server, pgx.Tx, storageUseActor, storageSelfServiceUse) (storageUseSnapshot, error)
	Restore(context.Context, *Server, pgx.Tx, storageUseActor, storageUseSnapshot) error
}

// Optional domain reconciliation runs only after the enclosing transaction
// committed. It must not perform the domain mutation a second time.
type storageUseAfterCommit interface {
	AfterCommit(context.Context, *Server, storageUseActor, []storageUseSnapshot, string)
}

type storageUseRecoveryAccess interface {
	AuthorizeRecovery(context.Context, *Server, storageSelfServiceQuerier, storageUseActor, storageUseSnapshot, string) error
}

// Domain-specific files register stateless adapters during package init.
var storageAdditionalUseAdapters []storageUseAdapter

var (
	errStorageUseChanged         = errors.New("the selected media use changed")
	errStorageUseProtected       = errors.New("the selected media use is protected")
	errStorageUseRestoreConflict = errors.New("the original media location changed")
)

func storageUseID(accountID uuid.UUID, adapter string, sourceID uuid.UUID, slot, objectKey string) string {
	data, _ := json.Marshal([]string{accountID.String(), adapter, sourceID.String(), slot, objectKey})
	hash := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

func storageUseFingerprint(value any) string {
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

type storageUseTarget struct {
	ObjectKey string   `json:"object_key"`
	Mode      string   `json:"mode"`
	UseIDs    []string `json:"use_ids,omitempty"`
}

type storageUseImpact struct {
	SelectedUsesCount        int   `json:"selected_uses_count"`
	RemovedUses              int   `json:"removed_uses"`
	RetainedUsesVisibleCount int   `json:"retained_uses_visible_count"`
	RetainedElsewhere        bool  `json:"retained_elsewhere"`
	WillTrash                bool  `json:"will_trash"`
	TrashBytes               int64 `json:"trash_bytes"`
	EstimatedFreedBytes      int64 `json:"estimated_freed_bytes"`
}

type storageUseBeforePurge interface {
	BeforePurge(context.Context, *Server, pgx.Tx, storageUseActor, storageUseSnapshot) error
}
