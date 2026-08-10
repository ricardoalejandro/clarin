package whiteboard

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/google/uuid"
)

const (
	EventScenePatch       = "scene.patch"
	EventSyncRequest      = "sync.request"
	EventSyncRequired     = "sync.required"
	EventCursorUpdate     = "cursor.update"
	EventPresenceUpdate   = "presence.update"
	EventSceneSnapshot    = "scene.snapshot"
	EventAck              = "ack"
	EventPresenceSnapshot = "presence.snapshot"
	EventAccessRevoked    = "access.revoked"
	EventError            = "error"

	MaxRealtimeMessageBytes = 1 << 20
	// Leave room for the Redis fanout envelope, account/board UUIDs and event
	// metadata. Canonical scenes remain valid up to 16 MiB over REST, but must
	// never be copied into realtime queues or Redis above this threshold.
	MaxRealtimeSnapshotMessageBytes = 900_000
	MaxElementsPerPatch             = 2000
	MaxCursorPayloadBytes           = 4 << 10
	MaxPresencePayloadBytes         = 4 << 10
	MaxAppStatePatchBytes           = 64 << 10
)

var ErrInvalidRealtimeMessage = errors.New("invalid whiteboard realtime message")

type IncomingMessage struct {
	Event        string            `json:"event"`
	OperationID  *uuid.UUID        `json:"operation_id,omitempty"`
	BaseSequence int64             `json:"base_sequence,omitempty"`
	Elements     []json.RawMessage `json:"elements,omitempty"`
	AppState     json.RawMessage   `json:"app_state,omitempty"`
	Data         json.RawMessage   `json:"data,omitempty"`
}

type OutgoingMessage struct {
	Event       string      `json:"event"`
	OperationID *uuid.UUID  `json:"operation_id,omitempty"`
	Sequence    int64       `json:"sequence"`
	Actor       interface{} `json:"actor,omitempty"`
	Data        interface{} `json:"data,omitempty"`
	Code        string      `json:"code,omitempty"`
	Error       string      `json:"error,omitempty"`
}

// DecodeIncoming validates the stable wire envelope before a handler performs
// access checks or persistence. Presence payloads remain opaque and ephemeral;
// scene elements receive stricter structural validation during reconciliation.
func DecodeIncoming(payload []byte) (IncomingMessage, error) {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return IncomingMessage{}, fmt.Errorf("%w: message size", ErrInvalidRealtimeMessage)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var message IncomingMessage
	if err := decoder.Decode(&message); err != nil {
		return IncomingMessage{}, fmt.Errorf("%w: %v", ErrInvalidRealtimeMessage, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return IncomingMessage{}, fmt.Errorf("%w: trailing data", ErrInvalidRealtimeMessage)
	}
	switch message.Event {
	case EventScenePatch:
		if message.OperationID == nil || message.BaseSequence < 0 || len(message.Elements) > MaxElementsPerPatch || len(message.AppState) > MaxAppStatePatchBytes {
			return IncomingMessage{}, fmt.Errorf("%w: invalid scene patch", ErrInvalidRealtimeMessage)
		}
		cleanState, err := SanitizePersistedAppState(message.AppState)
		if err != nil {
			return IncomingMessage{}, err
		}
		var persistedState map[string]json.RawMessage
		if err := json.Unmarshal(cleanState, &persistedState); err != nil {
			return IncomingMessage{}, fmt.Errorf("%w: invalid scene patch", ErrInvalidRealtimeMessage)
		}
		if len(message.Elements) == 0 && len(persistedState) == 0 {
			return IncomingMessage{}, fmt.Errorf("%w: empty scene patch", ErrInvalidRealtimeMessage)
		}
	case EventSyncRequest:
		if message.BaseSequence < 0 {
			return IncomingMessage{}, fmt.Errorf("%w: invalid sync sequence", ErrInvalidRealtimeMessage)
		}
	case EventCursorUpdate:
		if len(message.Data) == 0 || len(message.Data) > MaxCursorPayloadBytes || !json.Valid(message.Data) {
			return IncomingMessage{}, fmt.Errorf("%w: invalid cursor payload", ErrInvalidRealtimeMessage)
		}
	case EventPresenceUpdate:
		if len(message.Data) == 0 || len(message.Data) > MaxPresencePayloadBytes || !json.Valid(message.Data) {
			return IncomingMessage{}, fmt.Errorf("%w: invalid presence payload", ErrInvalidRealtimeMessage)
		}
	default:
		return IncomingMessage{}, fmt.Errorf("%w: unsupported event", ErrInvalidRealtimeMessage)
	}
	return message, nil
}

var persistedAppStateFields = map[string]struct{}{
	// Exact Excalidraw 0.18.1 APP_STATE_STORAGE_CONF fields whose `server`
	// flag is true. Theme, viewport, selections, snap preferences and frame
	// rendering are per-user/transient state and must not become canonical.
	"viewBackgroundColor": {},
	"gridSize":            {},
	"gridStep":            {},
	"gridModeEnabled":     {},
}

// SanitizePersistedAppState prevents per-user viewport, selections,
// collaborators, dialogs, errors, and other transient editor state from being
// stored in the account-scoped document.
func SanitizePersistedAppState(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return json.RawMessage(`{}`), nil
	}
	var input map[string]json.RawMessage
	if err := json.Unmarshal(raw, &input); err != nil {
		return nil, fmt.Errorf("%w: invalid app state", ErrInvalidRealtimeMessage)
	}
	output := make(map[string]any)
	for key, value := range input {
		if _, allowed := persistedAppStateFields[key]; !allowed {
			continue
		}
		sanitized, err := sanitizePersistedAppStateValue(key, value)
		if err != nil {
			return nil, err
		}
		output[key] = sanitized
	}
	encoded, err := json.Marshal(output)
	if err != nil {
		return nil, fmt.Errorf("encode app state: %w", err)
	}
	return encoded, nil
}

func sanitizePersistedAppStateValue(key string, raw json.RawMessage) (any, error) {
	invalid := func() (any, error) {
		return nil, fmt.Errorf("%w: invalid app state field %s", ErrInvalidRealtimeMessage, key)
	}
	switch key {
	case "viewBackgroundColor":
		var color string
		if err := json.Unmarshal(raw, &color); err != nil {
			return invalid()
		}
		// Excalidraw's color picker accepts CSS colors. Keep that compatibility
		// without allowing an unbounded string into canvas/style rendering.
		color = strings.TrimSpace(color)
		if color == "" || len(color) > 64 {
			return invalid()
		}
		return color, nil
	case "gridSize", "gridStep":
		// Older valid .excalidraw files may contain null. Excalidraw 0.18.1
		// restores that to its defaults before rendering.
		if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			if key == "gridSize" {
				return 20, nil
			}
			return 5, nil
		}
		var value float64
		if err := json.Unmarshal(raw, &value); err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return invalid()
		}
		// Mirrors getNormalizedGridSize/getNormalizedGridStep in 0.18.1.
		value = math.Round(value)
		if value < 1 {
			value = 1
		} else if value > 100 {
			value = 100
		}
		return int(value), nil
	case "gridModeEnabled":
		var enabled bool
		if err := json.Unmarshal(raw, &enabled); err != nil {
			return invalid()
		}
		return enabled, nil
	default:
		return invalid()
	}
}
