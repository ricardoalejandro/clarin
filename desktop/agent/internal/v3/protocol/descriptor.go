package protocol

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"

	"github.com/naperu/clarin-offline-agent/internal/v3/cryptokit"
	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const (
	ServiceDescriptorType = "clarin-offline-service-descriptor+jwt"
	ServicePossessionType = "clarin-offline-service-possession+jwt"
	GrantBootstrapType    = "clarin-offline-grant-bootstrap+jwt"
	maxDescriptorLifetime = 30 * 24 * time.Hour
)

type GrantBootstrapClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	IssuedAt  int64  `json:"iat"`
	NotBefore int64  `json:"nbf"`
	ExpiresAt int64  `json:"exp"`
	JWTID     string `json:"jti"`
	Version   int    `json:"version"`
	model.Tuple
	model.Epochs
	SelectionDigest              string   `json:"selection_digest"`
	LoginBindingSHA256           string   `json:"login_binding_sha256"`
	Actions                      []string `json:"actions"`
	MaxStorageBytes              int64    `json:"max_storage_bytes"`
	BrowserKeyThumbprint         string   `json:"browser_key_thumbprint"`
	GrantSigningKeyThumbprint    string   `json:"grant_signing_key_thumbprint"`
	GrantEncryptionKeyThumbprint string   `json:"grant_encryption_key_thumbprint"`
}

func (keys *SigningKeys) VerifyGrantBootstrap(token string, now time.Time, installationID, principalID, browserID, browserThumbprint string) (*GrantBootstrapClaims, error) {
	payload, err := keys.verifySignedPayload(token, GrantBootstrapType)
	if err != nil {
		return nil, err
	}
	var claims GrantBootstrapClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil || requireEOF(decoder) != nil {
		return nil, errors.New("grant bootstrap claims rejected")
	}
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-local-service" || claims.Tuple.Validate() != nil || claims.Epochs.Validate() != nil || claims.Tuple.InstallationID != installationID || claims.Tuple.WindowsPrincipalID != principalID || claims.Tuple.BrowserProfileID != browserID || claims.BrowserKeyThumbprint != browserThumbprint || claims.GrantSigningKeyThumbprint != "" || claims.GrantEncryptionKeyThumbprint != "" || model.ValidateActions(claims.Actions) != nil || claims.MaxStorageBytes <= 0 || claims.MaxStorageBytes > model.MaxStorageBytes || !validLeaseDigest(claims.LoginBindingSHA256) || !canonicalUUID(claims.JWTID) {
		return nil, errors.New("grant bootstrap binding rejected")
	}
	now = now.UTC()
	iat, nbf, exp := time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.NotBefore, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC()
	if iat.After(now.Add(5*time.Minute)) || nbf.After(now.Add(2*time.Minute)) || !exp.After(now) || exp.After(iat.Add(10*time.Minute)) || exp.Before(iat) {
		return nil, errors.New("grant bootstrap time rejected")
	}
	if claims.Epochs.Selection > 0 && len(claims.SelectionDigest) != 64 {
		return nil, errors.New("grant bootstrap metadata rejected")
	}
	return &claims, nil
}

type ServiceDescriptorClaims struct {
	Issuer                 string          `json:"iss"`
	Audience               string          `json:"aud"`
	IssuedAt               int64           `json:"iat"`
	NotBefore              int64           `json:"nbf"`
	ExpiresAt              int64           `json:"exp"`
	JWTID                  string          `json:"jti"`
	Version                int             `json:"version"`
	InstallationID         string          `json:"installation_id"`
	WindowsPrincipalID     string          `json:"windows_principal_id"`
	BrowserProfileID       string          `json:"browser_profile_id"`
	TransportEncryptionKID string          `json:"transport_encryption_kid"`
	TransportEncryptionJWK jose.JSONWebKey `json:"transport_encryption_jwk"`
	ServiceSigningKID      string          `json:"service_signing_kid"`
	ServiceSigningJWK      jose.JSONWebKey `json:"service_signing_jwk"`
	ServerOrigin           string          `json:"server_origin"`
}

func (keys *SigningKeys) VerifyServiceDescriptor(token string, now time.Time, installationID, principalID, browserID, serverOrigin string, localSigning, localEncryption jose.JSONWebKey) (*ServiceDescriptorClaims, error) {
	payload, err := keys.verifySignedPayload(token, ServiceDescriptorType)
	if err != nil {
		return nil, err
	}
	var claims ServiceDescriptorClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return nil, errors.New("service descriptor claims rejected")
	}
	if err := requireEOF(decoder); err != nil {
		return nil, err
	}
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-local-service" || claims.InstallationID != installationID || claims.WindowsPrincipalID != principalID || claims.BrowserProfileID != browserID || claims.ServerOrigin != serverOrigin {
		return nil, errors.New("service descriptor binding rejected")
	}
	if !canonicalUUID(claims.JWTID) {
		return nil, errors.New("service descriptor jti rejected")
	}
	issuedAt, notBefore, expiresAt := time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.NotBefore, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC()
	now = now.UTC()
	if issuedAt.After(now.Add(5*time.Minute)) || notBefore.After(now.Add(2*time.Minute)) || !expiresAt.After(now) || expiresAt.After(issuedAt.Add(maxDescriptorLifetime)) || expiresAt.Before(issuedAt) {
		return nil, errors.New("service descriptor time rejected")
	}
	if err := validateDescriptorJWK(claims.ServiceSigningJWK, claims.ServiceSigningKID, "sig", "ES256"); err != nil {
		return nil, err
	}
	if err := validateDescriptorJWK(claims.TransportEncryptionJWK, claims.TransportEncryptionKID, "enc", "ECDH-ES+A256KW"); err != nil {
		return nil, err
	}
	localSigningThumbprint, err := cryptokit.Thumbprint(localSigning)
	if err != nil {
		return nil, err
	}
	localEncryptionThumbprint, err := cryptokit.Thumbprint(localEncryption)
	if err != nil {
		return nil, err
	}
	signingThumbprint, _ := cryptokit.Thumbprint(claims.ServiceSigningJWK)
	encryptionThumbprint, _ := cryptokit.Thumbprint(claims.TransportEncryptionJWK)
	if localSigningThumbprint != signingThumbprint || localEncryptionThumbprint != encryptionThumbprint || localSigning.KeyID != claims.ServiceSigningKID || localEncryption.KeyID != claims.TransportEncryptionKID {
		return nil, errors.New("service descriptor key substitution rejected")
	}
	return &claims, nil
}

type ServicePossessionClaims struct {
	Version            int    `json:"version"`
	Purpose            string `json:"purpose"`
	Challenge          string `json:"challenge"`
	InstallationID     string `json:"installation_id"`
	WindowsPrincipalID string `json:"windows_principal_id"`
	BrowserProfileID   string `json:"browser_profile_id"`
	ServerOrigin       string `json:"server_origin"`
	IssuedAt           int64  `json:"iat"`
	ExpiresAt          int64  `json:"exp"`
	JWTID              string `json:"jti"`
}

func SignServicePossession(privateKey *ecdsa.PrivateKey, keyID, challenge, installationID, principalID, browserID, serverOrigin string, now time.Time) (string, error) {
	if !validChallenge(challenge) {
		return "", errors.New("service possession challenge rejected")
	}
	claims := ServicePossessionClaims{
		Version: model.ProtocolVersion, Purpose: "service-possession", Challenge: challenge,
		InstallationID: installationID, WindowsPrincipalID: principalID, BrowserProfileID: browserID, ServerOrigin: serverOrigin,
		IssuedAt: now.UTC().Unix(), ExpiresAt: now.UTC().Add(time.Minute).Unix(), JWTID: uuid.NewString(),
	}
	raw, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	return cryptokit.SignCompact(raw, privateKey, keyID, ServicePossessionType)
}

func NewChallenge() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validChallenge(value string) bool {
	if len(value) != 43 {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(raw) == 32
}

func validateDescriptorJWK(jwk jose.JSONWebKey, kid, use, algorithm string) error {
	key, ok := jwk.Key.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() || !jwk.IsPublic() || !jwk.Valid() || kid == "" || jwk.KeyID != kid || jwk.Use != use || jwk.Algorithm != algorithm {
		return errors.New("service descriptor public key rejected")
	}
	return nil
}

func (keys *SigningKeys) verifySignedPayload(token, expectedType string) ([]byte, error) {
	return keys.verifySignedPayloadBound(token, expectedType, 128<<10)
}

func (keys *SigningKeys) verifySignedPayloadBound(token, expectedType string, maximum int) ([]byte, error) {
	if keys == nil || len(keys.keys) == 0 || token == "" || maximum < 1 || len(token) > maximum {
		return nil, errors.New("signing verification state unavailable")
	}
	object, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return nil, errors.New("signed object format rejected")
	}
	signature := object.Signatures[0]
	if signature.Protected.Algorithm != string(jose.ES256) || signature.Protected.KeyID == "" || headerString(signature.Protected, jose.HeaderType) != expectedType || signature.Unprotected.Algorithm != "" || signature.Unprotected.KeyID != "" || len(signature.Unprotected.ExtraHeaders) != 0 {
		return nil, errors.New("signed object protected header rejected")
	}
	key := keys.keys[signature.Protected.KeyID]
	if key == nil {
		return nil, errors.New("signed object key id unknown")
	}
	payload, err := object.Verify(key)
	if err != nil {
		return nil, errors.New("signed object signature rejected")
	}
	return payload, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("signed object contains trailing data")
	}
	return nil
}

func canonicalUUID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == strings.ToLower(value)
}
