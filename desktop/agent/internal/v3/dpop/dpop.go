package dpop

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"
)

const Type = "dpop+jwt"

var (
	ErrInvalid = errors.New("invalid_dpop")
	ErrReplay  = errors.New("dpop_replay")
)

type Claims struct {
	JWTID      string `json:"jti"`
	Method     string `json:"htm"`
	URI        string `json:"htu"`
	IssuedAt   int64  `json:"iat"`
	Nonce      string `json:"nonce"`
	AccessHash string `json:"ath,omitempty"`
}

type Result struct {
	Claims     Claims
	PublicJWK  jose.JSONWebKey
	Thumbprint string
}

type Verifier struct {
	mu      sync.Mutex
	seen    map[string]time.Time
	now     func() time.Time
	maxSeen int
}

func NewVerifier() *Verifier {
	return &Verifier{seen: make(map[string]time.Time), now: time.Now, maxSeen: 10000}
}

func (v *Verifier) VerifyEnrolling(token, method, uri, nonce string) (*Result, error) {
	return v.verify(token, method, uri, nonce, "", "", nil, true)
}

func (v *Verifier) Verify(token, browserProfileID string, publicJWK jose.JSONWebKey, method, uri, nonce string, capability []byte) (*Result, error) {
	return v.verify(token, method, uri, nonce, browserProfileID, accessHash(capability), &publicJWK, false)
}

// ExtractNonce is only a bounded routing hint used to select a server-issued
// nonce before full signature verification. Its result must never be trusted
// for authorization by itself.
func ExtractNonce(token string) (string, error) {
	if token == "" || len(token) > 32<<10 {
		return "", ErrInvalid
	}
	object, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return "", ErrInvalid
	}
	var claims Claims
	decoder := json.NewDecoder(bytes.NewReader(object.UnsafePayloadWithoutVerification()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return "", ErrInvalid
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) || claims.Nonce == "" || len(claims.Nonce) > 256 {
		return "", ErrInvalid
	}
	return claims.Nonce, nil
}

func (v *Verifier) verify(token, method, uri, nonce, expectedKeyID, expectedAccessHash string, trusted *jose.JSONWebKey, enrolling bool) (*Result, error) {
	if token == "" || method == "" || uri == "" || nonce == "" || len(token) > 32<<10 {
		return nil, ErrInvalid
	}
	object, err := jose.ParseSignedCompact(token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(object.Signatures) != 1 {
		return nil, ErrInvalid
	}
	signature := object.Signatures[0]
	if signature.Protected.Algorithm != string(jose.ES256) || headerString(signature.Protected, jose.HeaderType) != Type || signature.Unprotected.Algorithm != "" || signature.Unprotected.KeyID != "" || len(signature.Unprotected.ExtraHeaders) != 0 {
		return nil, ErrInvalid
	}
	var public jose.JSONWebKey
	if enrolling {
		if signature.Protected.KeyID != "" || signature.Protected.JSONWebKey == nil {
			return nil, ErrInvalid
		}
		public = signature.Protected.JSONWebKey.Public()
	} else {
		if signature.Protected.KeyID != expectedKeyID || signature.Protected.JSONWebKey != nil || trusted == nil {
			return nil, ErrInvalid
		}
		public = trusted.Public()
	}
	key, ok := public.Key.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() || !public.Valid() || !public.IsPublic() {
		return nil, ErrInvalid
	}
	payload, err := object.Verify(key)
	if err != nil {
		return nil, ErrInvalid
	}
	var claims Claims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&claims); err != nil {
		return nil, ErrInvalid
	}
	now := v.now().UTC()
	issuedAt := time.Unix(claims.IssuedAt, 0).UTC()
	if parsed, err := uuid.Parse(claims.JWTID); err != nil || parsed.String() != strings.ToLower(claims.JWTID) || claims.Method != strings.ToUpper(method) || claims.URI != uri || claims.Nonce != nonce || issuedAt.Before(now.Add(-60*time.Second)) || issuedAt.After(now.Add(60*time.Second)) || claims.AccessHash != expectedAccessHash {
		return nil, ErrInvalid
	}
	thumbprint, err := (&public).Thumbprint(crypto.SHA256)
	if err != nil {
		return nil, ErrInvalid
	}
	encodedThumbprint := base64.RawURLEncoding.EncodeToString(thumbprint)
	if err := v.markSeen(encodedThumbprint+":"+claims.JWTID, now); err != nil {
		return nil, err
	}
	return &Result{Claims: claims, PublicJWK: public, Thumbprint: encodedThumbprint}, nil
}

func (v *Verifier) markSeen(key string, now time.Time) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	for item, expiresAt := range v.seen {
		if !expiresAt.After(now) {
			delete(v.seen, item)
		}
	}
	if _, exists := v.seen[key]; exists {
		return ErrReplay
	}
	if len(v.seen) >= v.maxSeen {
		return ErrInvalid
	}
	v.seen[key] = now.Add(2 * time.Minute)
	return nil
}

func accessHash(capability []byte) string {
	if len(capability) == 0 {
		return ""
	}
	digest := sha256.Sum256(capability)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func headerString(header jose.Header, key jose.HeaderKey) string {
	value, ok := header.ExtraHeaders[key]
	if !ok {
		return ""
	}
	text, _ := value.(string)
	return text
}
