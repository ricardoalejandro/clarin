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
	EventScenePatch           = "scene.patch"
	EventSyncRequest          = "sync.request"
	EventSyncRequired         = "sync.required"
	EventCursorUpdate         = "cursor.update"
	EventPresenceUpdate       = "presence.update"
	EventSceneSnapshot        = "scene.snapshot"
	EventAck                  = "ack"
	EventPresenceSnapshot     = "presence.snapshot"
	EventRoomReady            = "room.ready"
	EventPresentationStart    = "presentation.start"
	EventPresentationStop     = "presentation.stop"
	EventPresentationSnapshot = "presentation.snapshot"
	EventPresentationChanged  = "presentation.changed"
	EventFollowChange         = "follow.change"
	EventViewportUpdate       = "viewport.update"
	EventAccessRevoked        = "access.revoked"
	EventCommentChanged       = "comment.changed"
	EventError                = "error"

	MaxRealtimeMessageBytes = 1 << 20
	// Leave room for the Redis fanout envelope, account/board UUIDs and event
	// metadata. Canonical scenes remain valid up to 16 MiB over REST, but must
	// never be copied into realtime queues or Redis above this threshold.
	MaxRealtimeSnapshotMessageBytes = 900_000
	MaxElementsPerPatch             = 2000
	MaxCursorPayloadBytes           = 4 << 10
	MaxPresencePayloadBytes         = 4 << 10
	MaxPresentationPayloadBytes     = 4 << 10
	MaxFollowPayloadBytes           = 4 << 10
	MaxViewportPayloadBytes         = 4 << 10
	MaxViewportCoordinate           = 1_000_000
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

type PresentationStopData struct {
	PresentationID uuid.UUID `json:"presentation_id"`
}

type FollowChangeData struct {
	TargetActorID uuid.UUID `json:"target_actor_id"`
	Action        string    `json:"action"`
}

type ViewportUpdateData struct {
	Bounds [4]float64 `json:"bounds"`
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
	case EventPresentationStart:
		if message.OperationID == nil || len(message.Data) > MaxPresentationPayloadBytes || (len(message.Data) > 0 && !isEmptyJSONObject(message.Data)) {
			return IncomingMessage{}, fmt.Errorf("%w: invalid presentation start", ErrInvalidRealtimeMessage)
		}
	case EventPresentationStop:
		var data PresentationStopData
		if message.OperationID == nil || len(message.Data) == 0 || len(message.Data) > MaxPresentationPayloadBytes || decodeStrictData(message.Data, &data) != nil || data.PresentationID == uuid.Nil {
			return IncomingMessage{}, fmt.Errorf("%w: invalid presentation stop", ErrInvalidRealtimeMessage)
		}
	case EventFollowChange:
		var data FollowChangeData
		if len(message.Data) == 0 || len(message.Data) > MaxFollowPayloadBytes || decodeStrictData(message.Data, &data) != nil || data.TargetActorID == uuid.Nil || (data.Action != "FOLLOW" && data.Action != "UNFOLLOW") {
			return IncomingMessage{}, fmt.Errorf("%w: invalid follow change", ErrInvalidRealtimeMessage)
		}
	case EventViewportUpdate:
		var data ViewportUpdateData
		if len(message.Data) == 0 || len(message.Data) > MaxViewportPayloadBytes || decodeStrictData(message.Data, &data) != nil || !validViewportBounds(data.Bounds) {
			return IncomingMessage{}, fmt.Errorf("%w: invalid viewport update", ErrInvalidRealtimeMessage)
		}
	default:
		return IncomingMessage{}, fmt.Errorf("%w: unsupported event", ErrInvalidRealtimeMessage)
	}
	return message, nil
}

func decodeStrictData(raw json.RawMessage, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return ErrInvalidRealtimeMessage
	}
	return nil
}

func isEmptyJSONObject(raw json.RawMessage) bool {
	var value map[string]json.RawMessage
	return decodeStrictData(raw, &value) == nil && len(value) == 0
}

func validViewportBounds(bounds [4]float64) bool {
	for _, value := range bounds {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < -MaxViewportCoordinate || value > MaxViewportCoordinate {
			return false
		}
	}
	return bounds[2] > bounds[0] && bounds[3] > bounds[1]
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
