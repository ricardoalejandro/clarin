package whiteboard

import (
	"encoding/json"
	"errors"
	"sync"

	"github.com/google/uuid"
)

const MaxConnectionsPerBoard = 50

var ErrRoomCapacity = errors.New("whiteboard room capacity reached")

type RealtimeActor struct {
	Kind        string     `json:"kind"`
	ID          uuid.UUID  `json:"id"`
	DisplayName string     `json:"display_name"`
	Access      string     `json:"access"`
	UserID      *uuid.UUID `json:"-"`
	GuestID     *uuid.UUID `json:"-"`
}

type RealtimeClient struct {
	ID        uuid.UUID
	AccountID uuid.UUID
	BoardID   uuid.UUID
	Actor     RealtimeActor
	Send      chan []byte
	stateMu   sync.RWMutex
	closed    bool
	done      chan struct{}
	closeOnce sync.Once
}

func (c *RealtimeClient) initialize() {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.done == nil {
		c.done = make(chan struct{})
	}
}

func (c *RealtimeClient) Enqueue(payload []byte) bool {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return false
	}
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	if c.closed {
		return false
	}
	select {
	case c.Send <- payload:
		return true
	default:
		return false
	}
}

// ReplaceQueued discards stale ephemeral/replay messages and enqueues one
// bounded canonical invalidation. It is used only when a client queue cannot
// accept the next ordered scene operation; reloading the REST snapshot is then
// safer than silently dropping one sequence and continuing with later deltas.
func (c *RealtimeClient) ReplaceQueued(payload []byte) bool {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return false
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed || c.Send == nil {
		return false
	}
	for {
		select {
		case <-c.Send:
			continue
		default:
			select {
			case c.Send <- payload:
				return true
			default:
				return false
			}
		}
	}
}

func (c *RealtimeClient) Done() <-chan struct{} {
	c.initialize()
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.done
}

func (c *RealtimeClient) IsClosed() bool {
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.closed
}

func (c *RealtimeClient) close() {
	c.initialize()
	c.stateMu.Lock()
	if !c.closed {
		c.closed = true
		c.closeOnce.Do(func() { close(c.done) })
	}
	c.stateMu.Unlock()
}

type RoomHub struct {
	mu      sync.RWMutex
	clients map[uuid.UUID]map[uuid.UUID]*RealtimeClient
}

func NewRoomHub() *RoomHub {
	return &RoomHub{clients: make(map[uuid.UUID]map[uuid.UUID]*RealtimeClient)}
}

func (h *RoomHub) Register(client *RealtimeClient) error {
	if client == nil || client.ID == uuid.Nil || client.AccountID == uuid.Nil || client.BoardID == uuid.Nil || client.Send == nil {
		return ErrInvalidRealtimeMessage
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	client.initialize()
	room := h.clients[client.BoardID]
	if room == nil {
		room = make(map[uuid.UUID]*RealtimeClient)
		h.clients[client.BoardID] = room
	}
	if _, replacing := room[client.ID]; !replacing && len(room) >= MaxConnectionsPerBoard {
		return ErrRoomCapacity
	}
	room[client.ID] = client
	return nil
}

func (h *RoomHub) Unregister(clientID, boardID uuid.UUID) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.clients[boardID]
	client := room[clientID]
	if client == nil {
		return
	}
	delete(room, clientID)
	client.close()
	if len(room) == 0 {
		delete(h.clients, boardID)
	}
}

// Broadcast never crosses a board or account boundary. A mismatched account is
// ignored even if a caller accidentally supplies a board UUID from another
// tenant. Slow clients are returned so their transport can close explicitly.
func (h *RoomHub) Broadcast(accountID, boardID uuid.UUID, message OutgoingMessage, exceptClient uuid.UUID) []uuid.UUID {
	payload, err := json.Marshal(message)
	if err != nil {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	var slow []uuid.UUID
	for id, client := range h.clients[boardID] {
		if id == exceptClient || client.AccountID != accountID || client.IsClosed() {
			continue
		}
		if !client.Enqueue(payload) {
			slow = append(slow, id)
		}
	}
	return slow
}

func (h *RoomHub) Presence(accountID, boardID uuid.UUID) []RealtimeActor {
	h.mu.RLock()
	defer h.mu.RUnlock()
	room := h.clients[boardID]
	actors := make([]RealtimeActor, 0, len(room))
	for _, client := range room {
		if client.AccountID == accountID && !client.IsClosed() {
			actors = append(actors, client.Actor)
		}
	}
	return actors
}

func (h *RoomHub) Count(accountID, boardID uuid.UUID) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	count := 0
	for _, client := range h.clients[boardID] {
		if client.AccountID == accountID && !client.IsClosed() {
			count++
		}
	}
	return count
}

// Disconnect removes selected clients atomically from an account-scoped room.
// A final event is queued before the channel closes so active writers can send
// access.revoked before terminating the socket.
func (h *RoomHub) Disconnect(accountID, boardID uuid.UUID, clientIDs []uuid.UUID, final *OutgoingMessage) {
	if len(clientIDs) == 0 {
		return
	}
	selected := make(map[uuid.UUID]struct{}, len(clientIDs))
	for _, clientID := range clientIDs {
		selected[clientID] = struct{}{}
	}
	var payload []byte
	if final != nil {
		payload, _ = json.Marshal(final)
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	room := h.clients[boardID]
	for clientID := range selected {
		client := room[clientID]
		if client == nil || client.AccountID != accountID || client.IsClosed() {
			continue
		}
		if len(payload) > 0 {
			client.Enqueue(payload)
		}
		delete(room, clientID)
		client.close()
	}
	if len(room) == 0 {
		delete(h.clients, boardID)
	}
}

func (h *RoomHub) RevokeGuestSession(accountID, boardID, guestID uuid.UUID) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var revoked []uuid.UUID
	for id, client := range h.clients[boardID] {
		if client.AccountID == accountID && client.Actor.GuestID != nil && *client.Actor.GuestID == guestID {
			revoked = append(revoked, id)
		}
	}
	return revoked
}

func (h *RoomHub) RevokeUserAccess(accountID, boardID, userID uuid.UUID) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()
	var revoked []uuid.UUID
	for id, client := range h.clients[boardID] {
		if client.AccountID == accountID && client.Actor.UserID != nil && *client.Actor.UserID == userID {
			revoked = append(revoked, id)
		}
	}
	return revoked
}

func (h *RoomHub) ClientIDs(accountID, boardID uuid.UUID) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clientIDs := make([]uuid.UUID, 0, len(h.clients[boardID]))
	for id, client := range h.clients[boardID] {
		if client.AccountID == accountID && !client.IsClosed() {
			clientIDs = append(clientIDs, id)
		}
	}
	return clientIDs
}
