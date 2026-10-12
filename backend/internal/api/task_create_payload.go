package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
)

func taskCreatePayloadHash(raw []byte) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return "", err
	}
	delete(fields, "operation_id")
	delete(fields, "confirm_grants")
	// Decode nested values as well so JSON whitespace/key order is immaterial.
	var normalized map[string]any
	encoded, err := json.Marshal(fields)
	if err != nil {
		return "", err
	}
	if err = json.Unmarshal(encoded, &normalized); err != nil {
		return "", err
	}
	encoded, err = json.Marshal(normalized)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
