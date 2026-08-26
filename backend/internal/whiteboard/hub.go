package whiteboard

import (
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

const MaxConnectionsPerBoard = 50

const realtimeControlQueueSize = 4

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
	ID                     uuid.UUID
	AccountID              uuid.UUID
	BoardID                uuid.UUID
	AccessRevision         int64
	GuestExpiresAt         *time.Time
	AuthorizationCheckedAt time.Time
	Actor                  RealtimeActor
	Send                   chan []byte
	// HoldUntilActivated keeps a newly registered socket visible to room
	// fanout while preventing any event from becoming deliverable before its
	// canonical initial snapshot. Broadcasts received during the snapshot read
	// are retained in registration order and released behind that snapshot.
	HoldUntilActivated bool
	authorizationMu    sync.RWMutex
	presentationMu     sync.RWMutex
	presentationID     uuid.UUID
	deliveryMu         sync.Mutex
	stateMu            sync.RWMutex
	initialized        bool
	activated          bool
	bootstrap          [][]byte
	pending            [][]byte
	pendingControl     []byte
	control            chan []byte
	closed             bool
	done               chan struct{}
	terminal           []byte
	closeOnce          sync.Once
}

// RealtimeAuthorization is the minimum account-scoped identity needed to
// revalidate a room member after whiteboards.access_revision changes. It never
// carries an HTTP session, collaboration ticket, guest token or other bearer
// material into the room hub.
type RealtimeAuthorization struct {
	ClientID       uuid.UUID
	AccessRevision int64
	Access         string
	UserID         *uuid.UUID
	GuestID        *uuid.UUID
	GuestExpiresAt *time.Time
	CheckedAt      time.Time
}

func cloneRealtimeUUID(value *uuid.UUID) *uuid.UUID {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

// ActorSnapshot returns a race-free copy whose access level reflects the most
// recent canonical revalidation, rather than the ticket-time permission.
func (c *RealtimeClient) ActorSnapshot() RealtimeActor {
	if c == nil {
		return RealtimeActor{}
	}
	c.authorizationMu.RLock()
	defer c.authorizationMu.RUnlock()
	actor := c.Actor
	actor.UserID = cloneRealtimeUUID(c.Actor.UserID)
	actor.GuestID = cloneRealtimeUUID(c.Actor.GuestID)
	return actor
}

func (c *RealtimeClient) AuthorizationSnapshot() RealtimeAuthorization {
	if c == nil {
		return RealtimeAuthorization{}
	}
	c.authorizationMu.RLock()
	defer c.authorizationMu.RUnlock()
	return RealtimeAuthorization{
		ClientID:       c.ID,
		AccessRevision: c.AccessRevision,
		Access:         c.Actor.Access,
		UserID:         cloneRealtimeUUID(c.Actor.UserID),
		GuestID:        cloneRealtimeUUID(c.Actor.GuestID),
		GuestExpiresAt: cloneRealtimeTime(c.GuestExpiresAt),
		CheckedAt:      c.AuthorizationCheckedAt,
	}
}

func cloneRealtimeTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	copyValue := *value
	return &copyValue
}

// UpdateAuthorization atomically advances both the revision gate and the
// actor metadata before another room payload can be broadcast.
func (c *RealtimeClient) UpdateAuthorization(revision int64, access string) bool {
	if c == nil {
		return false
	}
	c.authorizationMu.Lock()
	defer c.authorizationMu.Unlock()
	if revision < c.AccessRevision {
		return false
	}
	c.AccessRevision = revision
	c.Actor.Access = access
	c.AuthorizationCheckedAt = time.Now().UTC()
	return true
}

func (c *RealtimeClient) SetPresentation(id uuid.UUID) {
	c.presentationMu.Lock()
	c.presentationID = id
	c.presentationMu.Unlock()
}

func (c *RealtimeClient) Presentation() uuid.UUID {
	c.presentationMu.RLock()
	defer c.presentationMu.RUnlock()
	return c.presentationID
}

func (c *RealtimeClient) ClearPresentation(id uuid.UUID) bool {
	c.presentationMu.Lock()
	defer c.presentationMu.Unlock()
	if c.presentationID != id {
		return false
	}
	c.presentationID = uuid.Nil
	return true
}

func (c *RealtimeClient) initialize() {
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if !c.initialized {
		c.activated = !c.HoldUntilActivated
		c.initialized = true
	}
	if c.done == nil {
		c.done = make(chan struct{})
	}
	if c.control == nil {
		c.control = make(chan []byte, realtimeControlQueueSize)
	}
}

func (c *RealtimeClient) Enqueue(payload []byte) bool {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return false
	}
	c.initialize()
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed {
		return false
	}
	if !c.activated {
		// Bound the registration barrier by the normal transport capacity. If a
		// room can outpace the initial snapshot this far, callers close the slow
		// socket explicitly instead of losing an ordered scene operation.
		if c.Send == nil || len(c.pending) >= cap(c.Send) {
			return false
		}
		c.pending = append(c.pending, append([]byte(nil), payload...))
		return true
	}
	select {
	case c.Send <- payload:
		return true
	default:
		return false
	}
}

// EnqueueAtRevision atomically verifies the principal epoch and queues one
// payload while holding the authorization read lock. PostgreSQL's board share
// lock is held by fanout callers around this method, so an ACL commit and its
// in-memory authorization update can only linearize before or after enqueue.
// The first result reports epoch eligibility; the second reports queue space.
func (c *RealtimeClient) EnqueueAtRevision(payload []byte, expectedRevision int64) (bool, bool) {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return false, false
	}
	c.initialize()
	c.authorizationMu.RLock()
	defer c.authorizationMu.RUnlock()
	if expectedRevision > 0 && c.AccessRevision != expectedRevision {
		return false, false
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed {
		return false, false
	}
	if !c.activated {
		if c.Send == nil || len(c.pending) >= cap(c.Send) {
			return true, false
		}
		c.pending = append(c.pending, append([]byte(nil), payload...))
		return true, true
	}
	select {
	case c.Send <- payload:
		return true, true
	default:
		return true, false
	}
}

func (c *RealtimeClient) IsActiveAtRevision(expectedRevision int64) bool {
	if c == nil {
		return false
	}
	c.initialize()
	c.authorizationMu.RLock()
	defer c.authorizationMu.RUnlock()
	if expectedRevision > 0 && c.AccessRevision != expectedRevision {
		return false
	}
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return !c.closed
}

// EnqueueControlLatest queues an ephemeral canonical control without ever
// displacing a durable scene or comment payload from Send. While the initial
// snapshot barrier is held, the latest control follows every already observed
// room event; once active, controls use their own bounded queue and supersede
// only older controls.
func (c *RealtimeClient) EnqueueControlLatest(payload []byte) bool {
	if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
		return false
	}
	c.initialize()
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed {
		return false
	}
	if !c.activated {
		c.pendingControl = append(c.pendingControl[:0], payload...)
		return true
	}
	for {
		select {
		case <-c.control:
			continue
		default:
			select {
			case c.control <- payload:
				return true
			default:
				return false
			}
		}
	}
}

// Control exposes the control-only delivery lane to the socket writer.
func (c *RealtimeClient) Control() <-chan []byte {
	c.initialize()
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.control
}

// ActivateWithInitial atomically fixes the first deliverable messages for a
// held client. The canonical snapshot belongs first; every event observed
// after registration is appended behind it before later broadcasts can enter
// Send. The writer drains Bootstrap before either transport queue.
func (c *RealtimeClient) ActivateWithInitial(initial ...[]byte) bool {
	c.initialize()
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed || c.activated || !c.HoldUntilActivated {
		return false
	}
	for _, payload := range initial {
		if len(payload) == 0 || len(payload) > MaxRealtimeMessageBytes {
			return false
		}
	}
	c.bootstrap = make([][]byte, 0, len(initial)+len(c.pending)+1)
	for _, payload := range initial {
		c.bootstrap = append(c.bootstrap, append([]byte(nil), payload...))
	}
	c.bootstrap = append(c.bootstrap, c.pending...)
	if len(c.pendingControl) > 0 {
		c.bootstrap = append(c.bootstrap, append([]byte(nil), c.pendingControl...))
	}
	c.pending = nil
	c.pendingControl = nil
	c.activated = true
	return true
}

// TakeBootstrap returns the next registration-barrier payload. Socket writers
// must drain this lane before Control or Send.
func (c *RealtimeClient) TakeBootstrap() ([]byte, bool) {
	c.initialize()
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	if c.closed || len(c.bootstrap) == 0 {
		return nil, false
	}
	payload := c.bootstrap[0]
	c.bootstrap[0] = nil
	c.bootstrap = c.bootstrap[1:]
	return payload, true
}

// DeliverIfActive linearizes a dequeued payload with terminal closure. A
// writer that already removed a scene/comment payload from Send must still
// pass this gate; when an ACL/lifecycle close wins first, the stale payload is
// suppressed and only the separately stored terminal event remains eligible.
func (c *RealtimeClient) DeliverIfActive(payload []byte, deliver func([]byte) error) (bool, error) {
	if c == nil || len(payload) == 0 || deliver == nil {
		return false, nil
	}
	c.initialize()
	c.deliveryMu.Lock()
	defer c.deliveryMu.Unlock()
	c.stateMu.RLock()
	closed := c.closed
	c.stateMu.RUnlock()
	if closed {
		return false, nil
	}
	return true, deliver(payload)
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

// CloseWithTerminal atomically prevents future deliveries, discards every
// regular queued payload and stores at most one terminal message outside Send.
// Writers must never drain Send after Done closes.
func (c *RealtimeClient) CloseWithTerminal(payload []byte) {
	c.initialize()
	c.deliveryMu.Lock()
	defer c.deliveryMu.Unlock()
	c.stateMu.Lock()
	if !c.closed {
		for {
			select {
			case <-c.Send:
				continue
			default:
				goto drained
			}
		}
	drained:
		for {
			select {
			case <-c.control:
				continue
			default:
				goto controlDrained
			}
		}
	controlDrained:
		c.bootstrap = nil
		c.pending = nil
		c.pendingControl = nil
		if len(payload) > 0 && len(payload) <= MaxRealtimeMessageBytes {
			c.terminal = append([]byte(nil), payload...)
		}
		c.closed = true
		c.closeOnce.Do(func() { close(c.done) })
	}
	c.stateMu.Unlock()
}

func (c *RealtimeClient) TakeTerminal() []byte {
	if c == nil {
		return nil
	}
	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	payload := append([]byte(nil), c.terminal...)
	c.terminal = nil
	return payload
}

func (c *RealtimeClient) close() {
	c.CloseWithTerminal(nil)
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
	return h.BroadcastAtRevision(accountID, boardID, message, exceptClient, 0)
}

// BroadcastAtRevision sends only to principals reauthorized at the exact
// board epoch held by the caller. A concurrently closed or advanced client is
// skipped, while a same-epoch full queue is returned as slow.
func (h *RoomHub) BroadcastAtRevision(accountID, boardID uuid.UUID, message OutgoingMessage, exceptClient uuid.UUID, expectedRevision int64) []uuid.UUID {
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
		authorized, queued := client.EnqueueAtRevision(payload, expectedRevision)
		if authorized && !queued {
			slow = append(slow, id)
		}
	}
	return slow
}

// BroadcastMembers is the only transport path for Clarin-owned comment data.
// Guest sockets share the scene room but must never observe comment payloads.
func (h *RoomHub) BroadcastMembers(accountID, boardID uuid.UUID, message OutgoingMessage, exceptClient uuid.UUID) []uuid.UUID {
	return h.BroadcastMembersAtRevision(accountID, boardID, message, exceptClient, 0)
}

func (h *RoomHub) BroadcastMembersAtRevision(accountID, boardID uuid.UUID, message OutgoingMessage, exceptClient uuid.UUID, expectedRevision int64) []uuid.UUID {
	payload, err := json.Marshal(message)
	if err != nil {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	var slow []uuid.UUID
	for id, client := range h.clients[boardID] {
		actor := client.ActorSnapshot()
		if id == exceptClient || client.AccountID != accountID || actor.UserID == nil || client.IsClosed() {
			continue
		}
		authorized, queued := client.EnqueueAtRevision(payload, expectedRevision)
		if authorized && !queued {
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
			actors = append(actors, client.ActorSnapshot())
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
// A final event is stored outside the regular queue before Done closes, so the
// writer can send it without draining any stale scene/comment payload first.
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
		// A revocation/lifecycle invalidation is a security boundary, not an
		// ordinary ordered room event. CloseWithTerminal also suppresses a
		// payload already dequeued by the writer but not yet delivered.
		client.CloseWithTerminal(payload)
		delete(room, clientID)
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
		actor := client.ActorSnapshot()
		if client.AccountID == accountID && actor.GuestID != nil && *actor.GuestID == guestID {
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
		actor := client.ActorSnapshot()
		if client.AccountID == accountID && actor.UserID != nil && *actor.UserID == userID {
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

// BoardIDsForAccount snapshots only rooms that this process currently serves
// for the account. Account-wide ACL/subscription signals can therefore
// revalidate local sockets without enumerating every persisted whiteboard.
func (h *RoomHub) BoardIDsForAccount(accountID uuid.UUID) []uuid.UUID {
	h.mu.RLock()
	defer h.mu.RUnlock()
	boardIDs := make([]uuid.UUID, 0)
	for boardID, room := range h.clients {
		for _, client := range room {
			if client.AccountID == accountID && !client.IsClosed() {
				boardIDs = append(boardIDs, boardID)
				break
			}
		}
	}
	return boardIDs
}

func (h *RoomHub) StaleAccessRevisionClientIDs(accountID, boardID uuid.UUID, canonical int64) []uuid.UUID {
	clients := h.StaleAccessRevisionClients(accountID, boardID, canonical)
	clientIDs := make([]uuid.UUID, 0, len(clients))
	for _, client := range clients {
		clientIDs = append(clientIDs, client.ClientID)
	}
	return clientIDs
}

func (h *RoomHub) StaleAccessRevisionClients(accountID, boardID uuid.UUID, canonical int64) []RealtimeAuthorization {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients := make([]RealtimeAuthorization, 0)
	for _, client := range h.clients[boardID] {
		authorization := client.AuthorizationSnapshot()
		if client.AccountID == accountID && !client.IsClosed() && authorization.AccessRevision != canonical {
			clients = append(clients, authorization)
		}
	}
	return clients
}

// FanoutAuthorizationClients returns stale principals and guests whose exact
// session deadline has elapsed. Share/session revocations advance the board
// revision transactionally; explicit access-change controls use force=true for
// global account/module changes that do not naturally touch a board revision.
func (h *RoomHub) FanoutAuthorizationClients(accountID, boardID uuid.UUID, canonical int64, now time.Time, force bool) []RealtimeAuthorization {
	h.mu.RLock()
	defer h.mu.RUnlock()
	clients := make([]RealtimeAuthorization, 0)
	for _, client := range h.clients[boardID] {
		authorization := client.AuthorizationSnapshot()
		guestExpired := authorization.GuestID != nil &&
			(authorization.GuestExpiresAt == nil || !authorization.GuestExpiresAt.After(now))
		if client.AccountID == accountID && !client.IsClosed() &&
			(force || authorization.AccessRevision != canonical || guestExpired) {
			clients = append(clients, authorization)
		}
	}
	return clients
}

// UpdateClientAuthorization updates only a client still registered in the
// exact account/board room. Returning the client lets the caller prioritize a
// permission notice without reopening a lookup that could cross a tenant.
func (h *RoomHub) UpdateClientAuthorization(accountID, boardID, clientID uuid.UUID, revision int64, access string) (*RealtimeClient, bool) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	client := h.clients[boardID][clientID]
	if client == nil || client.AccountID != accountID || client.IsClosed() {
		return nil, false
	}
	if !client.UpdateAuthorization(revision, access) {
		return client, false
	}
	return client, true
}
