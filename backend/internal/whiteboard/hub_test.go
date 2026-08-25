package whiteboard

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestRoomHubBroadcastIsBoardAndAccountScoped(t *testing.T) {
	hub := NewRoomHub()
	accountA, accountB := uuid.New(), uuid.New()
	board := uuid.New()
	clientA := &RealtimeClient{ID: uuid.New(), AccountID: accountA, BoardID: board, Actor: RealtimeActor{ID: uuid.New()}, Send: make(chan []byte, 1)}
	clientB := &RealtimeClient{ID: uuid.New(), AccountID: accountB, BoardID: board, Actor: RealtimeActor{ID: uuid.New()}, Send: make(chan []byte, 1)}
	if err := hub.Register(clientA); err != nil {
		t.Fatal(err)
	}
	if err := hub.Register(clientB); err != nil {
		t.Fatal(err)
	}

	hub.Broadcast(accountA, board, OutgoingMessage{Event: EventAck, Sequence: 4}, uuid.Nil)
	select {
	case raw := <-clientA.Send:
		var message OutgoingMessage
		if err := json.Unmarshal(raw, &message); err != nil || message.Sequence != 4 {
			t.Fatalf("unexpected message: %s (%v)", raw, err)
		}
	default:
		t.Fatal("account A did not receive its board event")
	}
	select {
	case raw := <-clientB.Send:
		t.Fatalf("cross-account event leaked: %s", raw)
	default:
	}
}

func TestRoomHubPresenceAndUnregister(t *testing.T) {
	hub := NewRoomHub()
	accountID, boardID := uuid.New(), uuid.New()
	client := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, Actor: RealtimeActor{ID: uuid.New(), DisplayName: "Ana"}, Send: make(chan []byte, 1)}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}
	if actors := hub.Presence(accountID, boardID); len(actors) != 1 || actors[0].DisplayName != "Ana" {
		t.Fatalf("unexpected presence: %#v", actors)
	}
	hub.Unregister(client.ID, boardID)
	if actors := hub.Presence(accountID, boardID); len(actors) != 0 {
		t.Fatalf("presence survived unregister: %#v", actors)
	}
}

func TestRoomHubMemberBroadcastNeverReachesGuestSockets(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
	member := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: RealtimeActor{ID: userID, UserID: &userID}, Send: make(chan []byte, 1)}
	guestID := uuid.New()
	guest := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: RealtimeActor{ID: guestID, GuestID: &guestID}, Send: make(chan []byte, 1)}
	if err := hub.Register(member); err != nil {
		t.Fatal(err)
	}
	if err := hub.Register(guest); err != nil {
		t.Fatal(err)
	}
	hub.BroadcastMembers(accountID, boardID, OutgoingMessage{Event: EventCommentChanged, Data: map[string]string{"body": "privado"}}, uuid.Nil)
	select {
	case <-member.Send:
	default:
		t.Fatal("authenticated member did not receive comment event")
	}
	select {
	case payload := <-guest.Send:
		t.Fatalf("comment data leaked to guest socket: %s", payload)
	default:
	}
}

func TestRoomHubDisconnectIsTenantScopedAndSendsRevocation(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID := uuid.New()
	otherAccountID := uuid.New()
	boardID := uuid.New()
	target := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, Send: make(chan []byte, 2)}
	other := &RealtimeClient{ID: uuid.New(), AccountID: otherAccountID, BoardID: boardID, Send: make(chan []byte, 2)}
	if err := hub.Register(target); err != nil {
		t.Fatal(err)
	}
	if err := hub.Register(other); err != nil {
		t.Fatal(err)
	}
	final := OutgoingMessage{Event: EventAccessRevoked, Code: "access_revoked"}
	hub.Disconnect(accountID, boardID, []uuid.UUID{target.ID, other.ID}, &final)
	if got := hub.Count(accountID, boardID); got != 0 {
		t.Fatalf("target account clients = %d, want 0", got)
	}
	if got := hub.Count(otherAccountID, boardID); got != 1 {
		t.Fatalf("other account clients = %d, want 1", got)
	}
	payload, ok := <-target.Send
	if !ok {
		t.Fatal("revocation message was not queued before channel close")
	}
	var outgoing OutgoingMessage
	if err := json.Unmarshal(payload, &outgoing); err != nil {
		t.Fatal(err)
	}
	if outgoing.Event != EventAccessRevoked {
		t.Fatalf("event = %q", outgoing.Event)
	}
}

func TestRealtimeClientReplaceQueuedKeepsOnlyCanonicalInvalidation(t *testing.T) {
	t.Parallel()
	client := &RealtimeClient{Send: make(chan []byte, 2)}
	if !client.Enqueue([]byte(`{"event":"scene.patch","sequence":1}`)) || !client.Enqueue([]byte(`{"event":"scene.patch","sequence":2}`)) {
		t.Fatal("could not fill client queue")
	}
	replacement := []byte(`{"event":"sync.required","sequence":9}`)
	if !client.ReplaceQueued(replacement) {
		t.Fatal("could not replace saturated queue")
	}
	if got := <-client.Send; string(got) != string(replacement) {
		t.Fatalf("stale operations survived canonical invalidation: %s", got)
	}
	select {
	case extra := <-client.Send:
		t.Fatalf("replacement left an extra queued message: %s", extra)
	default:
	}
	if client.ReplaceQueued(make([]byte, MaxRealtimeMessageBytes+1)) {
		t.Fatal("oversized queue replacement was accepted")
	}
}
