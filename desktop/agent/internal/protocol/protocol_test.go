package protocol

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"strconv"
	"testing"
	"time"
)

func TestCanonicalRequestMatchesV2Contract(t *testing.T) {
	body := []byte(`{"account_id":"a"}`)
	got := CanonicalRequest("post", "/api/offline/v2/sync", "terminal", "account", "challenge", "nonce", 7, "application/json; charset=utf-8", body)
	want := "CLARIN-OFFLINE-V2\nPOST\n/api/offline/v2/sync\nterminal\naccount\nchallenge\nnonce\n7\napplication/json\n" + BodyHash(body)
	if got != want {
		t.Fatalf("canonical request mismatch:\n%s", got)
	}
}

func TestLeaseIsBoundToBootAndTwentyFourHours(t *testing.T) {
	key, publicPEM := testKey(t)
	now := time.Now().UTC().Truncate(time.Second)
	claims := LeaseClaims{Version: Version, TerminalID: "terminal", AccountID: "account", BootIDHash: "boot", MaxStorageBytes: 5 * 1024 * 1024 * 1024, IssuedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
	envelope := signTestEnvelope(t, key, claims, 3)
	if _, err := ValidateLease(envelope, 3, publicPEM, "terminal", "account", "boot", now); err != nil {
		t.Fatalf("valid lease rejected: %v", err)
	}
	if _, err := ValidateLease(envelope, 3, publicPEM, "terminal", "account", "different-boot", now); err == nil {
		t.Fatal("lease survived a Windows reboot identity change")
	}
	claims.ExpiresAt = now.Add(24*time.Hour + time.Second)
	envelope = signTestEnvelope(t, key, claims, 3)
	if _, err := ValidateLease(envelope, 3, publicPEM, "terminal", "account", "boot", now); err == nil {
		t.Fatal("lease longer than 24 hours was accepted")
	}
}

func TestWipeRequiresValidSignedControl(t *testing.T) {
	key, publicPEM := testKey(t)
	now := time.Now().UTC().Truncate(time.Second)
	claims := ControlClaims{Version: Version, DirectiveID: "directive", DirectiveType: "wipe", TerminalID: "terminal", IssuedAt: now}
	envelope := signTestEnvelope(t, key, claims, 2)
	directive := ControlDirective{ID: "directive", TerminalID: "terminal", DirectiveType: "wipe", Payload: envelope.Payload, Signature: envelope.Signature, SignerKeyVersion: envelope.KeyVersion}
	if _, err := ValidateControl(directive, 2, publicPEM, "terminal", now); err != nil {
		t.Fatalf("valid wipe rejected: %v", err)
	}
	directive.TerminalID = "other"
	if _, err := ValidateControl(directive, 2, publicPEM, "other", now); err == nil {
		t.Fatal("wipe for a different terminal was accepted")
	}
}

func testKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

func signTestEnvelope(t *testing.T, key *ecdsa.PrivateKey, value any, version int) Envelope {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(payload)
	signature, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return Envelope{Payload: base64.RawURLEncoding.EncodeToString(payload), Signature: "clarin:v" + strconv.Itoa(version) + ":" + base64.StdEncoding.EncodeToString(signature), KeyVersion: version}
}
