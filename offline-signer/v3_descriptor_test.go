package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"testing"

	jose "github.com/go-jose/go-jose/v4"
)

func TestV3ServiceDescriptorBindsServerOriginAndDistinctPublicPurposeKeys(t *testing.T) {
	s := newTestV3Signer(t)
	enc, _ := json.Marshal(jose.JSONWebKey{Key: &s.intakeKeys[v3IntakeKeyID(3)].PublicKey, KeyID: "transport-1", Use: "enc", Algorithm: string(jose.ECDH_ES_A256KW)})
	sig, _ := json.Marshal(jose.JSONWebKey{Key: &s.key.PublicKey, KeyID: "signing-1", Use: "sig", Algorithm: string(jose.ES256)})
	valid := v3ServiceDescriptor{Issuer: v3Issuer, Audience: "clarin-offline-local-service", IssuedAt: s.now().Unix(), NotBefore: s.now().Unix(), ExpiresAt: s.now().Unix() + 30*86400, ID: testV3ID, Version: 3, InstallationID: testV3ID, WindowsPrincipalID: testV3ID, BrowserProfileID: testV3ID, ServerOrigin: s.serverOrigin, TransportEncryptionKeyID: "transport-1", TransportEncryptionJWK: enc, ServiceSigningKeyID: "signing-1", ServiceSigningJWK: sig}
	if !s.validServiceDescriptor(valid) {
		t.Fatal("valid descriptor rejected")
	}
	for name, mutate := range map[string]func(*v3ServiceDescriptor){
		"unrelated origin": func(d *v3ServiceDescriptor) { d.ServerOrigin = "https://evil.invalid" },
		"http":             func(d *v3ServiceDescriptor) { d.ServerOrigin = "http://clarin.naperu.cloud" },
		"excess lifetime":  func(d *v3ServiceDescriptor) { d.ExpiresAt++ },
		"wrong profile":    func(d *v3ServiceDescriptor) { d.BrowserProfileID = "" },
		"wrong kid":        func(d *v3ServiceDescriptor) { d.ServiceSigningKeyID = "other-key" },
		"private signing key": func(d *v3ServiceDescriptor) {
			d.ServiceSigningJWK, _ = json.Marshal(jose.JSONWebKey{Key: s.key, KeyID: "signing-1", Use: "sig", Algorithm: string(jose.ES256)})
		},
		"reused key": func(d *v3ServiceDescriptor) {
			d.TransportEncryptionJWK, _ = json.Marshal(jose.JSONWebKey{Key: &s.key.PublicKey, KeyID: "transport-1", Use: "enc", Algorithm: string(jose.ECDH_ES_A256KW)})
		},
	} {
		t.Run(name, func(t *testing.T) {
			candidate := valid
			mutate(&candidate)
			if s.validServiceDescriptor(candidate) {
				t.Fatal("unsafe descriptor accepted")
			}
		})
	}
	raw, _ := json.Marshal(valid)
	w := httptest.NewRecorder()
	s.signServiceDescriptor(w, httptest.NewRequest("POST", "/v3/sign-service-descriptor", bytes.NewReader(raw)))
	if w.Code != 200 {
		t.Fatalf("valid descriptor HTTP: %d %s", w.Code, w.Body.String())
	}
}
