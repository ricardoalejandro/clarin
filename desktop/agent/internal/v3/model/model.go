package model

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	ProtocolVersion    = 3
	MaxLeaseDuration   = 72 * time.Hour
	MaxGrantResources  = 20
	MaxPilotAccounts   = 5
	MaxStorageBytes    = int64(5 * 1024 * 1024 * 1024)
	MaxRequestBody     = int64(1 << 20)
	MaxPageSize        = 100
	DefaultPageSize    = 50
	MaxPendingCommands = 1000
)

const (
	ActionTasksRead       = "tasks.read"
	ActionTasksCreate     = "tasks.create"
	ActionTasksComplete   = "tasks.complete"
	ActionContactsRead    = "contacts.read"
	ActionProgramsRead    = "programs.read"
	ActionWhiteboardsRead = "whiteboards.read"
)

var allowedActions = []string{
	ActionTasksRead,
	ActionTasksCreate,
	ActionTasksComplete,
	ActionContactsRead,
	ActionProgramsRead,
	ActionWhiteboardsRead,
}

// Tuple is the complete, non-reassignable authorization boundary. Account and
// user identity are always derived from this tuple; callers cannot override
// them by sending a different account_id or user_id alongside a grant.
type Tuple struct {
	InstallationID     string `json:"installation_id"`
	WindowsPrincipalID string `json:"windows_principal_id"`
	BrowserProfileID   string `json:"browser_profile_id"`
	AuthorizationID    string `json:"authorization_id"`
	GrantID            string `json:"grant_id"`
	UserID             string `json:"user_id"`
	AccountID          string `json:"account_id"`
}

func (t Tuple) Validate() error {
	values := []struct {
		name  string
		value string
	}{
		{"installation_id", t.InstallationID},
		{"windows_principal_id", t.WindowsPrincipalID},
		{"browser_profile_id", t.BrowserProfileID},
		{"authorization_id", t.AuthorizationID},
		{"grant_id", t.GrantID},
		{"user_id", t.UserID},
		{"account_id", t.AccountID},
	}
	for _, item := range values {
		parsed, err := uuid.Parse(item.value)
		if err != nil || parsed.String() != strings.ToLower(item.value) {
			return fmt.Errorf("%s must be a canonical UUID", item.name)
		}
	}
	return nil
}

func (t Tuple) Equal(other Tuple) bool { return t == other }

func (t Tuple) Binding() string {
	return strings.Join([]string{
		"CLARIN-OFFLINE-V3-GRANT",
		t.InstallationID,
		t.WindowsPrincipalID,
		t.BrowserProfileID,
		t.AuthorizationID,
		t.GrantID,
		t.UserID,
		t.AccountID,
	}, "\n")
}

type Epochs struct {
	Credential    int64 `json:"credential"`
	Authority     int64 `json:"authority"`
	Installation  int64 `json:"installation_revision"`
	Principal     int64 `json:"principal_revision"`
	Browser       int64 `json:"browser_revision"`
	Authorization int64 `json:"authorization_revision"`
	Grant         int64 `json:"grant_revision"`
	Selection     int64 `json:"selection_revision"`
}

func (e Epochs) Validate() error {
	if e.Credential < 1 || e.Authority < 1 || e.Installation < 1 || e.Principal < 1 || e.Browser < 1 || e.Authorization < 1 || e.Grant < 1 || e.Selection < 1 {
		return errors.New("lease epochs are invalid")
	}
	return nil
}

type LeaseClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	ExpiresAt int64  `json:"exp"`
	JWTID     string `json:"jti"`
	Version   int    `json:"version"`
	Tuple
	Epochs
	SelectionDigest              string   `json:"selection_digest"`
	LoginBindingSHA256           string   `json:"login_binding_sha256"`
	Actions                      []string `json:"actions"`
	MaxStorageBytes              int64    `json:"max_storage_bytes"`
	BrowserKeyThumbprint         string   `json:"browser_key_thumbprint"`
	GrantSigningKeyThumbprint    string   `json:"grant_signing_key_thumbprint"`
	GrantEncryptionKeyThumbprint string   `json:"grant_encryption_key_thumbprint"`
}

func (c LeaseClaims) Validate(now time.Time, expected Tuple, expectedLoginBinding, expectedBrowserThumbprint, expectedSigningThumbprint, expectedEncryptionThumbprint string) error {
	if c.Version != ProtocolVersion || c.Issuer != "clarin-offline-v3" || c.Audience != "clarin-offline-unlock" {
		return errors.New("lease protocol identity rejected")
	}
	if err := c.Tuple.Validate(); err != nil || !c.Tuple.Equal(expected) {
		return errors.New("lease authorization tuple rejected")
	}
	if _, err := uuid.Parse(c.JWTID); err != nil {
		return errors.New("lease jti is invalid")
	}
	if err := c.Epochs.Validate(); err != nil {
		return err
	}
	issuedAt := time.Unix(c.IssuedAt, 0).UTC()
	notBefore := time.Unix(c.NotBefore, 0).UTC()
	expiresAt := time.Unix(c.ExpiresAt, 0).UTC()
	if expiresAt.After(issuedAt.Add(MaxLeaseDuration)) || !expiresAt.After(now) || issuedAt.After(now.Add(5*time.Minute)) || notBefore.After(now.Add(2*time.Minute)) || expiresAt.Before(issuedAt) {
		return errors.New("lease time bounds rejected")
	}
	if c.MaxStorageBytes <= 0 || c.MaxStorageBytes > MaxStorageBytes {
		return errors.New("lease storage quota rejected")
	}
	if !validSHA256Hex(c.SelectionDigest) || !validSHA256Hex(c.LoginBindingSHA256) || !validSHA256B64URL(c.BrowserKeyThumbprint) || !validSHA256B64URL(c.GrantSigningKeyThumbprint) || !validSHA256B64URL(c.GrantEncryptionKeyThumbprint) {
		return errors.New("lease digest or key thumbprint rejected")
	}
	if c.LoginBindingSHA256 != expectedLoginBinding {
		return errors.New("lease login binding rejected")
	}
	if c.BrowserKeyThumbprint != expectedBrowserThumbprint || c.GrantSigningKeyThumbprint != expectedSigningThumbprint || c.GrantEncryptionKeyThumbprint != expectedEncryptionThumbprint {
		return errors.New("lease key binding rejected")
	}
	if err := ValidateActions(c.Actions); err != nil {
		return err
	}
	return nil
}

// LoginBinding derives the non-secret, server-signed binding used to keep two
// Clarin identities with the same password from opening each other's grant.
// It deliberately mirrors online login lookup: surrounding whitespace is
// removed, while case and Unicode code points remain exact.
func LoginBinding(login string) (string, error) {
	canonical, err := CanonicalLogin(login)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256([]byte(canonical))
	return hex.EncodeToString(digest[:]), nil
}

func CanonicalLogin(login string) (string, error) {
	canonical := strings.TrimSpace(login)
	if canonical == "" || len([]rune(canonical)) > 254 {
		return "", errors.New("offline login identifier rejected")
	}
	return canonical, nil
}

func ValidateActions(actions []string) error {
	if len(actions) == 0 || len(actions) > len(allowedActions) {
		return errors.New("lease actions are empty or excessive")
	}
	seen := make(map[string]struct{}, len(actions))
	for _, action := range actions {
		if !slices.Contains(allowedActions, action) {
			return fmt.Errorf("unsupported offline action %q", action)
		}
		if _, exists := seen[action]; exists {
			return errors.New("lease actions contain duplicates")
		}
		seen[action] = struct{}{}
	}
	if (slices.Contains(actions, ActionTasksCreate) || slices.Contains(actions, ActionTasksComplete)) && !slices.Contains(actions, ActionTasksRead) {
		return errors.New("task writes require tasks.read")
	}
	return nil
}

func HasAction(actions []string, wanted string) bool { return slices.Contains(actions, wanted) }

type Selection struct {
	SelectionID  string `json:"selection_id"`
	Module       string `json:"module"`
	ResourceType string `json:"resource_type"`
	ResourceID   string `json:"resource_id"`
	HeadVersion  int64  `json:"head_version"`
	ContentHash  string `json:"content_hash,omitempty"`
}

func (s Selection) Validate() error {
	for name, value := range map[string]string{"selection_id": s.SelectionID, "resource_id": s.ResourceID} {
		if parsed, err := uuid.Parse(value); err != nil || parsed.String() != strings.ToLower(value) {
			return fmt.Errorf("%s must be a canonical UUID", name)
		}
	}
	if s.HeadVersion < 0 || (s.ContentHash != "" && !validSHA256Hex(s.ContentHash)) {
		return errors.New("selection version or hash is invalid")
	}
	switch s.Module + "/" + s.ResourceType {
	case "tasks/task_list", "contacts/contact", "programs/program", "whiteboards/whiteboard":
		return nil
	default:
		return errors.New("selection type is not supported offline")
	}
}

type ResourceEnvelopeClaims struct {
	Version      int             `json:"version"`
	Kind         string          `json:"kind"`
	Tuple        Tuple           `json:"tuple"`
	SelectionID  string          `json:"selection_id"`
	Module       string          `json:"module"`
	ResourceType string          `json:"resource_type"`
	ResourceID   string          `json:"resource_id"`
	Revision     int64           `json:"revision"`
	Payload      json.RawMessage `json:"payload"`
	Tombstone    bool            `json:"tombstone,omitempty"`
}

func (c ResourceEnvelopeClaims) Validate(expected Tuple) error {
	if c.Version != ProtocolVersion || c.Kind != "snapshot" || !c.Tuple.Equal(expected) {
		return errors.New("snapshot grant binding rejected")
	}
	selection := Selection{SelectionID: c.SelectionID, Module: c.Module, ResourceType: c.ResourceType, ResourceID: c.ResourceID, HeadVersion: c.Revision}
	if err := selection.Validate(); err != nil {
		return err
	}
	if !c.Tombstone && (len(c.Payload) == 0 || !json.Valid(c.Payload)) {
		return errors.New("snapshot payload is invalid")
	}
	return nil
}

type TaskCreatePayload struct {
	Title       string  `json:"title"`
	Description string  `json:"description,omitempty"`
	StartAt     *string `json:"start_at"`
	DueAt       *string `json:"due_at"`
	DueEndAt    *string `json:"due_end_at"`
	IsAllDay    bool    `json:"is_all_day"`
	Priority    string  `json:"priority"`
}

type TaskCompletePayload struct{}

type Command struct {
	OperationID          string          `json:"operation_id"`
	DependsOnOperationID string          `json:"depends_on_operation_id,omitempty"`
	GrantID              string          `json:"grant_id"`
	Action               string          `json:"action"`
	SelectionID          string          `json:"selection_id"`
	ResourceID           string          `json:"resource_id"`
	BaseVersion          int64           `json:"base_version"`
	ClientOccurredAt     time.Time       `json:"client_occurred_at"`
	Payload              json.RawMessage `json:"payload"`
}

func (c Command) Validate(tuple Tuple, actions []string) error {
	for name, value := range map[string]string{"operation_id": c.OperationID, "grant_id": c.GrantID, "selection_id": c.SelectionID, "resource_id": c.ResourceID} {
		parsed, err := uuid.Parse(value)
		if err != nil || parsed.String() != strings.ToLower(value) {
			return fmt.Errorf("%s must be a canonical UUID", name)
		}
	}
	if c.GrantID != tuple.GrantID || !HasAction(actions, c.Action) {
		return errors.New("command is outside the active grant")
	}
	if c.BaseVersion < 0 || c.ClientOccurredAt.IsZero() || c.ClientOccurredAt.After(time.Now().UTC().Add(5*time.Minute)) || len(c.Payload) == 0 || !json.Valid(c.Payload) {
		return errors.New("command version, time, or payload is invalid")
	}
	switch c.Action {
	case ActionTasksCreate:
		var payload TaskCreatePayload
		if err := decodeStrict(c.Payload, &payload); err != nil {
			return fmt.Errorf("invalid tasks.create payload: %w", err)
		}
		if c.BaseVersion != 0 || c.DependsOnOperationID != "" || strings.TrimSpace(payload.Title) == "" || len([]rune(payload.Title)) > 500 || len([]rune(payload.Description)) > 20000 || !validPriority(payload.Priority) {
			return errors.New("tasks.create payload violates the offline contract")
		}
		for name, value := range map[string]*string{"start_at": payload.StartAt, "due_at": payload.DueAt, "due_end_at": payload.DueEndAt} {
			if value != nil {
				if parsed, err := time.Parse(time.RFC3339, *value); err != nil || parsed.IsZero() {
					return fmt.Errorf("tasks.create %s must be RFC3339 or null", name)
				}
			}
		}
	case ActionTasksComplete:
		var payload TaskCompletePayload
		if err := decodeStrict(c.Payload, &payload); err != nil {
			return fmt.Errorf("invalid tasks.complete payload: %w", err)
		}
		if c.BaseVersion == 0 {
			if !canonicalUUID(c.DependsOnOperationID) || c.DependsOnOperationID == c.OperationID {
				return errors.New("tasks.complete dependency is invalid")
			}
		} else if c.BaseVersion < 1 || c.DependsOnOperationID != "" {
			return errors.New("tasks.complete payload violates the offline contract")
		}
	default:
		return errors.New("read-only action cannot be enqueued")
	}
	return nil
}

type SignedOperationClaims struct {
	Version  int     `json:"version"`
	Kind     string  `json:"kind"`
	Tuple    Tuple   `json:"tuple"`
	Sequence int64   `json:"sequence"`
	LeaseID  string  `json:"lease_id"`
	Command  Command `json:"command"`
}

func (c SignedOperationClaims) Validate(expected Tuple, actions []string) error {
	if c.Version != ProtocolVersion || c.Kind != "operation" || !c.Tuple.Equal(expected) || c.Sequence < 1 || !canonicalUUID(c.LeaseID) {
		return errors.New("operation envelope binding rejected")
	}
	return c.Command.Validate(expected, actions)
}

// OfflineOperation is the exact inner JWS payload consumed by the Clarin v3
// backend. Authority fields are derived from the unlocked tuple and lease;
// they are never accepted from a browser command body.
type OfflineOperation struct {
	ProtocolVersion      int             `json:"protocol_version"`
	GrantID              string          `json:"grant_id"`
	UserID               string          `json:"user_id"`
	AccountID            string          `json:"account_id"`
	BrowserProfileID     string          `json:"browser_profile_id"`
	OperationID          string          `json:"operation_id"`
	DependsOnOperationID string          `json:"depends_on_operation_id,omitempty"`
	Action               string          `json:"action"`
	SelectionID          string          `json:"selection_id"`
	ResourceID           string          `json:"resource_id"`
	SelectionRevision    int64           `json:"selection_revision"`
	CredentialEpoch      int64           `json:"credential_epoch"`
	AuthorityEpoch       int64           `json:"authority_epoch"`
	BaseVersion          int64           `json:"base_version"`
	Payload              json.RawMessage `json:"payload"`
	OccurredAt           time.Time       `json:"occurred_at"`
}

func (o OfflineOperation) Validate(tuple Tuple, actions []string) error {
	if o.ProtocolVersion != ProtocolVersion || o.GrantID != tuple.GrantID || o.UserID != tuple.UserID || o.AccountID != tuple.AccountID || o.BrowserProfileID != tuple.BrowserProfileID || o.SelectionRevision < 0 || o.CredentialEpoch < 1 || o.AuthorityEpoch < 1 {
		return errors.New("operation authority binding rejected")
	}
	command := Command{OperationID: o.OperationID, DependsOnOperationID: o.DependsOnOperationID, GrantID: o.GrantID, Action: o.Action, SelectionID: o.SelectionID, ResourceID: o.ResourceID, BaseVersion: o.BaseVersion, ClientOccurredAt: o.OccurredAt, Payload: o.Payload}
	return command.Validate(tuple, actions)
}

func ValidateLocalResource(module, resourceType, resourceID string, revision int64) error {
	if !canonicalUUID(resourceID) || revision < 0 {
		return errors.New("local resource identity rejected")
	}
	switch module + "/" + resourceType {
	case "tasks/task_list", "tasks/task", "contacts/contact", "programs/program", "programs/participant", "programs/session", "programs/attendance", "whiteboards/whiteboard", "whiteboards/scene", "whiteboards/asset":
		return nil
	default:
		return errors.New("local resource type rejected")
	}
}

func SelectionDigest(selections []Selection) (string, error) {
	parts := make([]string, 0, len(selections))
	for _, selection := range selections {
		if err := selection.Validate(); err != nil {
			return "", err
		}
		// This is the exact backend digest contract. Selection IDs, labels and
		// snapshot versions are intentionally excluded: the digest authorizes
		// the selected resource set, while selection_revision handles changes.
		parts = append(parts, selection.Module+"\x00"+selection.ResourceType+"\x00"+selection.ResourceID)
	}
	slices.Sort(parts)
	digest := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(digest[:]), nil
}

func decodeStrict(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("multiple JSON values or trailing data")
	}
	return nil
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}

func validPriority(value string) bool {
	return value == "low" || value == "medium" || value == "high" || value == "urgent"
}

func validSHA256Hex(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size && value == strings.ToLower(value)
}

func validSHA256B64URL(value string) bool {
	// A P-256 JWK SHA-256 thumbprint is an unpadded base64url string with 43 characters.
	if len(value) != 43 {
		return false
	}
	for _, char := range value {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && char != '-' && char != '_' {
			return false
		}
	}
	return true
}
