package api

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/google/uuid"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

func (s *Server) broadcastWhiteboardMessage(accountID, boardID uuid.UUID, message whiteboardcore.OutgoingMessage, exceptClient uuid.UUID) {
	if message.Event == whiteboardcore.EventCommentChanged {
		s.broadcastWhiteboardMemberMessage(accountID, boardID, message, exceptClient)
		return
	}
	if s.whiteboardRooms == nil {
		return
	}
	message = whiteboardRealtimeBroadcastMessage(message)
	slowClients := s.whiteboardRooms.Broadcast(accountID, boardID, message, exceptClient)
	if len(slowClients) > 0 {
		s.whiteboardRooms.Disconnect(accountID, boardID, slowClients, nil)
	}
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID,
		AccountID:  accountID,
		BoardID:    boardID,
		Message:    message,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] fanout encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		// PostgreSQL is canonical. A Redis outage may reduce cross-instance live
		// fan-out, but never rolls back an already committed scene operation.
		log.Printf("[WHITEBOARD WS] fanout publish failed: %v", err)
	}
}

func (s *Server) broadcastWhiteboardMemberMessage(accountID, boardID uuid.UUID, message whiteboardcore.OutgoingMessage, exceptClient uuid.UUID) {
	if s.whiteboardRooms == nil || message.Event != whiteboardcore.EventCommentChanged {
		return
	}
	message = whiteboardRealtimeBroadcastMessage(message)
	slowClients := s.whiteboardRooms.BroadcastMembers(accountID, boardID, message, exceptClient)
	if len(slowClients) > 0 {
		s.whiteboardRooms.Disconnect(accountID, boardID, slowClients, nil)
	}
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, BoardID: boardID,
		MembersOnly: true, Message: message,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] member fanout encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD WS] member fanout publish failed: %v", err)
	}
}

// whiteboardRealtimeBroadcastMessage ensures that durable writes whose scene
// or patch is larger than the realtime transport budget still notify every
// instance. Receivers fetch the canonical account-scoped scene over REST; the
// oversized JSON is never copied into room queues or Redis Pub/Sub.
func whiteboardRealtimeBroadcastMessage(message whiteboardcore.OutgoingMessage) whiteboardcore.OutgoingMessage {
	payload, err := json.Marshal(message)
	if err == nil && len(payload) <= whiteboardcore.MaxRealtimeSnapshotMessageBytes {
		return message
	}
	if message.Event == whiteboardcore.EventSceneSnapshot || message.Event == whiteboardcore.EventScenePatch {
		return whiteboardSceneSyncRequiredMessage(message.Sequence, "realtime_payload_too_large")
	}
	if message.Event == whiteboardcore.EventCommentChanged {
		return whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventCommentChanged,
			Data: map[string]any{"action": "refresh", "reason": "realtime_payload_too_large"}}
	}
	return whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventError,
		Code:  "realtime_payload_too_large",
		Error: "El evento supera el límite de colaboración",
	}
}

func (s *Server) startWhiteboardFanout() {
	if s.cache == nil || s.whiteboardRooms == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.whiteboardFanoutCancel = cancel
	go func() {
		backoff := time.Second
		for ctx.Err() == nil {
			subscription, err := s.cache.Subscribe(ctx, whiteboardcore.RedisFanoutChannel)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("[WHITEBOARD WS] fanout subscription failed; retrying: %v", err)
				}
			} else {
				backoff = time.Second
				channel := subscription.Channel()
				active := true
				for active {
					select {
					case <-ctx.Done():
						active = false
					case message, ok := <-channel:
						if !ok {
							active = false
							continue
						}
						envelope, decodeErr := whiteboardcore.DecodeFanout([]byte(message.Payload))
						if decodeErr != nil {
							log.Printf("[WHITEBOARD WS] ignored invalid fanout envelope: %v", decodeErr)
							continue
						}
						if envelope.InstanceID == s.whiteboardInstanceID {
							continue
						}
						if envelope.Message.Event == whiteboardcore.EventAccessRevoked {
							var clientIDs []uuid.UUID
							if envelope.TargetGuestID != nil {
								clientIDs = s.whiteboardRooms.RevokeGuestSession(envelope.AccountID, envelope.BoardID, *envelope.TargetGuestID)
							} else if envelope.TargetUserID != nil {
								clientIDs = s.whiteboardRooms.RevokeUserAccess(envelope.AccountID, envelope.BoardID, *envelope.TargetUserID)
							} else {
								clientIDs = s.whiteboardRooms.ClientIDs(envelope.AccountID, envelope.BoardID)
							}
							if len(clientIDs) > 0 {
								s.whiteboardRooms.Disconnect(envelope.AccountID, envelope.BoardID, clientIDs, &envelope.Message)
							}
							continue
						}
						var slowClients []uuid.UUID
						if envelope.MembersOnly {
							slowClients = s.whiteboardRooms.BroadcastMembers(envelope.AccountID, envelope.BoardID, envelope.Message, uuid.Nil)
						} else {
							slowClients = s.whiteboardRooms.Broadcast(envelope.AccountID, envelope.BoardID, envelope.Message, uuid.Nil)
						}
						if len(slowClients) > 0 {
							s.whiteboardRooms.Disconnect(envelope.AccountID, envelope.BoardID, slowClients, nil)
						}
					}
				}
				_ = subscription.Close()
			}
			if ctx.Err() != nil {
				return
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			if backoff < 30*time.Second {
				backoff *= 2
				if backoff > 30*time.Second {
					backoff = 30 * time.Second
				}
			}
		}
	}()
}

func (s *Server) revokeWhiteboardGuestSockets(accountID, boardID, guestID uuid.UUID) {
	message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "La sesión compartida fue revocada"}
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.RevokeGuestSession(accountID, boardID, guestID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, nil, &guestID, message)
}

func (s *Server) revokeWhiteboardUserSockets(accountID, boardID, userID uuid.UUID) {
	message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "access_revoked", Error: "El acceso a la pizarra fue revocado"}
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.RevokeUserAccess(accountID, boardID, userID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, &userID, nil, message)
}

func (s *Server) revokeWhiteboardBoardSockets(accountID, boardID uuid.UUID) {
	message := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventAccessRevoked, Code: "board_deleted", Error: "La pizarra fue eliminada permanentemente"}
	if s.whiteboardRooms != nil {
		clientIDs := s.whiteboardRooms.ClientIDs(accountID, boardID)
		s.whiteboardRooms.Disconnect(accountID, boardID, clientIDs, &message)
	}
	s.publishWhiteboardRevocation(accountID, boardID, nil, nil, message)
}

func (s *Server) publishWhiteboardRevocation(accountID, boardID uuid.UUID, userID, guestID *uuid.UUID, message whiteboardcore.OutgoingMessage) {
	if s.cache == nil || s.whiteboardInstanceID == uuid.Nil {
		return
	}
	payload, err := (whiteboardcore.FanoutEnvelope{
		InstanceID: s.whiteboardInstanceID, AccountID: accountID, BoardID: boardID,
		TargetUserID: userID, TargetGuestID: guestID, Message: message,
	}).Encode()
	if err != nil {
		log.Printf("[WHITEBOARD WS] revocation encode failed: %v", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := s.cache.Publish(ctx, whiteboardcore.RedisFanoutChannel, payload); err != nil {
		log.Printf("[WHITEBOARD WS] revocation publish failed: %v", err)
	}
}
