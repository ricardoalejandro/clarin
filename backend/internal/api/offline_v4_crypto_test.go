package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

func TestOfflineV4ProofBindsCompleteTransport(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public := &jose.JSONWebKey{Key: &key.PublicKey, KeyID: "test", Use: "sig", Algorithm: "ES256"}
	now := time.Unix(1900000000, 0)
	body := []byte(`{"grant_id":"fixed bytes","operations":[]}`)
	hash := sha256.Sum256(body)
	valid := offlineV4Proof{Version: 4, Purpose: "sync", ChallengeID: uuid.New(), Nonce: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", Method: "POST", Path: "/api/offline/v4/sync", BodySHA256: hex.EncodeToString(hash[:]), Audience: "https://clarin.example.invalid", BrowserProfileID: uuid.New(), GrantID: uuid.New(), IssuedAt: now.Unix(), ExpiresAt: now.Add(time.Minute).Unix(), ID: uuid.New()}
	sign := func(value offlineV4Proof, typ string) string {
		t.Helper()
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.ES256, Key: key}, new(jose.SignerOptions).WithType(jose.ContentType(typ)))
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(value)
		signed, err := signer.Sign(raw)
		if err != nil {
			t.Fatal(err)
		}
		compact, err := signed.CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return compact
	}
	if err = verifyOfflineV4Proof(sign(valid, offlineV4ProofType), public, valid, body, now); err != nil {
		t.Fatalf("valid proof: %v", err)
	}
	cases := map[string]func(*offlineV4Proof){
		"protocol": func(p *offlineV4Proof) { p.Version = 3 }, "purpose": func(p *offlineV4Proof) { p.Purpose = "keys" },
		"challenge": func(p *offlineV4Proof) { p.ChallengeID = uuid.New() }, "nonce": func(p *offlineV4Proof) { p.Nonce = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" },
		"method": func(p *offlineV4Proof) { p.Method = "GET" }, "path": func(p *offlineV4Proof) { p.Path = "/api/offline/v3/sync" },
		"origin": func(p *offlineV4Proof) { p.Audience = "https://other.example.invalid" }, "profile": func(p *offlineV4Proof) { p.BrowserProfileID = uuid.New() },
		"grant": func(p *offlineV4Proof) { p.GrantID = uuid.New() }, "hash": func(p *offlineV4Proof) { p.BodySHA256 = "00" },
		"jti": func(p *offlineV4Proof) { p.ID = uuid.Nil }, "expired": func(p *offlineV4Proof) { p.ExpiresAt = now.Unix() },
		"future": func(p *offlineV4Proof) {
			p.IssuedAt = now.Add(2 * time.Minute).Unix()
			p.ExpiresAt = now.Add(3 * time.Minute).Unix()
		},
		"long-lived": func(p *offlineV4Proof) { p.ExpiresAt = p.IssuedAt + 121 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			p := valid
			mutate(&p)
			if verifyOfflineV4Proof(sign(p, offlineV4ProofType), public, valid, body, now) == nil {
				t.Fatal("mismatched proof accepted")
			}
		})
	}
	if verifyOfflineV4Proof(sign(valid, "clarin-offline-sync-proof+jwt"), public, valid, body, now) == nil {
		t.Fatal("v3 signature type accepted")
	}
	if verifyOfflineV4Proof(sign(valid, offlineV4ProofType), public, valid, append(body, ' '), now) == nil {
		t.Fatal("body bytes changed without new signature")
	}
}

func TestOfflineV4OriginSecureContextBoundary(t *testing.T) {
	for _, origin := range []string{"https://clarin.naperu.cloud", "https://qa.example.invalid:9443", "http://localhost:19444", "http://127.0.0.1:19444", "http://[::1]:19444"} {
		if !validOfflineV4Origin(origin) {
			t.Errorf("valid origin denied %q", origin)
		}
	}
	for _, origin := range []string{"", "http://clarin.naperu.cloud", "http://localhost.evil.invalid", "http://127.0.0.2", "https://user:password@example.invalid", "https://example.invalid/", "https://example.invalid?q=x", "https://example.invalid#frag", "javascript:alert(1)", "null"} {
		if validOfflineV4Origin(origin) {
			t.Errorf("unsafe origin accepted %q", origin)
		}
	}
}

func TestOfflineV4WritePauseRemovesLeaseWriteAuthority(t *testing.T) {
	approved := []string{"tasks.read", "tasks.create", "tasks.complete", "contacts.read"}
	readOnly := offlineV4EffectiveActions(approved, false)
	if len(readOnly) != 2 || readOnly[0] != "tasks.read" || readOnly[1] != "contacts.read" {
		t.Fatalf("wrong effective actions: %v", readOnly)
	}
	if len(approved) != 4 || approved[1] != "tasks.create" {
		t.Fatal("approval mutated")
	}
	if len(offlineV4EffectiveActions(approved, true)) != 4 {
		t.Fatal("enabled writes missing")
	}
}
