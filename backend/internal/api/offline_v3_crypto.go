package api

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

const (
	offlineV3MaxJSONBody     = 2 << 20
	offlineV3MaxSnapshotJWS  = 12 << 20
	offlineV3MaxSignerBody   = offlineV3MaxSnapshotJWS + (64 << 10)
	offlineV3ProofClockSkew  = 5 * time.Minute
	offlineV3ProofEnrollment = "clarin-offline-enrollment-proof+jwt"
	offlineV3ProofGrantKeys  = "clarin-offline-grant-keys-proof+jwt"
	offlineV3ProofLease      = "clarin-offline-lease-proof+jwt"
	offlineV3ProofSync       = "clarin-offline-sync-proof+jwt"
	offlineV3OperationJWS    = "clarin-offline-operation+jws"
	offlineV3SnapshotJWE     = "clarin-offline-snapshot+jwe"
	offlineV3ReceiptJWE      = "clarin-offline-receipt+jwe"
)

type offlineV3ProofClaims struct {
	Version            int       `json:"version"`
	Purpose            string    `json:"purpose"`
	ChallengeID        uuid.UUID `json:"challenge_id"`
	InstallationID     uuid.UUID `json:"installation_id"`
	WindowsPrincipalID uuid.UUID `json:"windows_principal_id"`
	BrowserProfileID   uuid.UUID `json:"browser_profile_id"`
	AuthorizationID    uuid.UUID `json:"authorization_id,omitempty"`
	GrantID            uuid.UUID `json:"grant_id,omitempty"`
	Nonce              string    `json:"nonce,omitempty"`
	Counter            int64     `json:"counter,omitempty"`
	RequestHash        string    `json:"request_hash"`
	IssuedAt           int64     `json:"iat"`
	ID                 uuid.UUID `json:"jti"`
}

func offlineV3ReadStrictJSON(c *fiber.Ctx, value any, limit int) error {
	raw := c.Body()
	if len(raw) == 0 || len(raw) > limit {
		return errors.New("invalid JSON size")
	}
	if err := offlineV3ValidateJSON(raw); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

// offlineV3ValidateJSON rejects duplicate object members before decoding. Go's
// normal JSON decoder otherwise keeps the last value, which is unsafe when a
// browser, service, reverse proxy, and signer may canonicalize differently.
func offlineV3ValidateJSON(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var parse func(int) error
	parse = func(depth int) error {
		if depth > 20 {
			return errors.New("JSON nesting too deep")
		}
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		delimiter, ok := token.(json.Delim)
		if !ok {
			return nil
		}
		switch delimiter {
		case '{':
			seen := map[string]struct{}{}
			for decoder.More() {
				nameToken, err := decoder.Token()
				if err != nil {
					return err
				}
				name, ok := nameToken.(string)
				if !ok {
					return errors.New("invalid object member")
				}
				if _, duplicate := seen[name]; duplicate {
					return errors.New("duplicate object member")
				}
				seen[name] = struct{}{}
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim('}') {
				return errors.New("invalid object")
			}
		case '[':
			for decoder.More() {
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			end, err := decoder.Token()
			if err != nil || end != json.Delim(']') {
				return errors.New("invalid array")
			}
		default:
			return errors.New("invalid JSON delimiter")
		}
		return nil
	}
	if err := parse(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

func offlineV3CanonicalHash(value any) (string, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func offlineV3PublicJWK(raw json.RawMessage, use, algorithm string) (*jose.JSONWebKey, string, error) {
	if len(raw) == 0 || len(raw) > 2048 || offlineV3ValidateJSON(raw) != nil {
		return nil, "", errors.New("invalid public JWK")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil, "", errors.New("invalid public JWK")
	}
	for name := range fields {
		switch name {
		case "kty", "crv", "x", "y", "use", "alg", "kid":
		default:
			return nil, "", errors.New("invalid public JWK member")
		}
	}
	var key jose.JSONWebKey
	if json.Unmarshal(raw, &key) != nil || !key.Valid() || !key.IsPublic() || key.Use != use || key.Algorithm != algorithm ||
		len(key.KeyID) < 1 || len(key.KeyID) > 128 || strings.TrimSpace(key.KeyID) != key.KeyID {
		return nil, "", errors.New("invalid public JWK")
	}
	publicKey, ok := key.Key.(*ecdsa.PublicKey)
	if !ok || publicKey.Curve != elliptic.P256() {
		return nil, "", errors.New("invalid public JWK curve")
	}
	thumbprint, err := key.Thumbprint(crypto.SHA256)
	if err != nil {
		return nil, "", err
	}
	return &key, base64.RawURLEncoding.EncodeToString(thumbprint), nil
}

func offlineV3VerifyProof(compact, typ string, key *jose.JSONWebKey, expected offlineV3ProofClaims) error {
	if key == nil || len(compact) < 64 || len(compact) > 16<<10 || strings.TrimSpace(compact) != compact || strings.Count(compact, ".") != 2 {
		return errors.New("invalid proof")
	}
	object, err := jose.ParseSignedCompact(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return errors.New("invalid proof")
	}
	header := object.Signatures[0].Header
	headerType, _ := header.ExtraHeaders[jose.HeaderType].(string)
	if header.Algorithm != string(jose.ES256) || header.KeyID != key.KeyID || headerType != typ || header.JSONWebKey != nil {
		return errors.New("invalid proof header")
	}
	payload, err := object.Verify(key)
	if err != nil || len(payload) > 4096 || offlineV3ValidateJSON(payload) != nil {
		return errors.New("invalid proof signature")
	}
	var claims offlineV3ProofClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil {
		return errors.New("invalid proof claims")
	}
	now := time.Now().UTC()
	issued := time.Unix(claims.IssuedAt, 0)
	if claims.Version != domain.OfflineV3ProtocolVersion || claims.Purpose != expected.Purpose || claims.ChallengeID != expected.ChallengeID ||
		claims.InstallationID != expected.InstallationID || claims.WindowsPrincipalID != expected.WindowsPrincipalID ||
		claims.BrowserProfileID != expected.BrowserProfileID || claims.AuthorizationID != expected.AuthorizationID ||
		claims.GrantID != expected.GrantID || claims.Nonce != expected.Nonce ||
		claims.Counter != expected.Counter || claims.RequestHash != expected.RequestHash || claims.ID == uuid.Nil ||
		issued.Before(now.Add(-offlineV3ProofClockSkew)) || issued.After(now.Add(30*time.Second)) {
		return errors.New("proof binding mismatch")
	}
	return nil
}

func offlineV3SealJSON(publicRaw json.RawMessage, value any, typ, contentType string) (string, string, error) {
	plaintext, err := json.Marshal(value)
	if err != nil || len(plaintext) > offlineV3MaxJSONBody {
		return "", "", errors.New("offline envelope payload too large")
	}
	compact, err := offlineV3SealBytes(publicRaw, plaintext, typ, contentType)
	if err != nil {
		return "", "", err
	}
	digest := sha256.Sum256(plaintext)
	return compact, hex.EncodeToString(digest[:]), nil
}

func offlineV3SealBytes(publicRaw json.RawMessage, plaintext []byte, typ, contentType string) (string, error) {
	key, _, err := offlineV3PublicJWK(publicRaw, "enc", string(jose.ECDH_ES_A256KW))
	if err != nil {
		return "", err
	}
	maxPlaintext := offlineV3MaxJSONBody
	if typ == offlineV3SnapshotJWE && contentType == "clarin-offline-snapshot+jws" {
		maxPlaintext = offlineV3MaxSnapshotJWS
	}
	if len(plaintext) < 64 || len(plaintext) > maxPlaintext {
		return "", errors.New("offline envelope payload too large")
	}
	options := new(jose.EncrypterOptions).WithType(jose.ContentType(typ)).WithContentType(jose.ContentType(contentType)).WithHeader("kid", key.KeyID)
	encrypter, err := jose.NewEncrypter(jose.A256GCM, jose.Recipient{Algorithm: jose.ECDH_ES_A256KW, Key: key.Key}, options)
	if err != nil {
		return "", err
	}
	object, err := encrypter.Encrypt(plaintext)
	if err != nil {
		return "", err
	}
	compact, err := object.CompactSerialize()
	if err != nil {
		return "", err
	}
	return compact, nil
}

type offlineV3SignerResponse struct {
	Token      string `json:"token"`
	KeyID      string `json:"key_id"`
	KeyVersion int    `json:"key_version"`
}

type offlineV3SignerKeySet struct {
	Keys       []json.RawMessage `json:"keys"`
	KeyID      string            `json:"key_id"`
	KeyVersion int               `json:"key_version"`
}

func offlineV3SignerRouteAllowed(method, path string) bool {
	switch method + " " + path {
	case http.MethodGet + " /v3/public-keys",
		http.MethodGet + " /v3/sync-public-keys",
		http.MethodPost + " /v3/sign-service-descriptor",
		http.MethodPost + " /v3/sign-grant-bootstrap",
		http.MethodPost + " /v3/sign-lease",
		http.MethodPost + " /v3/sign-control",
		http.MethodPost + " /v3/sign-snapshot",
		http.MethodPost + " /v3/sign-receipt",
		http.MethodPost + " /v3/decrypt-operation":
		return true
	default:
		return false
	}
}

func (s *Server) offlineV3SignerCall(ctx context.Context, method, path string, input any, output any) error {
	if s.cfg == nil || !s.cfg.OfflineV3Enabled || output == nil || !offlineV3SignerRouteAllowed(method, path) {
		return errors.New("offline v3 signer unavailable")
	}
	token, err := s.offlineSignerToken()
	if err != nil {
		return err
	}
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil || len(raw) > offlineV3MaxSignerBody {
			return errors.New("invalid offline v3 signer request")
		}
		body = bytes.NewReader(raw)
	}
	request, err := http.NewRequestWithContext(ctx, method, s.cfg.OfflineSignerAddress+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("X-Clarin-Signer-Token", token)
	request.Header.Set("Accept", "application/json")
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client, err := s.offlineSignerHTTPClient()
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		return fmt.Errorf("offline v3 signer returned status %d", response.StatusCode)
	}
	limited := &io.LimitedReader{R: response.Body, N: offlineV3MaxSignerBody + 1}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("invalid offline v3 signer response")
	}
	if limited.N == 0 {
		return errors.New("offline v3 signer response too large")
	}
	return nil
}
