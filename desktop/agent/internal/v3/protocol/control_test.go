package protocol

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

func TestControlDelayedRedeliveryStillApplies(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	public, _ := cryptokit.PublicJWK(&key.PublicKey, "control-key-3", "sig", "ES256")
	keys, err := NewSigningKeys(PublicKeysResponse{Keys: []jose.JSONWebKey{public}, KeyVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	issued := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	claims := ControlClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-control", IssuedAt: issued.Unix(), NotBefore: issued.Unix(), ExpiresAt: issued.Add(model.MaxLeaseDuration).Unix(),
		JWTID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: 3, InstallationID: "11111111-1111-4111-8111-111111111111",
		Scope: "grant", ScopeID: "55555555-5555-4555-8555-555555555555", Revision: 7, Action: "wipe", Reason: "admin_revoked",
	}
	raw, _ := json.Marshal(claims)
	token, err := cryptokit.SignCompact(raw, key, public.KeyID, ControlType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.VerifyControl(token, issued.Add(73*time.Hour), claims.InstallationID); err != nil {
		t.Fatalf("authentic unacknowledged control was lost after offline delay: %v", err)
	}
	if _, err := keys.VerifyControl(token, issued.Add(-time.Minute), claims.InstallationID); err == nil {
		t.Fatal("future control issuance was accepted")
	}
}
