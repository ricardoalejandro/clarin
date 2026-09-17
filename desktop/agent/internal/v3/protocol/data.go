package protocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const (
	SnapshotJWSType = "clarin-offline-snapshot+jws"
	SnapshotJWEType = "clarin-offline-snapshot+jwe"
	ReceiptJWSType  = "clarin-offline-receipt+jws"
	ReceiptJWEType  = "clarin-offline-receipt+jwe"
)

type SignedSnapshot struct {
	Issuer            string          `json:"iss"`
	Audience          string          `json:"aud"`
	IssuedAt          int64           `json:"iat"`
	JWTID             string          `json:"jti"`
	Version           int             `json:"version"`
	Kind              string          `json:"kind"`
	Tuple             model.Tuple     `json:"tuple"`
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

type SignedReceipt struct {
	Issuer        string          `json:"iss"`
	Audience      string          `json:"aud"`
	IssuedAt      int64           `json:"iat"`
	JWTID         string          `json:"jti"`
	Version       int             `json:"version"`
	Kind          string          `json:"kind"`
	Tuple         model.Tuple     `json:"tuple"`
	OperationID   string          `json:"operation_id"`
	RequestHash   string          `json:"request_hash"`
	Status        string          `json:"status"`
	ErrorCode     string          `json:"error_code,omitempty"`
	ResourceID    string          `json:"resource_id,omitempty"`
	ServerVersion int64           `json:"server_version,omitempty"`
	Result        json.RawMessage `json:"result,omitempty"`
}

func (keys *SigningKeys) VerifySnapshot(token string, now time.Time, expected model.Tuple) (*SignedSnapshot, error) {
	payload, err := keys.verifySignedPayloadBound(token, SnapshotJWSType, 12<<20)
	if err != nil {
		return nil, err
	}
	var claims SignedSnapshot
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil || requireEOF(decoder) != nil {
		return nil, errors.New("snapshot claims rejected")
	}
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-snapshot" || claims.Kind != "snapshot" || !claims.Tuple.Equal(expected) || claims.Tuple.Validate() != nil || !canonicalUUID(claims.JWTID) || !canonicalUUID(claims.SelectionID) || claims.SelectionRevision < 1 || claims.HeadVersion < 1 {
		return nil, errors.New("snapshot authority binding rejected")
	}
	selection := model.Selection{SelectionID: claims.SelectionID, Module: claims.Module, ResourceType: claims.ResourceType, ResourceID: claims.ResourceID, HeadVersion: claims.HeadVersion, ContentHash: claims.ContentHash}
	if selection.Validate() != nil || !validHexDigest(claims.ContentHash) {
		return nil, errors.New("snapshot resource binding rejected")
	}
	issued := time.Unix(claims.IssuedAt, 0).UTC()
	if claims.IssuedAt <= 0 || issued.After(now.UTC().Add(5*time.Minute)) {
		return nil, errors.New("snapshot issued time rejected")
	}
	if claims.Tombstone {
		if string(claims.Payload) != "null" {
			return nil, errors.New("snapshot tombstone payload rejected")
		}
	} else if len(claims.Payload) == 0 || !json.Valid(claims.Payload) {
		return nil, errors.New("snapshot payload rejected")
	}
	normalized, err := json.Marshal(claims.Payload)
	if err != nil {
		return nil, errors.New("snapshot payload rejected")
	}
	digest := sha256.Sum256(normalized)
	if hex.EncodeToString(digest[:]) != claims.ContentHash {
		return nil, errors.New("snapshot content hash rejected")
	}
	return &claims, nil
}

func (keys *SigningKeys) VerifyReceipt(token string, now time.Time, expected model.Tuple) (*SignedReceipt, error) {
	payload, err := keys.verifySignedPayloadBound(token, ReceiptJWSType, 3<<20)
	if err != nil {
		return nil, err
	}
	var claims SignedReceipt
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil || requireEOF(decoder) != nil {
		return nil, errors.New("receipt claims rejected")
	}
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-receipt" || claims.Kind != "receipt" || !claims.Tuple.Equal(expected) || claims.Tuple.Validate() != nil || !canonicalUUID(claims.JWTID) || !canonicalUUID(claims.OperationID) || !validHexDigest(claims.RequestHash) {
		return nil, errors.New("receipt authority binding rejected")
	}
	if claims.IssuedAt <= 0 || time.Unix(claims.IssuedAt, 0).UTC().After(now.UTC().Add(5*time.Minute)) {
		return nil, errors.New("receipt issued time rejected")
	}
	switch claims.Status {
	case "applied", "noop", "conflict", "rejected":
	default:
		return nil, errors.New("receipt status rejected")
	}
	if claims.ResourceID != "" && !canonicalUUID(claims.ResourceID) || claims.ServerVersion < 0 || len(claims.ErrorCode) > 100 || len(claims.Result) > 2<<20 || len(claims.Result) > 0 && !json.Valid(claims.Result) {
		return nil, errors.New("receipt result rejected")
	}
	if (claims.Status == "applied" || claims.Status == "noop") && (claims.ResourceID == "" || claims.ServerVersion < 1) {
		return nil, errors.New("receipt canonical result missing")
	}
	return &claims, nil
}

func validHexDigest(value string) bool {
	if len(value) != sha256.Size*2 || value != strings.ToLower(value) {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
