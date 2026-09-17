package repository

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestCanonicalOfflineSnapshotPayloadMatchesEmbeddedWireBytes(t *testing.T) {
	raw := json.RawMessage("{\n  \"html\": \"<Clarin>&\", \"nested\": [1, 2]\n}")
	canonical, err := canonicalOfflineSnapshotPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	type response struct {
		Payload json.RawMessage `json:"payload"`
	}
	wire, err := json.Marshal(response{Payload: canonical})
	if err != nil {
		t.Fatal(err)
	}
	var received response
	if err := json.Unmarshal(wire, &received); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(received.Payload, canonical) {
		t.Fatalf("wire payload changed after hashing:\nwant %s\n got %s", canonical, received.Payload)
	}
	digest := sha256.Sum256(received.Payload)
	if hex.EncodeToString(digest[:]) != "3a57c125be1d979b56fa8d080c77c3a5fd23882cebd4d54a39c5bb6c40f88340" {
		t.Fatalf("canonical wire hash changed: %x", digest)
	}
}

func TestCanonicalOfflineSnapshotPayloadRejectsInvalidJSON(t *testing.T) {
	if _, err := canonicalOfflineSnapshotPayload(json.RawMessage(`{"broken":`)); err == nil {
		t.Fatal("invalid snapshot JSON was accepted")
	}
}
