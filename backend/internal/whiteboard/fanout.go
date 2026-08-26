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
	InstanceID    uuid.UUID  `json:"instance_id"`
	AccountID     uuid.UUID  `json:"account_id"`
	BoardID       uuid.UUID  `json:"board_id"`
	TargetUserID  *uuid.UUID `json:"target_user_id,omitempty"`
	TargetGuestID *uuid.UUID `json:"target_guest_id,omitempty"`
	MembersOnly   bool       `json:"members_only,omitempty"`
	AccessChanged bool       `json:"access_changed,omitempty"`
	// SourceAccessRevision is set only for sender-originated ephemeral traffic.
	// A receiving instance drops the message when the board has advanced to a
	// different ACL epoch, preventing delayed Redis delivery after revocation.
	SourceAccessRevision int64 `json:"source_access_revision,omitempty"`
	// AccountAccessChanged is an account-scoped, payload-free control. BoardID
	// must be empty; each receiving process revalidates only rooms it currently
	// serves for AccountID against canonical PostgreSQL/subscription state.
	AccountAccessChanged bool `json:"account_access_changed,omitempty"`
	// UserAuthorityChanged is a distinct, payload-free control for the general
	// account WebSocket. It intentionally contains no user IDs: remote
	// instances conservatively disconnect their AccountID sockets and require
	// fresh, canonically hydrated claims on reconnect.
	UserAuthorityChanged bool `json:"user_authority_changed,omitempty"`
	// WhiteboardHubChanged and WorkHubRevoked are account-scoped, payload-free
	// controls for the general Hub index. BoardID must remain empty: every
	// frontend refetches its own actor-authorized canonical cards and counts.
	WhiteboardHubChanged bool            `json:"whiteboard_hub_changed,omitempty"`
	WorkHubRevoked       bool            `json:"work_hub_revoked,omitempty"`
	Message              OutgoingMessage `json:"message"`
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
	if e.InstanceID == uuid.Nil || e.AccountID == uuid.Nil {
		return fmt.Errorf("%w: fanout scope", ErrInvalidRealtimeMessage)
	}
	if e.AccountAccessChanged {
		if e.BoardID != uuid.Nil || e.AccessChanged || e.UserAuthorityChanged || e.WhiteboardHubChanged || e.WorkHubRevoked || e.TargetUserID != nil || e.TargetGuestID != nil || e.MembersOnly ||
			e.SourceAccessRevision != 0 ||
			e.Message.Event != "" || e.Message.OperationID != nil || e.Message.Sequence != 0 ||
			e.Message.Actor != nil || e.Message.Data != nil || e.Message.Code != "" || e.Message.Error != "" {
			return fmt.Errorf("%w: account access-change fanout", ErrInvalidRealtimeMessage)
		}
		return nil
	}
	if e.UserAuthorityChanged {
		if e.BoardID != uuid.Nil || e.AccessChanged || e.AccountAccessChanged || e.WhiteboardHubChanged || e.WorkHubRevoked || e.TargetUserID != nil || e.TargetGuestID != nil || e.MembersOnly ||
			e.SourceAccessRevision != 0 ||
			e.Message.Event != "" || e.Message.OperationID != nil || e.Message.Sequence != 0 ||
			e.Message.Actor != nil || e.Message.Data != nil || e.Message.Code != "" || e.Message.Error != "" {
			return fmt.Errorf("%w: user authority-change fanout", ErrInvalidRealtimeMessage)
		}
		return nil
	}
	if e.WhiteboardHubChanged || e.WorkHubRevoked {
		if e.WhiteboardHubChanged == e.WorkHubRevoked || e.BoardID != uuid.Nil || e.AccessChanged || e.AccountAccessChanged || e.UserAuthorityChanged ||
			e.TargetUserID != nil || e.TargetGuestID != nil || e.MembersOnly || e.SourceAccessRevision != 0 ||
			e.Message.Event != "" || e.Message.OperationID != nil || e.Message.Sequence != 0 ||
			e.Message.Actor != nil || e.Message.Data != nil || e.Message.Code != "" || e.Message.Error != "" {
			return fmt.Errorf("%w: Hub control fanout", ErrInvalidRealtimeMessage)
		}
		return nil
	}
	if e.BoardID == uuid.Nil {
		return fmt.Errorf("%w: fanout scope", ErrInvalidRealtimeMessage)
	}
	if e.TargetUserID != nil && e.TargetGuestID != nil {
		return fmt.Errorf("%w: multiple fanout targets", ErrInvalidRealtimeMessage)
	}
	if e.AccessChanged {
		if e.WhiteboardHubChanged || e.WorkHubRevoked || e.TargetUserID != nil || e.TargetGuestID != nil || e.MembersOnly ||
			e.SourceAccessRevision != 0 ||
			e.Message.Event != "" || e.Message.OperationID != nil || e.Message.Sequence != 0 ||
			e.Message.Actor != nil || e.Message.Data != nil || e.Message.Code != "" || e.Message.Error != "" {
			return fmt.Errorf("%w: access-change fanout", ErrInvalidRealtimeMessage)
		}
		return nil
	}
	if (e.TargetUserID != nil || e.TargetGuestID != nil) && e.Message.Event != EventAccessRevoked {
		return fmt.Errorf("%w: targeted fanout event", ErrInvalidRealtimeMessage)
	}
	if e.MembersOnly && (e.Message.Event != EventCommentChanged || e.TargetUserID != nil || e.TargetGuestID != nil) {
		return fmt.Errorf("%w: members-only fanout event", ErrInvalidRealtimeMessage)
	}
	if e.SourceAccessRevision < 0 {
		return fmt.Errorf("%w: source access revision", ErrInvalidRealtimeMessage)
	}
	if e.SourceAccessRevision > 0 {
		switch e.Message.Event {
		case EventCursorUpdate, EventPresenceUpdate, EventPresentationChanged, EventFollowChange, EventViewportUpdate:
		default:
			return fmt.Errorf("%w: source access revision event", ErrInvalidRealtimeMessage)
		}
		if e.MembersOnly || e.TargetUserID != nil || e.TargetGuestID != nil {
			return fmt.Errorf("%w: source access revision audience", ErrInvalidRealtimeMessage)
		}
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
