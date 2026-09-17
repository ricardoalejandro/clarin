package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const ControlType = "clarin-offline-control+jwt"

type ControlClaims struct {
	Issuer         string `json:"iss"`
	Audience       string `json:"aud"`
	IssuedAt       int64  `json:"iat"`
	NotBefore      int64  `json:"nbf"`
	ExpiresAt      int64  `json:"exp"`
	JWTID          string `json:"jti"`
	Version        int    `json:"version"`
	InstallationID string `json:"installation_id"`
	Scope          string `json:"scope"`
	ScopeID        string `json:"scope_id"`
	Revision       int64  `json:"revision"`
	Action         string `json:"action"`
	Reason         string `json:"reason"`
}

func (keys *SigningKeys) VerifyControl(token string, now time.Time, installationID string) (*ControlClaims, error) {
	payload, err := keys.verifySignedPayload(token, ControlType)
	if err != nil {
		return nil, err
	}
	var claims ControlClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil || requireEOF(decoder) != nil {
		return nil, errors.New("control claims rejected")
	}
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-control" || claims.InstallationID != installationID || !canonicalUUID(claims.JWTID) || !canonicalUUID(claims.ScopeID) || claims.Revision < 1 {
		return nil, errors.New("control binding rejected")
	}
	if claims.Scope != "installation" && claims.Scope != "windows_principal" && claims.Scope != "browser_profile" && claims.Scope != "authorization" && claims.Scope != "grant" && claims.Scope != "selection" {
		return nil, errors.New("control scope rejected")
	}
	if claims.Scope == "installation" && claims.ScopeID != installationID {
		return nil, errors.New("installation control scope rejected")
	}
	if claims.Action != "lock" && claims.Action != "wipe" {
		return nil, errors.New("control action rejected")
	}
	switch claims.Reason {
	case "admin_revoked", "credential_changed", "authority_changed", "account_disabled", "user_disabled", "selection_removed", "security_lock":
	default:
		return nil, errors.New("control reason rejected")
	}
	now = now.UTC()
	iat, nbf, exp := time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.NotBefore, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC()
	// A machine can legitimately remain offline beyond the control token's
	// nominal delivery window. Revocation/lock controls are irreversible or
	// fail-closed and protected by a durable per-scope revision high-water, so
	// an authentic delayed delivery must still apply. Time validation rejects
	// future issuance and malformed lifetimes; it does not discard an expired
	// control before the device has acknowledged it.
	if iat.After(now.Add(30*time.Second)) || nbf.After(now) || nbf.Before(iat.Add(-5*time.Minute)) || !exp.After(iat) || exp.After(iat.Add(model.MaxLeaseDuration)) {
		return nil, errors.New("control time rejected")
	}
	if _, err := uuid.Parse(claims.ScopeID); err != nil {
		return nil, errors.New("control scope id rejected")
	}
	return &claims, nil
}
