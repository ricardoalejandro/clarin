package protocol

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"strings"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

func protocolTuple() model.Tuple {
	return model.Tuple{
		InstallationID:     "11111111-1111-4111-8111-111111111111",
		WindowsPrincipalID: "22222222-2222-4222-8222-222222222222",
		BrowserProfileID:   "33333333-3333-4333-8333-333333333333",
		AuthorizationID:    "44444444-4444-4444-8444-444444444444",
		GrantID:            "55555555-5555-4555-8555-555555555555",
		UserID:             "66666666-6666-4666-8666-666666666666",
		AccountID:          "77777777-7777-4777-8777-777777777777",
	}
}

func TestVerifyLeaseStrictTupleAndKeyBinding(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	public, err := cryptokit.PublicJWK(&key.PublicKey, "lease-key-3", "sig", "ES256")
	if err != nil {
		t.Fatal(err)
	}
	keys, err := NewSigningKeys(PublicKeysResponse{Keys: []jose.JSONWebKey{public}, KeyVersion: 3})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	thumb := strings.Repeat("C", 43)
	loginBinding, _ := model.LoginBinding("ricardo")
	claims := model.LeaseClaims{
		Issuer: "clarin-offline-v3", Audience: "clarin-offline-unlock", IssuedAt: now.Unix(), NotBefore: now.Unix(), ExpiresAt: now.Add(time.Hour).Unix(),
		JWTID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Version: 3, Tuple: protocolTuple(),
		Epochs:          model.Epochs{Credential: 1, Authority: 1, Installation: 1, Principal: 1, Browser: 1, Authorization: 1, Grant: 1, Selection: 1},
		SelectionDigest: strings.Repeat("d", 64), LoginBindingSHA256: loginBinding, Actions: []string{model.ActionTasksRead}, MaxStorageBytes: 1024,
		BrowserKeyThumbprint: thumb, GrantSigningKeyThumbprint: thumb, GrantEncryptionKeyThumbprint: thumb,
	}
	raw, _ := json.Marshal(claims)
	token, err := cryptokit.SignCompact(raw, key, "lease-key-3", LeaseType)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := keys.VerifyLease(token, now, protocolTuple(), loginBinding, thumb, thumb, thumb); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	other := protocolTuple()
	other.UserID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	if _, err := keys.VerifyLease(token, now, other, loginBinding, thumb, thumb, thumb); err == nil {
		t.Fatal("lease accepted for another user")
	}
	otherLogin, _ := model.LoginBinding("otro")
	if _, err := keys.VerifyLease(token, now, protocolTuple(), otherLogin, thumb, thumb, thumb); err == nil {
		t.Fatal("lease accepted for another login")
	}
}

func TestSigningKeySetRejectsEncryptionAndWrongVersion(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	jwk, _ := cryptokit.PublicJWK(&key.PublicKey, "wrong", "enc", "ECDH-ES+A256KW")
	if _, err := NewSigningKeys(PublicKeysResponse{Keys: []jose.JSONWebKey{jwk}, KeyVersion: 3}); err == nil {
		t.Fatal("encryption key accepted as lease signing key")
	}
	jwk, _ = cryptokit.PublicJWK(&key.PublicKey, "lease", "sig", "ES256")
	if _, err := NewSigningKeys(PublicKeysResponse{Keys: []jose.JSONWebKey{jwk}, KeyVersion: 2}); err == nil {
		t.Fatal("downgrade key set accepted")
	}
	if keys, err := NewSigningKeys(PublicKeysResponse{Keys: []jose.JSONWebKey{jwk}, KeyVersion: 4}); err != nil || keys.Version != 4 {
		t.Fatalf("rotated signing key version rejected: %#v %v", keys, err)
	}
}
