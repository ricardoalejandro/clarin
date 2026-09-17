package main

import (
	"crypto/ecdsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	jose "github.com/go-jose/go-jose/v4"
)

const v3MaxOperationEnvelope = 2 << 20

func v3IntakeKeyID(version int) string { return fmt.Sprintf("clarin-offline-v3-intake-%d", version) }

func loadV3IntakeKeys(directory string, version int) (map[string]*ecdsa.PrivateKey, error) {
	if _, err := loadOrCreateKey(filepath.Join(directory, fmt.Sprintf("offline-v3-intake-%d.key", version))); err != nil {
		return nil, err
	}
	paths, err := filepath.Glob(filepath.Join(directory, "offline-v3-intake-*.key"))
	if err != nil {
		return nil, err
	}
	keys := map[string]*ecdsa.PrivateKey{}
	for _, path := range paths {
		keyVersion, err := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(filepath.Base(path), "offline-v3-intake-"), ".key"))
		if err != nil || keyVersion < 3 || keyVersion > version {
			return nil, errors.New("invalid intake key version or downgrade")
		}
		key, err := loadOrCreateKey(path)
		if err != nil {
			return nil, err
		}
		keys[v3IntakeKeyID(keyVersion)] = key
	}
	return keys, nil
}

func (s *v3Signer) syncPublicKeys(w http.ResponseWriter, _ *http.Request) {
	keys := []jose.JSONWebKey{}
	for id, key := range s.intakeKeys {
		keys = append(keys, jose.JSONWebKey{Key: &key.PublicKey, KeyID: id, Use: "enc", Algorithm: string(jose.ECDH_ES_A256KW)})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].KeyID < keys[j].KeyID })
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"keys": keys, "key_id": v3IntakeKeyID(s.version), "key_version": s.version})
}

func (s *v3Signer) decryptOperation(w http.ResponseWriter, r *http.Request) {
	// This endpoint is reachable only by the authenticated backend on the
	// private service network. It does not accept general-purpose ciphertext.
	var input struct {
		CompactJWE string `json:"compact_jwe"`
	}
	if decodeV3RequestLimit(w, r, &input, v3MaxOperationEnvelope+1024) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_operation_envelope"})
		return
	}
	payload, keyID, err := s.openOperation(input.CompactJWE)
	if err != nil {
		// Uniform failures do not reveal whether a historical key still exists.
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_offline_operation_envelope"})
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"payload": payload, "key_id": keyID, "key_version": s.version})
}

func (s *v3Signer) openOperation(compact string) (string, string, error) {
	invalid := errors.New("invalid offline operation envelope")
	if len(compact) < 64 || len(compact) > v3MaxOperationEnvelope || strings.TrimSpace(compact) != compact {
		return "", "", invalid
	}
	parts := strings.Split(compact, ".")
	if len(parts) != 5 || len(parts[0]) > 4096 {
		return "", "", invalid
	}
	headerBytes, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		return "", "", invalid
	}
	headerDecoder := json.NewDecoder(strings.NewReader(string(headerBytes)))
	if checkV3JSONValue(headerDecoder, 0) != nil {
		return "", "", invalid
	}
	var header map[string]json.RawMessage
	if json.Unmarshal(headerBytes, &header) != nil {
		return "", "", invalid
	}
	for name := range header {
		switch name {
		case "alg", "enc", "typ", "cty", "kid", "epk", "apu", "apv":
		default:
			return "", "", invalid
		}
	}
	field := func(name string) string { var value string; _ = json.Unmarshal(header[name], &value); return value }
	if field("alg") != string(jose.ECDH_ES_A256KW) || field("enc") != string(jose.A256GCM) || field("typ") != "clarin-offline-operation+jwe" || field("cty") != "clarin-offline-operation+jws" {
		return "", "", invalid
	}
	keyID := field("kid")
	key := s.intakeKeys[keyID]
	if key == nil {
		return "", "", invalid
	}
	object, err := jose.ParseEncryptedCompact(compact, []jose.KeyAlgorithm{jose.ECDH_ES_A256KW}, []jose.ContentEncryption{jose.A256GCM})
	if err != nil {
		return "", "", invalid
	}
	plaintext, err := object.Decrypt(key)
	if err != nil {
		return "", "", invalid
	}
	defer func() {
		for i := range plaintext {
			plaintext[i] = 0
		}
	}()
	// Signature ownership and complete binding are checked by the backend with
	// the grant's public key; unverified claims are never authorization here.
	if strings.Count(string(plaintext), ".") != 2 || len(plaintext) > v3MaxOperationEnvelope {
		return "", "", invalid
	}
	if _, err := jose.ParseSignedCompact(string(plaintext), []jose.SignatureAlgorithm{jose.ES256}); err != nil {
		return "", "", invalid
	}
	return string(plaintext), keyID, nil
}
