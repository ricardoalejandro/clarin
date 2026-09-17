package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

const offlineV4ProofType = "clarin-offline-v4-proof+jwt"

type offlineV4Proof struct {
	Version          int       `json:"version"`
	Purpose          string    `json:"purpose"`
	ChallengeID      uuid.UUID `json:"challenge_id"`
	Nonce            string    `json:"nonce"`
	Method           string    `json:"method"`
	Path             string    `json:"path"`
	BodySHA256       string    `json:"body_sha256"`
	Audience         string    `json:"aud"`
	BrowserProfileID uuid.UUID `json:"browser_profile_id"`
	GrantID          uuid.UUID `json:"grant_id,omitempty"`
	IssuedAt         int64     `json:"iat"`
	ExpiresAt        int64     `json:"exp"`
	ID               uuid.UUID `json:"jti"`
}

func validOfflineV4Origin(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" || u.String() != value {
		return false
	}
	if u.Scheme == "https" {
		return true
	}
	return u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")
}

func verifyOfflineV4Proof(compact string, key *jose.JSONWebKey, expected offlineV4Proof, body []byte, now time.Time) error {
	if key == nil || len(compact) < 64 || len(compact) > 8192 || strings.TrimSpace(compact) != compact {
		return errors.New("invalid offline proof")
	}
	signed, err := jose.ParseSignedCompact(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(signed.Signatures) != 1 {
		return errors.New("invalid offline proof")
	}
	header := signed.Signatures[0].Protected
	if header.Algorithm != string(jose.ES256) || header.ExtraHeaders[jose.HeaderType] != offlineV4ProofType {
		return errors.New("invalid offline proof type")
	}
	for name := range header.ExtraHeaders {
		if name != jose.HeaderType {
			return errors.New("unsupported offline proof header")
		}
	}
	if header.JSONWebKey != nil || header.KeyID != "" && header.KeyID != key.KeyID {
		return errors.New("unsupported offline proof key")
	}
	payload, err := signed.Verify(key)
	if err != nil || offlineV3ValidateJSON(payload) != nil {
		return errors.New("invalid offline proof signature")
	}
	var p offlineV4Proof
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&p) != nil {
		return errors.New("invalid offline proof claims")
	}
	hash := sha256.Sum256(body)
	if p.Version != 4 || p.Purpose != expected.Purpose || p.ChallengeID == uuid.Nil || p.ChallengeID != expected.ChallengeID || p.Nonce != expected.Nonce || len(p.Nonce) != 43 || p.Method != expected.Method || p.Path != expected.Path || p.Audience != expected.Audience || p.BrowserProfileID != expected.BrowserProfileID || p.BrowserProfileID == uuid.Nil || p.GrantID != expected.GrantID || p.BodySHA256 != hex.EncodeToString(hash[:]) || p.ID == uuid.Nil {
		return errors.New("offline proof binding mismatch")
	}
	if p.IssuedAt > now.Add(time.Minute).Unix() || p.IssuedAt < now.Add(-2*time.Minute).Unix() || p.ExpiresAt <= now.Unix() || p.ExpiresAt <= p.IssuedAt || p.ExpiresAt-p.IssuedAt > 120 {
		return errors.New("offline proof expired")
	}
	return nil
}

func (s *Server) offlineV4ExpectedProof(c *fiber.Ctx, purpose string, challengeID, profileID, grantID uuid.UUID, nonce string) offlineV4Proof {
	return offlineV4Proof{Version: 4, Purpose: purpose, ChallengeID: challengeID, Nonce: nonce, Method: c.Method(), Path: c.Path(), Audience: s.cfg.OfflineV4ServerOrigin, BrowserProfileID: profileID, GrantID: grantID}
}

func (s *Server) offlineV4SignerCall(ctx context.Context, method, path string, input, output any) error {
	if s.cfg == nil || !s.cfg.OfflineV4Enabled || output == nil || !(method == http.MethodGet && path == "/v4/public-keys" || method == http.MethodPost && path == "/v4/sign-lease") {
		return errors.New("offline v4 signer unavailable")
	}
	token, err := s.offlineSignerToken()
	if err != nil {
		return err
	}
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil || len(raw) > 16384 {
			return errors.New("invalid offline signer input")
		}
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, s.cfg.OfflineSignerAddress+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("X-Clarin-Signer-Token", token)
	req.Header.Set("Accept", "application/json")
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client, err := s.offlineSignerHTTPClient()
	if err != nil {
		return err
	}
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("offline v4 signer status %d", res.StatusCode)
	}
	limited := &io.LimitedReader{R: res.Body, N: 65537}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(output); err != nil {
		return err
	}
	if limited.N == 0 {
		return errors.New("offline signer response too large")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid signer response")
	}
	return nil
}
