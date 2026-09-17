package protocol

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const Version = 2

type Envelope struct {
	Payload    string `json:"payload"`
	Signature  string `json:"signature"`
	KeyVersion int    `json:"key_version"`
}

type LeaseClaims struct {
	Version           int             `json:"version"`
	TerminalID        string          `json:"terminal_id"`
	UserID            string          `json:"user_id"`
	AccountID         string          `json:"account_id"`
	BootIDHash        string          `json:"boot_id_hash"`
	Modules           []string        `json:"modules"`
	Actions           json.RawMessage `json:"actions"`
	SelectionRevision int64           `json:"selection_revision"`
	MaxStorageBytes   int64           `json:"max_storage_bytes"`
	IssuedAt          time.Time       `json:"issued_at"`
	ExpiresAt         time.Time       `json:"expires_at"`
}

type ControlDirective struct {
	ID               string    `json:"id"`
	TerminalID       string    `json:"terminal_id"`
	DirectiveType    string    `json:"directive_type"`
	Payload          string    `json:"payload"`
	Signature        string    `json:"signature"`
	SignerKeyVersion int       `json:"signer_key_version"`
	CreatedAt        time.Time `json:"created_at"`
}

type ControlClaims struct {
	Version       int       `json:"version"`
	DirectiveID   string    `json:"directive_id"`
	DirectiveType string    `json:"directive_type"`
	TerminalID    string    `json:"terminal_id"`
	IssuedAt      time.Time `json:"issued_at"`
}

func BodyHash(body []byte) string {
	digest := sha256.Sum256(body)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func CanonicalRequest(method, path, terminalID, accountID, challengeID, nonce string, counter int64, contentType string, body []byte) string {
	return strings.Join([]string{
		"CLARIN-OFFLINE-V2",
		strings.ToUpper(strings.TrimSpace(method)),
		path,
		terminalID,
		accountID,
		challengeID,
		nonce,
		strconv.FormatInt(counter, 10),
		strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0])),
		BodyHash(body),
	}, "\n")
}

func VerifyEnvelope(envelope Envelope, expectedKeyVersion int, publicKeyPEM string) ([]byte, error) {
	if envelope.KeyVersion != expectedKeyVersion || expectedKeyVersion < 1 {
		return nil, errors.New("unexpected signing key version")
	}
	payload, err := base64.RawURLEncoding.DecodeString(envelope.Payload)
	if err != nil {
		return nil, errors.New("invalid signed payload encoding")
	}
	if err := verifyClarinSignature(payload, envelope.Signature, publicKeyPEM, expectedKeyVersion); err != nil {
		return nil, err
	}
	return payload, nil
}

func ValidateLease(envelope Envelope, expectedKeyVersion int, publicKeyPEM, terminalID, accountID, bootIDHash string, now time.Time) (*LeaseClaims, error) {
	payload, err := VerifyEnvelope(envelope, expectedKeyVersion, publicKeyPEM)
	if err != nil {
		return nil, err
	}
	var claims LeaseClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, err
	}
	if claims.Version != Version || claims.TerminalID != terminalID || claims.AccountID != accountID || claims.BootIDHash != bootIDHash {
		return nil, errors.New("lease identity is not bound to this session")
	}
	if claims.MaxStorageBytes <= 0 || claims.MaxStorageBytes > 5*1024*1024*1024 {
		return nil, errors.New("lease storage policy rejected")
	}
	if claims.ExpiresAt.After(claims.IssuedAt.Add(24*time.Hour)) || !claims.ExpiresAt.After(now) || claims.IssuedAt.After(now.Add(5*time.Minute)) {
		return nil, errors.New("lease time bounds rejected")
	}
	return &claims, nil
}

func ValidateControl(directive ControlDirective, expectedKeyVersion int, publicKeyPEM, terminalID string, now time.Time) (*ControlClaims, error) {
	payload, err := VerifyEnvelope(Envelope{Payload: directive.Payload, Signature: directive.Signature, KeyVersion: directive.SignerKeyVersion}, expectedKeyVersion, publicKeyPEM)
	if err != nil {
		return nil, err
	}
	var claims ControlClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, err
	}
	if claims.Version != Version || claims.DirectiveID == "" || claims.DirectiveID != directive.ID || directive.TerminalID != terminalID || claims.TerminalID != terminalID || claims.DirectiveType != directive.DirectiveType {
		return nil, errors.New("control identity rejected")
	}
	if claims.IssuedAt.After(now.Add(5 * time.Minute)) {
		return nil, errors.New("control was issued in the future")
	}
	if claims.DirectiveType != "wipe" && claims.DirectiveType != "lock" && claims.DirectiveType != "policy_refresh" {
		return nil, errors.New("unsupported control directive")
	}
	return &claims, nil
}

func verifyClarinSignature(payload []byte, rawSignature, publicKeyPEM string, expectedKeyVersion int) error {
	parts := strings.Split(rawSignature, ":")
	if len(parts) != 3 || parts[0] != "clarin" || parts[1] != "v"+strconv.Itoa(expectedKeyVersion) {
		return errors.New("unsupported signature")
	}
	signature, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return errors.New("invalid signature encoding")
	}
	block, trailing := pemDecode([]byte(publicKeyPEM))
	if block == nil || strings.TrimSpace(string(trailing)) != "" {
		return errors.New("invalid public key")
	}
	parsed, err := x509.ParsePKIXPublicKey(block)
	if err != nil {
		return err
	}
	key, ok := parsed.(*ecdsa.PublicKey)
	if !ok || key.Curve != elliptic.P256() {
		return errors.New("signing key is not ECDSA P-256")
	}
	digest := sha256.Sum256(payload)
	if !ecdsa.VerifyASN1(key, digest[:], signature) {
		return errors.New("signature mismatch")
	}
	return nil
}

// pemDecode is kept small so protocol verification has no platform dependency.
func pemDecode(raw []byte) ([]byte, []byte) {
	const begin = "-----BEGIN PUBLIC KEY-----"
	const end = "-----END PUBLIC KEY-----"
	text := string(raw)
	start := strings.Index(text, begin)
	finish := strings.Index(text, end)
	if start < 0 || finish < start {
		return nil, raw
	}
	encoded := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, text[start+len(begin):finish])
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, raw
	}
	return decoded, []byte(text[finish+len(end):])
}

func RequestDigest(canonical string) []byte {
	digest := sha256.Sum256([]byte(canonical))
	return digest[:]
}

func ValidateHexHash(value string) error {
	if len(value) != 64 {
		return fmt.Errorf("hash must have 64 hexadecimal characters")
	}
	for _, r := range strings.ToLower(value) {
		if !strings.ContainsRune("0123456789abcdef", r) {
			return errors.New("hash is not hexadecimal")
		}
	}
	return nil
}
