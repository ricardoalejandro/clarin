package localstate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const (
	BootstrapUnregistered = "unregistered"
	BootstrapPending      = "pending"
	BootstrapEnrolled     = "enrolled"
	BootstrapBlocked      = "blocked"
)

func ResolveBootstrapState(profileCount int, profileValid, pendingEnrollment bool, leaseKeyVersion, accountCount int) string {
	if profileCount == 0 {
		return BootstrapUnregistered
	}
	if profileCount != 1 || !profileValid {
		return BootstrapBlocked
	}
	if pendingEnrollment || leaseKeyVersion < 1 || accountCount < 1 {
		return BootstrapPending
	}
	return BootstrapEnrolled
}

// PruneSnapshots removes cached payloads that are no longer represented by
// the authoritative inventory. This is the local enforcement point for a
// user's online resource de-selection.
func PruneSnapshots(snapshots map[string]json.RawMessage, selectionIDs []string) {
	allowed := make(map[string]struct{}, len(selectionIDs))
	for _, selectionID := range selectionIDs {
		allowed[selectionID] = struct{}{}
	}
	for selectionID := range snapshots {
		if _, ok := allowed[selectionID]; !ok {
			delete(snapshots, selectionID)
		}
	}
}

func EstimatedBytes(value any) int64 {
	raw, err := json.Marshal(value)
	if err != nil {
		return 0
	}
	return int64(len(raw))
}

func SnapshotHashMatches(payload json.RawMessage, expected string) bool {
	decoded, err := hex.DecodeString(strings.TrimSpace(expected))
	if err != nil || len(decoded) != sha256.Size {
		return false
	}
	digest := sha256.Sum256(payload)
	return string(decoded) == string(digest[:])
}

func BoundedPrefix[T any](values []T, limit int) []T {
	if limit < 0 {
		limit = 0
	}
	if len(values) <= limit {
		return values
	}
	return values[:limit]
}

type OperationReceipt struct {
	OperationID string
	Status      string
}

// ReconcileOutbox removes every operation for which the server has emitted a
// durable terminal receipt. Conflicts are terminal too: the conflict record,
// not another replay of the original write, is what the user resolves online.
func ReconcileOutbox[T any](outbox []T, receipts []OperationReceipt, operationID func(T) string) []T {
	terminal := make(map[string]struct{}, len(receipts))
	for _, receipt := range receipts {
		switch receipt.Status {
		case "applied", "noop", "rejected", "dependency_failed", "conflict":
			terminal[receipt.OperationID] = struct{}{}
		}
	}
	next := outbox[:0]
	for _, pending := range outbox {
		if _, completed := terminal[operationID(pending)]; !completed {
			next = append(next, pending)
		}
	}
	return next
}

// MergeBoundedByID keeps one canonical local receipt per operation and drops
// the oldest history once the explicit local bound is reached.
func MergeBoundedByID[T any](current, incoming []T, limit int, id func(T) string) []T {
	if limit <= 0 {
		return nil
	}
	merged := make([]T, 0, len(current)+len(incoming))
	positions := make(map[string]int, len(current)+len(incoming))
	for _, item := range current {
		key := id(item)
		if index, exists := positions[key]; exists {
			merged[index] = item
			continue
		}
		positions[key] = len(merged)
		merged = append(merged, item)
	}
	for _, item := range incoming {
		key := id(item)
		if index, exists := positions[key]; exists {
			merged[index] = item
			continue
		}
		positions[key] = len(merged)
		merged = append(merged, item)
	}
	if len(merged) <= limit {
		return merged
	}
	return append([]T(nil), merged[len(merged)-limit:]...)
}

func ValidUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, char := range strings.ToLower(value) {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if char != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdef", char) {
			return false
		}
	}
	return true
}
