package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type offlineSignerSignResponse struct {
	Signature  string   `json:"signature"`
	KeyVersion int      `json:"key_version"`
	Errors     []string `json:"errors"`
}

type offlineSignerPublicKeyResponse struct {
	KeyVersion   int      `json:"key_version"`
	PublicKeyPEM string   `json:"public_key_pem"`
	Errors       []string `json:"errors"`
}

func (s *Server) signOfflinePayload(ctx context.Context, payload []byte) (string, int, error) {
	digest := sha256.Sum256(payload)
	requestBody, err := json.Marshal(map[string]string{"digest": base64.StdEncoding.EncodeToString(digest[:])})
	if err != nil {
		return "", 0, err
	}
	token, err := s.offlineSignerToken()
	if err != nil {
		return "", 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.OfflineSignerAddress+"/v1/sign", bytes.NewReader(requestBody))
	if err != nil {
		return "", 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Clarin-Signer-Token", token)
	client, err := s.offlineSignerHTTPClient()
	if err != nil {
		return "", 0, err
	}
	response, err := client.Do(request)
	if err != nil {
		return "", 0, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", 0, err
	}
	var signed offlineSignerSignResponse
	if err := json.Unmarshal(raw, &signed); err != nil {
		return "", 0, err
	}
	if response.StatusCode/100 != 2 || signed.Signature == "" || signed.KeyVersion < 1 {
		return "", 0, fmt.Errorf("offline signer rejected request: %d", response.StatusCode)
	}
	return signed.Signature, signed.KeyVersion, nil
}

func (s *Server) offlineSignerToken() (string, error) {
	if s.cfg == nil {
		return "", errors.New("offline signer is not configured")
	}
	raw, err := os.ReadFile(s.cfg.OfflineSignerTokenFile)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", errors.New("empty offline signer token")
	}
	return token, nil
}

func (s *Server) offlineSignerHTTPClient() (*http.Client, error) {
	if s.cfg == nil {
		return nil, errors.New("offline signer is not configured")
	}
	parsed, err := url.Parse(s.cfg.OfflineSignerAddress)
	if err != nil || parsed.Scheme != "http" || parsed.Host != "clarin-offline-signer:8200" || parsed.Path != "" || parsed.RawQuery != "" || parsed.User != nil {
		return nil, errors.New("offline signer must use its private Docker address")
	}
	return &http.Client{Timeout: 15 * time.Second}, nil
}

func (s *Server) offlineSignerKey(ctx context.Context, token string, requestedVersion int) (int, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.OfflineSignerAddress+"/v1/public-key", nil)
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("X-Clarin-Signer-Token", token)
	client, err := s.offlineSignerHTTPClient()
	if err != nil {
		return 0, "", err
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return 0, "", err
	}
	var decoded offlineSignerPublicKeyResponse
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return 0, "", err
	}
	if response.StatusCode/100 != 2 || decoded.KeyVersion < 1 || decoded.PublicKeyPEM == "" {
		return 0, "", errors.New("offline signer public key unavailable")
	}
	if requestedVersion > 0 && requestedVersion != decoded.KeyVersion {
		return 0, "", errors.New("requested offline signer key version is unavailable")
	}
	return decoded.KeyVersion, decoded.PublicKeyPEM, nil
}
