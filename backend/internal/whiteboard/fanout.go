package whiteboard

import (
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
)

const RedisFanoutChannel = "clarin:whiteboards:realtime:v1"

// FanoutEnvelope is an ephemeral Redis transport envelope. PostgreSQL remains
// canonical; scene messages may only be published after the durable commit.
type FanoutEnvelope struct {
	InstanceID    uuid.UUID       `json:"instance_id"`
	AccountID     uuid.UUID       `json:"account_id"`
	BoardID       uuid.UUID       `json:"board_id"`
	TargetUserID  *uuid.UUID      `json:"target_user_id,omitempty"`
	TargetGuestID *uuid.UUID      `json:"target_guest_id,omitempty"`
	MembersOnly   bool            `json:"members_only,omitempty"`
	Message       OutgoingMessage `json:"message"`
}

func (e FanoutEnvelope) Encode() ([]byte, error) {
	if err := e.Validate(); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(e)
	if err != nil {
		return nil, fmt.Errorf("encode whiteboard fanout: %w", err)
	}
	if len(encoded) > MaxRealtimeMessageBytes {
		return nil, fmt.Errorf("%w: fanout size", ErrInvalidRealtimeMessage)
	}
	return encoded, nil
}

func DecodeFanout(payload []byte) (FanoutEnvelope, error) {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return FanoutEnvelope{}, fmt.Errorf("%w: fanout size", ErrInvalidRealtimeMessage)
	}
	var envelope FanoutEnvelope
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return FanoutEnvelope{}, fmt.Errorf("%w: fanout json", ErrInvalidRealtimeMessage)
	}
	if err := envelope.Validate(); err != nil {
		return FanoutEnvelope{}, err
	}
	return envelope, nil
}

func (e FanoutEnvelope) Validate() error {
	if e.InstanceID == uuid.Nil || e.AccountID == uuid.Nil || e.BoardID == uuid.Nil {
		return fmt.Errorf("%w: fanout scope", ErrInvalidRealtimeMessage)
	}
	if e.TargetUserID != nil && e.TargetGuestID != nil {
		return fmt.Errorf("%w: multiple fanout targets", ErrInvalidRealtimeMessage)
	}
	if (e.TargetUserID != nil || e.TargetGuestID != nil) && e.Message.Event != EventAccessRevoked {
		return fmt.Errorf("%w: targeted fanout event", ErrInvalidRealtimeMessage)
	}
	if e.MembersOnly && (e.Message.Event != EventCommentChanged || e.TargetUserID != nil || e.TargetGuestID != nil) {
		return fmt.Errorf("%w: members-only fanout event", ErrInvalidRealtimeMessage)
	}
	switch e.Message.Event {
	case EventScenePatch, EventSceneSnapshot, EventSyncRequired, EventPresenceSnapshot, EventCursorUpdate,
		EventPresenceUpdate, EventPresentationSnapshot, EventPresentationChanged, EventFollowChange, EventViewportUpdate,
		EventAccessRevoked, EventCommentChanged:
	default:
		return fmt.Errorf("%w: fanout event", ErrInvalidRealtimeMessage)
	}
	if e.Message.Event == EventCommentChanged && !e.MembersOnly {
		return fmt.Errorf("%w: comment fanout audience", ErrInvalidRealtimeMessage)
	}
	return nil
}
