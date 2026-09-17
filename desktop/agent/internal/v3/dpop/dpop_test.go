package dpop

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/json"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
)

func signProof(t *testing.T, key *ecdsa.PrivateKey, keyID string, embed bool, claims Claims) string {
	t.Helper()
	options := (&jose.SignerOptions{EmbedJWK: embed}).WithType(Type)
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: jose.JSONWebKey{Key: key, KeyID: keyID, Algorithm: "ES256", Use: "sig"}}, options)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(claims)
	object, err := signer.Sign(raw)
	if err != nil {
		t.Fatal(err)
	}
	token, err := object.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestEnrollmentProofUsesEmbeddedP256KeyAndRejectsReplay(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	verifier := NewVerifier()
	verifier.now = func() time.Time { return now }
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	claims := Claims{JWTID: "11111111-1111-4111-8111-111111111111", Method: "POST", URI: "http://127.0.0.1:17373/v3/browser-profiles/enroll", IssuedAt: now.Unix(), Nonce: "nonce-one"}
	token := signProof(t, key, "", true, claims)
	result, err := verifier.VerifyEnrolling(token, "POST", claims.URI, claims.Nonce)
	if err != nil || result.Thumbprint == "" {
		t.Fatalf("valid enrollment DPoP rejected: %#v %v", result, err)
	}
	if _, err := verifier.VerifyEnrolling(token, "POST", claims.URI, claims.Nonce); err != ErrReplay {
		t.Fatalf("DPoP replay not rejected: %v", err)
	}
}

func TestSessionProofBindsMethodURIKeyNonceAndCapability(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	verifier := NewVerifier()
	verifier.now = func() time.Time { return now }
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	browserID := "22222222-2222-4222-8222-222222222222"
	capability := []byte("opaque-session-capability")
	public := jose.JSONWebKey{Key: &key.PublicKey, KeyID: browserID, Algorithm: "ES256", Use: "sig"}
	claims := Claims{JWTID: "33333333-3333-4333-8333-333333333333", Method: "GET", URI: "http://127.0.0.1:17373/v3/resources?limit=50&module=tasks", IssuedAt: now.Unix(), Nonce: "nonce-two", AccessHash: accessHash(capability)}
	token := signProof(t, key, browserID, false, claims)
	if _, err := verifier.Verify(token, browserID, public, "GET", claims.URI, claims.Nonce, capability); err != nil {
		t.Fatalf("valid session DPoP rejected: %v", err)
	}
	claims.JWTID = "44444444-4444-4444-8444-444444444444"
	wrongMethod := signProof(t, key, browserID, false, claims)
	if _, err := verifier.Verify(wrongMethod, browserID, public, "POST", claims.URI, claims.Nonce, capability); err != ErrInvalid {
		t.Fatalf("wrong method accepted: %v", err)
	}
	claims.JWTID = "55555555-5555-4555-8555-555555555555"
	wrongCapability := signProof(t, key, browserID, false, claims)
	if _, err := verifier.Verify(wrongCapability, browserID, public, "GET", claims.URI, claims.Nonce, []byte("another")); err != ErrInvalid {
		t.Fatalf("wrong capability accepted: %v", err)
	}
}

func TestProofTimestampWindowIsFailClosed(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	verifier := NewVerifier()
	verifier.now = func() time.Time { return now }
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	claims := Claims{JWTID: "66666666-6666-4666-8666-666666666666", Method: "POST", URI: "http://127.0.0.1:17373/v3/browser-profiles/enroll", IssuedAt: now.Add(-61 * time.Second).Unix(), Nonce: "nonce"}
	if _, err := verifier.VerifyEnrolling(signProof(t, key, "", true, claims), "POST", claims.URI, claims.Nonce); err != ErrInvalid {
		t.Fatalf("stale proof accepted: %v", err)
	}
}
