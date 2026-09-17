package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	jose "github.com/go-jose/go-jose/v4"
)

func testV3Tuple() v3DataTuple {
	return v3DataTuple{testV3ID, testV3ID, testV3ID, testV3ID, testV3ID, testV3ID, testV3ID}
}

func testV3Snapshot(s *v3Signer) v3Snapshot {
	payload := json.RawMessage(`{"tasks":[{"title":"A","nested":{"a":{"b":[1]}}}]}`)
	hash := sha256.Sum256(payload)
	return v3Snapshot{Issuer: v3Issuer, Audience: "clarin-offline-snapshot", IssuedAt: s.now().Unix(), ID: testV3ID, Version: 3, Kind: "snapshot", Tuple: testV3Tuple(), SelectionID: testV3ID, Module: "tasks", ResourceType: "task_list", ResourceID: testV3ID, SelectionRevision: 1, HeadVersion: 1, ContentHash: hex.EncodeToString(hash[:]), Payload: payload}
}

func signedDataPayload(t *testing.T, s *v3Signer, value any, handler http.HandlerFunc, typ string) []byte {
	t.Helper()
	body, _ := json.Marshal(value)
	w := httptest.NewRecorder()
	handler(w, httptest.NewRequest("POST", "/", bytes.NewReader(body)))
	if w.Code != 200 {
		t.Fatalf("sign: %d %s", w.Code, w.Body.String())
	}
	var result struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &result)
	object, err := jose.ParseSignedCompact(result.Token, []jose.SignatureAlgorithm{jose.ES256})
	if err != nil {
		t.Fatal(err)
	}
	if object.Signatures[0].Protected.ExtraHeaders["typ"] != typ {
		t.Fatal("wrong signature purpose")
	}
	payload, err := object.Verify(&s.key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(payload, []byte(`"exp"`)) {
		t.Fatal("data signature became expiring access token")
	}
	return payload
}

func TestV3DataSignaturesPurposeDigestAndDeepPayload(t *testing.T) {
	s := newTestV3Signer(t)
	snapshot := testV3Snapshot(s)
	signedDataPayload(t, s, snapshot, s.signSnapshot, "clarin-offline-snapshot+jws")
	receipt := v3Receipt{Issuer: v3Issuer, Audience: "clarin-offline-receipt", IssuedAt: s.now().Unix(), ID: testV3ID, Version: 3, Kind: "receipt", Tuple: testV3Tuple(), OperationID: testV3ID, RequestHash: strings.Repeat("a", 64), Status: "applied", ResourceID: testV3ID, ServerVersion: 1, Result: json.RawMessage(`{"task":{"version":1}}`)}
	signedDataPayload(t, s, receipt, s.signReceipt, "clarin-offline-receipt+jws")
	for name, mutate := range map[string]func(*v3Snapshot){
		"foreign purpose":     func(v *v3Snapshot) { v.Audience = "clarin-offline-unlock" },
		"empty account":       func(v *v3Snapshot) { v.Tuple.AccountID = "" },
		"wrong digest":        func(v *v3Snapshot) { v.ContentHash = strings.Repeat("f", 64) },
		"zero revision":       func(v *v3Snapshot) { v.HeadVersion = 0 },
		"mismatched module":   func(v *v3Snapshot) { v.Module = "programs" },
		"tombstone with data": func(v *v3Snapshot) { v.Tombstone = true },
		"stale signing":       func(v *v3Snapshot) { v.IssuedAt -= 301 },
	} {
		t.Run(name, func(t *testing.T) {
			v := snapshot
			mutate(&v)
			raw, _ := json.Marshal(v)
			w := httptest.NewRecorder()
			s.signSnapshot(w, httptest.NewRequest("POST", "/", bytes.NewReader(raw)))
			if w.Code != 400 {
				t.Fatalf("accepted invalid %s", name)
			}
		})
	}
	for name, mutate := range map[string]func(*v3Receipt){
		"missing request hash": func(v *v3Receipt) { v.RequestHash = "" },
		"false status":         func(v *v3Receipt) { v.Status = "received" },
		"success with error":   func(v *v3Receipt) { v.ErrorCode = "denied" },
		"wrong purpose":        func(v *v3Receipt) { v.Kind = "snapshot" },
		"error PII":            func(v *v3Receipt) { v.Status = "rejected"; v.ErrorCode = "User foo@example.com denied" },
	} {
		t.Run(name, func(t *testing.T) {
			v := receipt
			mutate(&v)
			raw, _ := json.Marshal(v)
			w := httptest.NewRecorder()
			s.signReceipt(w, httptest.NewRequest("POST", "/", bytes.NewReader(raw)))
			if w.Code != 400 {
				t.Fatalf("accepted invalid %s", name)
			}
		})
	}
}

func TestV3SnapshotHashMatchesSerializedHTMLAndRejectsNestedDuplicates(t *testing.T) {
	s := newTestV3Signer(t)
	v := testV3Snapshot(s)
	v.Payload = json.RawMessage(`{"title":"<p>á & texto</p>"}`)
	normalized, _ := json.Marshal(v.Payload)
	hash := sha256.Sum256(normalized)
	v.ContentHash = hex.EncodeToString(hash[:])
	data := signedDataPayload(t, s, v, s.signSnapshot, "clarin-offline-snapshot+jws")
	var parsed v3Snapshot
	_ = json.Unmarshal(data, &parsed)
	actual := sha256.Sum256(parsed.Payload)
	if hex.EncodeToString(actual[:]) != parsed.ContentHash {
		t.Fatal("serialized payload digest changed")
	}
	raw, _ := json.Marshal(testV3Snapshot(s))
	body := strings.Replace(string(raw), `"title":"A"`, `"title":"A","title":"B"`, 1)
	w := httptest.NewRecorder()
	s.signSnapshot(w, httptest.NewRequest("POST", "/", strings.NewReader(body)))
	if w.Code != 400 {
		t.Fatal("nested duplicate field accepted")
	}
}
