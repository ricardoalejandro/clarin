package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	jose "github.com/go-jose/go-jose/v4"
)

func TestV3BootstrapCannotBecomeAnUnlockLeaseOrAuthorizeClientKeys(t *testing.T) {
	s := newTestV3Signer(t)
	bootstrap := validTestV3Lease(s)
	bootstrap.Audience = "clarin-offline-local-service"
	bootstrap.ExpiresAt = bootstrap.IssuedAt + 600
	bootstrap.GrantSigningKeyThumbprint = ""
	bootstrap.GrantEncryptionKeyThumbprint = ""
	if s.validateLease(bootstrap) {
		t.Fatal("bootstrap accepted as unlock lease")
	}
	if !s.validateGrantAuthority(bootstrap, "clarin-offline-local-service", 600, false) {
		t.Fatal("valid bootstrap rejected")
	}
	for name, mutate := range map[string]func(*v3Lease){"lifetime": func(l *v3Lease) { l.ExpiresAt++ }, "browser": func(l *v3Lease) { l.BrowserKeyThumbprint = "" }, "client signing key": func(l *v3Lease) { l.GrantSigningKeyThumbprint = validTestV3Lease(s).GrantSigningKeyThumbprint }, "client encryption key": func(l *v3Lease) { l.GrantEncryptionKeyThumbprint = validTestV3Lease(s).GrantEncryptionKeyThumbprint }, "wrong audience": func(l *v3Lease) { l.Audience = "clarin-offline-unlock" }} {
		t.Run(name, func(t *testing.T) {
			candidate := bootstrap
			mutate(&candidate)
			if s.validateGrantAuthority(candidate, "clarin-offline-local-service", 600, false) {
				t.Fatal("unsafe bootstrap accepted")
			}
		})
	}
	raw, _ := json.Marshal(bootstrap)
	w := httptest.NewRecorder()
	s.signGrantBootstrap(w, httptest.NewRequest("POST", "/v3/sign-grant-bootstrap", bytes.NewReader(raw)))
	if w.Code != 200 {
		t.Fatalf("bootstrap HTTP %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Token string `json:"token"`
	}
	if json.Unmarshal(w.Body.Bytes(), &response) != nil {
		t.Fatal("invalid response")
	}
	object, err := jose.ParseSignedCompact(response.Token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	if object.Signatures[0].Protected.ExtraHeaders["typ"] != "clarin-offline-grant-bootstrap+jwt" {
		t.Fatal("untyped bootstrap")
	}
	payload, err := object.Verify(&s.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		t.Fatal("invalid claims")
	}
	if _, exists := claims["grant_signing_key_thumbprint"]; exists {
		t.Fatal("pre-key bootstrap must omit grant signing key")
	}
}
