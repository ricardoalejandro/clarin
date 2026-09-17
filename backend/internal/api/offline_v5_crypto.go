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
	"strings"
	"time"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

const offlineV5ProofType = "clarin-offline-v5-proof+jwt"

type offlineV5Proof struct {
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

func verifyOfflineV5Proof(compact string, key *jose.JSONWebKey, expected offlineV5Proof, body []byte, now time.Time) error {
	if key == nil || len(compact) < 64 || len(compact) > 8192 || strings.TrimSpace(compact) != compact {
		return errors.New("invalid offline v5 proof")
	}
	signed, err := jose.ParseSignedCompact(compact, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil || len(signed.Signatures) != 1 {
		return errors.New("invalid offline v5 proof")
	}
	header := signed.Signatures[0].Protected
	if header.Algorithm != string(jose.ES256) || header.ExtraHeaders[jose.HeaderType] != offlineV5ProofType {
		return errors.New("invalid offline v5 proof type")
	}
	for name := range header.ExtraHeaders {
		if name != jose.HeaderType {
			return errors.New("unsupported offline v5 proof header")
		}
	}
	if header.JSONWebKey != nil || (header.KeyID != "" && header.KeyID != key.KeyID) {
		return errors.New("unsupported offline v5 proof key")
	}
	payload, err := signed.Verify(key)
	if err != nil || offlineV3ValidateJSON(payload) != nil {
		return errors.New("invalid offline v5 proof signature")
	}
	var proof offlineV5Proof
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&proof) != nil || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid offline v5 proof claims")
	}
	hash := sha256.Sum256(body)
	if proof.Version != 5 || proof.Purpose != expected.Purpose || proof.ChallengeID == uuid.Nil ||
		proof.ChallengeID != expected.ChallengeID || proof.Nonce != expected.Nonce || len(proof.Nonce) != 43 ||
		proof.Method != expected.Method || proof.Path != expected.Path || proof.Audience != expected.Audience ||
		proof.BrowserProfileID == uuid.Nil || proof.BrowserProfileID != expected.BrowserProfileID || proof.GrantID != expected.GrantID ||
		proof.BodySHA256 != hex.EncodeToString(hash[:]) || proof.ID == uuid.Nil {
		return errors.New("offline v5 proof binding mismatch")
	}
	if proof.IssuedAt > now.Add(time.Minute).Unix() || proof.IssuedAt < now.Add(-2*time.Minute).Unix() ||
		proof.ExpiresAt <= now.Unix() || proof.ExpiresAt <= proof.IssuedAt || proof.ExpiresAt-proof.IssuedAt > 120 {
		return errors.New("offline v5 proof expired")
	}
	return nil
}

func (s *Server) offlineV5ExpectedProof(c *fiber.Ctx, purpose string, challengeID, profileID, grantID uuid.UUID, nonce string) offlineV5Proof {
	return offlineV5Proof{Version: 5, Purpose: purpose, ChallengeID: challengeID, Nonce: nonce,
		Method: c.Method(), Path: c.Path(), Audience: s.cfg.OfflineV5ServerOrigin,
		BrowserProfileID: profileID, GrantID: grantID}
}

// The isolated signer currently exposes its mature v4 ES256 surface. In v5
// that token is a detached signature over selection_digest=manifest.digest;
// its legacy actions are explicitly ignored as v5 authority.
func (s *Server) offlineV5SignerCall(ctx context.Context, method, path string, input, output any) error {
	if s.cfg == nil || !s.cfg.OfflineV5Enabled || output == nil ||
		!((method == http.MethodGet && path == "/v4/public-keys") || (method == http.MethodPost && path == "/v4/sign-lease")) {
		return errors.New("offline v5 signer unavailable")
	}
	token, err := s.offlineSignerToken()
	if err != nil {
		return err
	}
	var body io.Reader
	if input != nil {
		raw, err := json.Marshal(input)
		if err != nil || len(raw) > 16384 {
			return errors.New("invalid offline v5 signer input")
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
		return fmt.Errorf("offline v5 signer status %d", res.StatusCode)
	}
	limited := &io.LimitedReader{R: res.Body, N: 65537}
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil || limited.N == 0 || decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid offline v5 signer response")
	}
	return nil
}
