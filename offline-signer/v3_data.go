package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
)

// Data signatures attest immutable server results. They deliberately confer no
// offline access: the service must separately validate the current grant lease,
// tuple, selection, monotonic versions and local lock state before displaying.
type v3DataTuple struct {
	InstallationID     string `json:"installation_id"`
	WindowsPrincipalID string `json:"windows_principal_id"`
	BrowserProfileID   string `json:"browser_profile_id"`
	AuthorizationID    string `json:"authorization_id"`
	GrantID            string `json:"grant_id"`
	UserID             string `json:"user_id"`
	AccountID          string `json:"account_id"`
}

func (t v3DataTuple) valid() bool {
	for _, id := range []string{t.InstallationID, t.WindowsPrincipalID, t.BrowserProfileID, t.AuthorizationID, t.GrantID, t.UserID, t.AccountID} {
		if !validV3ID(id) {
			return false
		}
	}
	return true
}

type v3Snapshot struct {
	Issuer            string          `json:"iss"`
	Audience          string          `json:"aud"`
	IssuedAt          int64           `json:"iat"`
	ID                string          `json:"jti"`
	Version           int             `json:"version"`
	Kind              string          `json:"kind"`
	Tuple             v3DataTuple     `json:"tuple"`
	SelectionID       string          `json:"selection_id"`
	Module            string          `json:"module"`
	ResourceType      string          `json:"resource_type"`
	ResourceID        string          `json:"resource_id"`
	SelectionRevision int64           `json:"selection_revision"`
	HeadVersion       int64           `json:"head_version"`
	ContentHash       string          `json:"content_hash"`
	Payload           json.RawMessage `json:"payload"`
	Tombstone         bool            `json:"tombstone,omitempty"`
}

type v3Receipt struct {
	Issuer        string          `json:"iss"`
	Audience      string          `json:"aud"`
	IssuedAt      int64           `json:"iat"`
	ID            string          `json:"jti"`
	Version       int             `json:"version"`
	Kind          string          `json:"kind"`
	Tuple         v3DataTuple     `json:"tuple"`
	OperationID   string          `json:"operation_id"`
	RequestHash   string          `json:"request_hash"`
	Status        string          `json:"status"`
	ErrorCode     string          `json:"error_code,omitempty"`
	ResourceID    string          `json:"resource_id,omitempty"`
	ServerVersion int64           `json:"server_version,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}

var v3SafeErrorCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,95}$`)

func validV3Digest(value string) bool {
	raw, err := hex.DecodeString(value)
	return err == nil && len(raw) == 32 && hex.EncodeToString(raw) == value
}

func (s *v3Signer) validData(issuer, audience, kind, id string, version int, issuedAt int64, tuple v3DataTuple) bool {
	now := s.now().Unix()
	return issuer == v3Issuer && audience == "clarin-offline-"+kind && version == 3 && validV3ID(id) && tuple.valid() && issuedAt >= now-300 && issuedAt <= now+30
}

func (s *v3Signer) signSnapshot(w http.ResponseWriter, r *http.Request) {
	var snapshot v3Snapshot
	valid := decodeV3RequestBounds(w, r, &snapshot, (8<<20)+16384, 64) == nil
	valid = valid && snapshot.Kind == "snapshot" && s.validData(snapshot.Issuer, snapshot.Audience, snapshot.Kind, snapshot.ID, snapshot.Version, snapshot.IssuedAt, snapshot.Tuple) && validV3ID(snapshot.SelectionID) && validV3ID(snapshot.ResourceID) && snapshot.SelectionRevision >= 1 && snapshot.HeadVersion >= 1 && len(snapshot.Payload) <= 8<<20
	pairs := map[string]string{"tasks": "task_list", "contacts": "contact", "programs": "program", "whiteboards": "whiteboard"}
	valid = valid && pairs[snapshot.Module] != "" && pairs[snapshot.Module] == snapshot.ResourceType
	// Hash precisely the representation signTyped will serialize. No ambiguous
	// cross-language "canonical JSON" claim or unauthenticated hash is trusted.
	normalized, err := json.Marshal(snapshot.Payload)
	digest := sha256.Sum256(normalized)
	valid = valid && err == nil && len(snapshot.Payload) > 0 && validV3Digest(snapshot.ContentHash) && hex.EncodeToString(digest[:]) == snapshot.ContentHash
	if snapshot.Tombstone {
		valid = valid && string(normalized) == "null"
	}
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_snapshot"})
		return
	}
	snapshot.Payload = normalized
	s.signTyped(w, snapshot, "clarin-offline-snapshot+jws")
}

func (s *v3Signer) signReceipt(w http.ResponseWriter, r *http.Request) {
	var receipt v3Receipt
	valid := decodeV3RequestBounds(w, r, &receipt, (1<<20)+16384, 64) == nil
	valid = valid && receipt.Kind == "receipt" && s.validData(receipt.Issuer, receipt.Audience, receipt.Kind, receipt.ID, receipt.Version, receipt.IssuedAt, receipt.Tuple) && validV3ID(receipt.OperationID) && validV3Digest(receipt.RequestHash) && receipt.ServerVersion >= 0
	valid = valid && (receipt.ResourceID == "" || validV3ID(receipt.ResourceID)) && (receipt.ErrorCode == "" || v3SafeErrorCode.MatchString(receipt.ErrorCode))
	switch receipt.Status {
	case "applied", "noop", "conflict", "rejected":
	default:
		valid = false
	}
	if receipt.Status == "applied" || receipt.Status == "noop" {
		valid = valid && receipt.ErrorCode == "" && validV3ID(receipt.ResourceID) && receipt.ServerVersion >= 1
	}
	if !valid {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_receipt"})
		return
	}
	s.signTyped(w, receipt, "clarin-offline-receipt+jws")
}
