package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	jose "github.com/go-jose/go-jose/v4"
)

type v3ServiceDescriptor struct {
	Issuer                   string          `json:"iss"`
	Audience                 string          `json:"aud"`
	IssuedAt                 int64           `json:"iat"`
	NotBefore                int64           `json:"nbf"`
	ExpiresAt                int64           `json:"exp"`
	ID                       string          `json:"jti"`
	Version                  int             `json:"version"`
	InstallationID           string          `json:"installation_id"`
	WindowsPrincipalID       string          `json:"windows_principal_id"`
	BrowserProfileID         string          `json:"browser_profile_id"`
	ServerOrigin             string          `json:"server_origin"`
	TransportEncryptionKeyID string          `json:"transport_encryption_kid"`
	TransportEncryptionJWK   json.RawMessage `json:"transport_encryption_jwk"`
	ServiceSigningKeyID      string          `json:"service_signing_kid"`
	ServiceSigningJWK        json.RawMessage `json:"service_signing_jwk"`
}

func validV3Origin(origin string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && u.Path == "" && u.Opaque == "" && u.String() == origin
}

func descriptorPublicKey(raw json.RawMessage, kid, use, algorithm string) *ecdsa.PublicKey {
	if len(kid) < 1 || len(kid) > 128 || strings.TrimSpace(kid) != kid {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	for name := range fields {
		switch name {
		case "kty", "crv", "x", "y", "kid", "alg", "use":
		default:
			return nil
		}
	}
	var key jose.JSONWebKey
	if json.Unmarshal(raw, &key) != nil || !key.IsPublic() || !key.Valid() || key.Use != use || key.Algorithm != algorithm || (key.KeyID != "" && key.KeyID != kid) {
		return nil
	}
	pub, ok := key.Key.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return nil
	}
	return pub
}

func (s *v3Signer) validServiceDescriptor(input v3ServiceDescriptor) bool {
	now := s.now().Unix()
	if input.Issuer != v3Issuer || input.Audience != "clarin-offline-local-service" || input.Version != 3 || input.ServerOrigin != s.serverOrigin || !validV3Origin(input.ServerOrigin) ||
		input.IssuedAt < now-300 || input.IssuedAt > now+30 || input.NotBefore > input.IssuedAt || input.NotBefore < input.IssuedAt-30 || input.ExpiresAt <= now || input.ExpiresAt <= input.IssuedAt || input.ExpiresAt-input.IssuedAt > 30*86400 {
		return false
	}
	for _, id := range []string{input.ID, input.InstallationID, input.WindowsPrincipalID, input.BrowserProfileID} {
		if !validV3ID(id) {
			return false
		}
	}
	enc := descriptorPublicKey(input.TransportEncryptionJWK, input.TransportEncryptionKeyID, "enc", string(jose.ECDH_ES_A256KW))
	sig := descriptorPublicKey(input.ServiceSigningJWK, input.ServiceSigningKeyID, "sig", string(jose.ES256))
	return enc != nil && sig != nil && !enc.Equal(sig) && input.TransportEncryptionKeyID != input.ServiceSigningKeyID
}

func (s *v3Signer) signServiceDescriptor(w http.ResponseWriter, r *http.Request) {
	var descriptor v3ServiceDescriptor
	if decodeV3Request(w, r, &descriptor) != nil || !s.validServiceDescriptor(descriptor) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_service_descriptor"})
		return
	}
	s.signTyped(w, descriptor, "clarin-offline-service-descriptor+jwt")
}
