package protocol

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/naperu/clarin-offline-agent/internal/v3/model"
)

const LeaseType = "clarin-offline-lease+jwt"

type SigningKeys struct {
	Version int
	keys    map[string]*ecdsa.PublicKey
}

type PublicKeysResponse struct {
	Keys       []jose.JSONWebKey `json:"keys"`
	KeyVersion int               `json:"key_version"`
}

func NewSigningKeys(response PublicKeysResponse) (*SigningKeys, error) {
	// key_version is a monotonically increasing rotation version, not the
	// offline protocol version. Version 3 is the first v3 signing generation.
	if response.KeyVersion < model.ProtocolVersion || len(response.Keys) == 0 || len(response.Keys) > 8 {
		return nil, errors.New("lease signing key set rejected")
	}
	keys := make(map[string]*ecdsa.PublicKey, len(response.Keys))
	for _, jwk := range response.Keys {
		key, ok := jwk.Key.(*ecdsa.PublicKey)
		if !ok || key.Curve != elliptic.P256() || !jwk.Valid() || !jwk.IsPublic() || jwk.KeyID == "" || jwk.Algorithm != string(jose.ES256) || jwk.Use != "sig" {
			return nil, errors.New("lease signing JWK rejected")
		}
		if _, duplicate := keys[jwk.KeyID]; duplicate {
			return nil, errors.New("duplicate lease signing key id")
		}
		keys[jwk.KeyID] = key
	}
	return &SigningKeys{Version: response.KeyVersion, keys: keys}, nil
}

func (keys *SigningKeys) VerifyLease(token string, now time.Time, tuple model.Tuple, loginBinding, browserThumbprint, signingThumbprint, encryptionThumbprint string) (*model.LeaseClaims, error) {
	claims, err := keys.verifiedLeaseClaims(token)
	if err != nil {
		return nil, err
	}
	if err := claims.Validate(now.UTC(), tuple, loginBinding, browserThumbprint, signingThumbprint, encryptionThumbprint); err != nil {
		return nil, err
	}
	return claims, nil
}

// VerifyStoredLease authenticates an already accepted lease even after its
// expiry. It is used only as the monotonic baseline for a fresh signed lease;
// it never authorizes an unlock or a browser session.
func (keys *SigningKeys) VerifyStoredLease(token string, tuple model.Tuple, loginBinding, browserThumbprint, signingThumbprint, encryptionThumbprint string) (*model.LeaseClaims, error) {
	claims, err := keys.verifiedLeaseClaims(token)
	if err != nil {
		return nil, err
	}
	issuedAt, notBefore, expiresAt := time.Unix(claims.IssuedAt, 0).UTC(), time.Unix(claims.NotBefore, 0).UTC(), time.Unix(claims.ExpiresAt, 0).UTC()
	if claims.Version != model.ProtocolVersion || claims.Issuer != "clarin-offline-v3" || claims.Audience != "clarin-offline-unlock" || claims.Tuple.Validate() != nil || !claims.Tuple.Equal(tuple) || claims.Epochs.Validate() != nil || !canonicalUUID(claims.JWTID) || !expiresAt.After(issuedAt) || expiresAt.After(issuedAt.Add(model.MaxLeaseDuration)) || notBefore.After(expiresAt) || claims.MaxStorageBytes <= 0 || claims.MaxStorageBytes > model.MaxStorageBytes || model.ValidateActions(claims.Actions) != nil || !validLeaseDigest(claims.SelectionDigest) || !validLeaseDigest(claims.LoginBindingSHA256) || claims.LoginBindingSHA256 != loginBinding || !validLeaseThumbprint(claims.BrowserKeyThumbprint) || !validLeaseThumbprint(claims.GrantSigningKeyThumbprint) || !validLeaseThumbprint(claims.GrantEncryptionKeyThumbprint) || claims.BrowserKeyThumbprint != browserThumbprint || claims.GrantSigningKeyThumbprint != signingThumbprint || claims.GrantEncryptionKeyThumbprint != encryptionThumbprint {
		return nil, errors.New("stored lease authority rejected")
	}
	return claims, nil
}

func (keys *SigningKeys) verifiedLeaseClaims(token string) (*model.LeaseClaims, error) {
	if keys == nil || len(keys.keys) == 0 || token == "" {
		return nil, errors.New("lease verification state is unavailable")
	}
	object, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return nil, errors.New("lease JWS format rejected")
	}
	signature := object.Signatures[0]
	if signature.Protected.Algorithm != string(jose.ES256) || signature.Protected.KeyID == "" || headerString(signature.Protected, jose.HeaderType) != LeaseType || signature.Unprotected.Algorithm != "" || signature.Unprotected.KeyID != "" || len(signature.Unprotected.ExtraHeaders) != 0 {
		return nil, errors.New("lease JWS protected header rejected")
	}
	key := keys.keys[signature.Protected.KeyID]
	if key == nil {
		return nil, errors.New("lease signing key id is unknown")
	}
	payload, err := object.Verify(key)
	if err != nil {
		return nil, errors.New("lease signature rejected")
	}
	var claims model.LeaseClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return nil, fmt.Errorf("lease claims rejected: %w", err)
	}
	return &claims, nil
}

func validLeaseDigest(value string) bool {
	if len(value) != 64 || value != strings.ToLower(value) {
		return false
	}
	for _, character := range value {
		if !strings.ContainsRune("0123456789abcdef", character) {
			return false
		}
	}
	return true
}

func validLeaseThumbprint(value string) bool {
	if len(value) != 43 {
		return false
	}
	for _, character := range value {
		if !(character >= 'a' && character <= 'z') && !(character >= 'A' && character <= 'Z') && !(character >= '0' && character <= '9') && character != '-' && character != '_' {
			return false
		}
	}
	return true
}

func headerString(header jose.Header, key jose.HeaderKey) string {
	value, ok := header.ExtraHeaders[key]
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}
