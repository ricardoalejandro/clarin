package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	keyPath   = "/data/offline-leases.key"
	tokenPath = "/auth/token"
)

type signer struct {
	privateKey *ecdsa.PrivateKey
	publicPEM  string
	tokenHash  [sha256.Size]byte
	v3         *v3Signer
	v4         *v4Signer
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "healthcheck" {
		if err := checkHealth("http://127.0.0.1:8200/health"); err != nil {
			log.Fatal(err)
		}
		return
	}
	privateKey, err := loadOrCreateKey(keyPath)
	if err != nil {
		log.Fatal(err)
	}
	token, err := loadOrCreateToken(tokenPath)
	if err != nil {
		log.Fatal(err)
	}
	publicDER, err := x509.MarshalPKIXPublicKey(&privateKey.PublicKey)
	if err != nil {
		log.Fatal(err)
	}
	s := &signer{privateKey: privateKey, publicPEM: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: publicDER})), tokenHash: sha256.Sum256([]byte(token))}
	s.v3, err = loadV3Signer("/data", os.Getenv("OFFLINE_V3_SIGNING_KEY_VERSION"))
	if err != nil {
		log.Fatal(err)
	}
	s.v4, err = loadV4Signer("/data", os.Getenv("OFFLINE_V4_SIGNING_KEY_VERSION"), os.Getenv("OFFLINE_V4_SERVER_ORIGIN"))
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
	})
	mux.HandleFunc("GET /v1/public-key", s.authorized(s.publicKey))
	mux.HandleFunc("POST /v1/sign", s.authorized(s.sign))
	mux.HandleFunc("GET /v3/public-keys", s.authorized(s.v3.publicKeys))
	mux.HandleFunc("POST /v3/sign-lease", s.authorized(s.v3.signLease))
	mux.HandleFunc("POST /v3/sign-control", s.authorized(s.v3.signControl))
	mux.HandleFunc("GET /v3/sync-public-keys", s.authorized(s.v3.syncPublicKeys))
	mux.HandleFunc("POST /v3/decrypt-operation", s.authorized(s.v3.decryptOperation))
	mux.HandleFunc("POST /v3/sign-service-descriptor", s.authorized(s.v3.signServiceDescriptor))
	mux.HandleFunc("POST /v3/sign-grant-bootstrap", s.authorized(s.v3.signGrantBootstrap))
	mux.HandleFunc("POST /v3/sign-snapshot", s.authorized(s.v3.signSnapshot))
	mux.HandleFunc("POST /v3/sign-receipt", s.authorized(s.v3.signReceipt))
	mux.HandleFunc("GET /v4/public-keys", s.authorized(s.v4.publicKeys))
	mux.HandleFunc("POST /v4/sign-lease", s.authorized(s.v4.signLease))
	server := &http.Server{Addr: ":8200", Handler: mux, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	log.Print("Clarin offline signer listening on :8200")
	log.Fatal(server.ListenAndServe())
}

func (s *signer) authorized(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimSpace(r.Header.Get("X-Clarin-Signer-Token"))
		hash := sha256.Sum256([]byte(provided))
		if provided == "" || subtle.ConstantTimeCompare(hash[:], s.tokenHash[:]) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"errors": []string{"unauthorized"}})
			return
		}
		next(w, r)
	}
}

func (s *signer) publicKey(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"key_version": 1, "public_key_pem": s.publicPEM})
}

func (s *signer) sign(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		Digest string `json:"digest"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"errors": []string{"invalid signing request"}})
		return
	}
	digest, err := base64.StdEncoding.DecodeString(input.Digest)
	if err != nil || len(digest) != sha256.Size {
		writeJSON(w, http.StatusBadRequest, map[string]any{"errors": []string{"SHA-256 digest required"}})
		return
	}
	signature, err := ecdsa.SignASN1(rand.Reader, s.privateKey, digest)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"errors": []string{"signing failed"}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"signature": "clarin:v1:" + base64.StdEncoding.EncodeToString(signature), "key_version": 1})
}

func checkHealth(address string) error {
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Get(address)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("offline signer healthcheck returned %d", response.StatusCode)
	}
	return nil
}

func loadOrCreateKey(path string) (*ecdsa.PrivateKey, error) {
	if raw, err := os.ReadFile(path); err == nil {
		block, _ := pem.Decode(raw)
		if block == nil {
			return nil, errors.New("offline signer key is malformed")
		}
		parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		key, ok := parsed.(*ecdsa.PrivateKey)
		if err != nil || !ok || key.Curve != elliptic.P256() {
			return nil, errors.New("offline signer key is invalid")
		}
		return key, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, err
	}
	if err := writeSecret(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})); err != nil {
		return nil, err
	}
	return key, nil
}

func loadOrCreateToken(path string) (string, error) {
	if raw, err := os.ReadFile(path); err == nil {
		if token := strings.TrimSpace(string(raw)); token != "" {
			return token, nil
		}
		return "", errors.New("offline signer token is empty")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)
	if err := writeSecret(path, []byte(token+"\n")); err != nil {
		return "", err
	}
	return token, nil
}

func writeSecret(path string, value []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o440)
	if err != nil {
		return err
	}
	if _, err := file.Write(value); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil && !errors.Is(err, io.ErrClosedPipe) {
		log.Print(fmt.Errorf("encode response: %w", err))
	}
}
