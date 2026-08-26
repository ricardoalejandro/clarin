package api

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
)

const whiteboardPresenceTTL = 75 * time.Second

const whiteboardPresenceSnapshotLease = 20 * time.Second

var errWhiteboardPresenceUnavailable = errors.New("whiteboard distributed presence unavailable")

func whiteboardPresenceIndexKey(accountID, boardID uuid.UUID) string {
	return "whiteboard:presence:" + accountID.String() + ":" + boardID.String()
}

func whiteboardPresenceValuePrefix(accountID, boardID uuid.UUID) string {
	return whiteboardPresenceIndexKey(accountID, boardID) + ":client:"
}

func whiteboardPresenceValueKey(accountID, boardID, clientID uuid.UUID) string {
	return whiteboardPresenceValuePrefix(accountID, boardID) + clientID.String()
}

func whiteboardPresenceSnapshotLeaseKey(accountID, boardID uuid.UUID) string {
	return whiteboardPresenceIndexKey(accountID, boardID) + ":snapshot-lease"
}

func (s *Server) registerWhiteboardPresence(ctx context.Context, client *whiteboardcore.RealtimeClient) error {
	if client == nil {
		return errWhiteboardPresenceUnavailable
	}
	if s.cache == nil {
		return nil
	}
	payload, err := json.Marshal(client.ActorSnapshot())
	if err != nil {
		return err
	}
	registered, err := s.cache.RegisterExpiringMember(ctx,
		whiteboardPresenceIndexKey(client.AccountID, client.BoardID),
		whiteboardPresenceValueKey(client.AccountID, client.BoardID, client.ID),
		client.ID.String(), payload, whiteboardcore.MaxConnectionsPerBoard, whiteboardPresenceTTL)
	if err != nil {
		return errWhiteboardPresenceUnavailable
	}
	if !registered {
		return whiteboardcore.ErrRoomCapacity
	}
	return nil
}

func (s *Server) refreshWhiteboardPresence(ctx context.Context, client *whiteboardcore.RealtimeClient) error {
	if s.cache == nil || client == nil {
		return nil
	}
	refreshed, err := s.cache.RefreshExpiringMember(ctx,
		whiteboardPresenceIndexKey(client.AccountID, client.BoardID),
		whiteboardPresenceValueKey(client.AccountID, client.BoardID, client.ID),
		client.ID.String(), whiteboardPresenceTTL)
	if err != nil || !refreshed {
		return errWhiteboardPresenceUnavailable
	}
	return nil
}

func (s *Server) unregisterWhiteboardPresence(client *whiteboardcore.RealtimeClient) {
	if s.cache == nil || client == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_ = s.cache.RemoveExpiringMember(ctx,
		whiteboardPresenceIndexKey(client.AccountID, client.BoardID),
		whiteboardPresenceValueKey(client.AccountID, client.BoardID, client.ID), client.ID.String())
}

func (s *Server) whiteboardPresence(ctx context.Context, accountID, boardID uuid.UUID) ([]whiteboardcore.RealtimeActor, error) {
	if s.cache == nil {
		if s.whiteboardRooms == nil {
			return []whiteboardcore.RealtimeActor{}, nil
		}
		return s.whiteboardRooms.Presence(accountID, boardID), nil
	}
	payloads, err := s.cache.ListExpiringMembers(ctx,
		whiteboardPresenceIndexKey(accountID, boardID), whiteboardPresenceValuePrefix(accountID, boardID))
	if err != nil {
		return nil, errWhiteboardPresenceUnavailable
	}
	actors := make([]whiteboardcore.RealtimeActor, 0, len(payloads))
	for _, payload := range payloads {
		var actor whiteboardcore.RealtimeActor
		if err := json.Unmarshal(payload, &actor); err != nil || actor.ID == uuid.Nil {
			continue
		}
		actors = append(actors, actor)
	}
	return actors, nil
}

// publishWhiteboardPresenceSnapshot elects at most one live connection per
// room/interval. Periodic canonical rosters remove ghost cursors after an
// application instance disappears without being able to publish "left".
func (s *Server) publishWhiteboardPresenceSnapshot(ctx context.Context, client *whiteboardcore.RealtimeClient) error {
	if s.cache == nil || client == nil {
		return nil
	}
	selected, err := s.cache.SetNX(ctx, whiteboardPresenceSnapshotLeaseKey(client.AccountID, client.BoardID),
		[]byte(client.ID.String()), whiteboardPresenceSnapshotLease)
	if err != nil || !selected {
		return err
	}
	presence, err := s.whiteboardPresence(ctx, client.AccountID, client.BoardID)
	if err != nil {
		return err
	}
	s.broadcastWhiteboardMessage(client.AccountID, client.BoardID, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventPresenceSnapshot,
		Data:  presence,
	}, uuid.Nil)
	presentation, err := s.whiteboardPresentationSnapshotMessage(ctx, client.AccountID, client.BoardID)
	if err != nil {
		return err
	}
	s.broadcastWhiteboardMessage(client.AccountID, client.BoardID, presentation, uuid.Nil)
	return nil
}
