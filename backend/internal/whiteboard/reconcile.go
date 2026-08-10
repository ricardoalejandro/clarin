// Package whiteboard contains protocol helpers shared by the Pizarras API and
// its realtime transport. The merge rule mirrors the deterministic element
// version semantics in Excalidraw v0.18.1 data/reconcile.ts (MIT, Copyright
// 2020 Excalidraw) while keeping the payload opaque so future editor fields
// survive a round trip. See THIRD_PARTY_NOTICES.md.
package whiteboard

import (
	"bytes"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"
)

var (
	ErrInvalidSceneElement = errors.New("invalid whiteboard scene element")
	ErrDuplicateElementID  = errors.New("duplicate whiteboard element id")
)

type decodedElement struct {
	raw          json.RawMessage
	id           string
	index        string
	version      int64
	versionNonce int64
	ordinal      int
}

type elementEnvelope struct {
	ID           string          `json:"id"`
	Index        json.RawMessage `json:"index"`
	Version      json.RawMessage `json:"version"`
	VersionNonce json.RawMessage `json:"versionNonce"`
}

const maxSafeJSONInteger = int64(1<<53 - 1)

// elementIndexMutation supplies the two deliberately volatile fields written
// by Excalidraw's mutateElement() when syncInvalidIndices() repairs an index.
// Keeping the source injectable lets the differential corpus compare every
// other byte of the algorithm without weakening production entropy.
type elementIndexMutation func(element decodedElement, index string) (versionNonce, updated int64, err error)

// ReconcileElements merges a canonical scene with a remote element patch.
// Elements are compared by id. A greater version wins; equal versions are
// resolved by the lower versionNonce, matching Excalidraw's deterministic
// conflict rule. Unrecognised element properties are never decoded/rebuilt.
func ReconcileElements(canonical, remote []json.RawMessage) ([]json.RawMessage, error) {
	return reconcileElements(canonical, remote, newElementIndexMutation)
}

// NormalizeElementsForStorage applies the same v0.18.1 ordering, conflict,
// fractional-index and version rules as ReconcileElements, while deriving the
// otherwise-random mutation metadata from the input. Import validation and
// immutable snapshot hashing need this repeatable representation; realtime
// reconciliation must continue to use ReconcileElements.
func NormalizeElementsForStorage(elements []json.RawMessage) ([]json.RawMessage, error) {
	return reconcileElements(nil, elements, deterministicElementIndexMutation)
}

func reconcileElements(canonical, remote []json.RawMessage, mutation elementIndexMutation) ([]json.RawMessage, error) {
	if mutation == nil {
		return nil, errors.New("whiteboard index mutation source is required")
	}
	local, err := decodeElements(canonical)
	if err != nil {
		return nil, fmt.Errorf("decode canonical scene: %w", err)
	}
	patch, err := decodeElements(remote)
	if err != nil {
		return nil, fmt.Errorf("decode remote patch: %w", err)
	}

	localByID := make(map[string]decodedElement, len(local))
	for _, element := range local {
		localByID[element.id] = element
	}

	// Upstream processes the remote batch first, followed by canonical elements
	// that were not represented in that batch. This order matters for legacy
	// elements without fractional indices, for which Array.sort deliberately
	// preserves insertion order.
	merged := make([]decodedElement, 0, len(local)+len(patch))
	added := make(map[string]struct{}, len(local)+len(patch))
	for _, candidate := range patch {
		current, exists := localByID[candidate.id]
		if exists && !remoteWins(current, candidate) {
			merged = append(merged, current)
		} else {
			merged = append(merged, candidate)
		}
		added[candidate.id] = struct{}{}
	}
	for _, element := range local {
		if _, exists := added[element.id]; !exists {
			merged = append(merged, element)
		}
	}
	for ordinal := range merged {
		merged[ordinal].ordinal = ordinal
	}
	sort.SliceStable(merged, func(i, j int) bool {
		left, right := merged[i], merged[j]
		// Matches orderByFractionalIndex(): compare only when both elements are
		// ordered. Missing legacy indices retain the remote-first merge order.
		if left.index == "" || right.index == "" {
			return false
		}
		if left.index != right.index {
			return left.index < right.index
		}
		// Upstream deterministically resolves duplicate fractional indices by ID.
		return left.id < right.id
	})
	if err := syncInvalidElementIndices(merged, mutation); err != nil {
		return nil, fmt.Errorf("synchronize fractional indices: %w", err)
	}

	result := make([]json.RawMessage, 0, len(merged))
	for _, element := range merged {
		result = append(result, append(json.RawMessage(nil), element.raw...))
	}
	return result, nil
}

func newElementIndexMutation(_ decodedElement, _ string) (int64, int64, error) {
	var value [4]byte
	if _, err := cryptorand.Read(value[:]); err != nil {
		return 0, 0, fmt.Errorf("generate Excalidraw version nonce: %w", err)
	}
	// Excalidraw 0.18.1 randomInteger() returns an integer in [0, 2^31).
	nonce := int64(binary.BigEndian.Uint32(value[:]) & 0x7fffffff)
	return nonce, time.Now().UnixMilli(), nil
}

func deterministicElementIndexMutation(element decodedElement, index string) (int64, int64, error) {
	digest := sha256.New()
	_, _ = digest.Write(element.raw)
	_, _ = digest.Write([]byte{0})
	_, _ = digest.Write([]byte(index))
	sum := digest.Sum(nil)
	nonce := int64(binary.BigEndian.Uint32(sum[:4]) & 0x7fffffff)
	// Upstream uses 1 for updated timestamps in its deterministic test mode.
	return nonce, 1, nil
}

func remoteWins(local, remote decodedElement) bool {
	if remote.version != local.version {
		return remote.version > local.version
	}
	return remote.versionNonce <= local.versionNonce
}

func decodeElements(elements []json.RawMessage) ([]decodedElement, error) {
	decoded := make([]decodedElement, 0, len(elements))
	seen := make(map[string]struct{}, len(elements))
	for ordinal, raw := range elements {
		if len(bytes.TrimSpace(raw)) == 0 || !json.Valid(raw) {
			return nil, fmt.Errorf("%w at position %d", ErrInvalidSceneElement, ordinal)
		}
		var envelope elementEnvelope
		if err := json.Unmarshal(raw, &envelope); err != nil || envelope.ID == "" {
			return nil, fmt.Errorf("%w at position %d", ErrInvalidSceneElement, ordinal)
		}
		if _, duplicate := seen[envelope.ID]; duplicate {
			return nil, fmt.Errorf("%w: %s", ErrDuplicateElementID, envelope.ID)
		}
		seen[envelope.ID] = struct{}{}

		version, err := decodeJSONInteger(envelope.Version, "version", envelope.ID)
		if err != nil {
			return nil, err
		}
		versionNonce, err := decodeJSONInteger(envelope.VersionNonce, "versionNonce", envelope.ID)
		if err != nil {
			return nil, err
		}
		index := ""
		if len(envelope.Index) > 0 && !bytes.Equal(envelope.Index, []byte("null")) {
			if err := json.Unmarshal(envelope.Index, &index); err != nil {
				return nil, fmt.Errorf("%w: element %s has invalid index", ErrInvalidSceneElement, envelope.ID)
			}
		}
		decoded = append(decoded, decodedElement{
			raw:          append(json.RawMessage(nil), raw...),
			id:           envelope.ID,
			index:        index,
			version:      version,
			versionNonce: versionNonce,
			ordinal:      ordinal,
		})
	}
	return decoded, nil
}

func decodeJSONInteger(raw json.RawMessage, field, id string) (int64, error) {
	if len(raw) == 0 {
		return 0, fmt.Errorf("%w: element %s has no %s", ErrInvalidSceneElement, id, field)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value json.Number
	if err := decoder.Decode(&value); err != nil {
		return 0, fmt.Errorf("%w: element %s has invalid %s", ErrInvalidSceneElement, id, field)
	}
	parsed, err := value.Int64()
	if err != nil || parsed < 0 || parsed > maxSafeJSONInteger {
		return 0, fmt.Errorf("%w: element %s has invalid %s", ErrInvalidSceneElement, id, field)
	}
	return parsed, nil
}
