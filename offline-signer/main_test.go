package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSignerRequiresTokenAndReturnsVerifiableClarinSignature(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	token := "test-token"
	s := &signer{privateKey: key, publicPEM: "public", tokenHash: sha256.Sum256([]byte(token))}

	unauthorized := httptest.NewRecorder()
	s.authorized(s.publicKey)(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/public-key", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("public key endpoint accepted a missing token: %d", unauthorized.Code)
	}

	digest := sha256.Sum256([]byte("lease"))
	body, err := json.Marshal(map[string]string{"digest": base64.StdEncoding.EncodeToString(digest[:])})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/sign", bytes.NewReader(body))
	request.Header.Set("X-Clarin-Signer-Token", token)
	response := httptest.NewRecorder()
	s.authorized(s.sign)(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("signing failed: %d %s", response.Code, response.Body.String())
	}
	var decoded struct {
		Signature  string `json:"signature"`
		KeyVersion int    `json:"key_version"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(decoded.Signature, ":")
	if len(parts) != 3 || parts[0] != "clarin" || parts[1] != "v1" || decoded.KeyVersion != 1 {
		t.Fatalf("unexpected signature envelope: %#v", decoded)
	}
	signature, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil || !ecdsa.VerifyASN1(&key.PublicKey, digest[:], signature) {
		t.Fatal("signer response did not verify with its public key")
	}
}

func TestSignerRejectsInvalidDigest(t *testing.T) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s := &signer{privateKey: key}
	response := httptest.NewRecorder()
	s.sign(response, httptest.NewRequest(http.MethodPost, "/v1/sign", strings.NewReader(`{"digest":"short"}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("invalid digest returned %d", response.Code)
	}
}
