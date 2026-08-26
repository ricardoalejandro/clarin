package whiteboard

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

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
	payload := target.TakeTerminal()
	if len(payload) == 0 {
		t.Fatal("revocation message was not stored before channel close")
	}
	var outgoing OutgoingMessage
	if err := json.Unmarshal(payload, &outgoing); err != nil {
		t.Fatal(err)
	}
	if outgoing.Event != EventAccessRevoked {
		t.Fatalf("event = %q", outgoing.Event)
	}
}

func TestRoomHubDisconnectPrioritizesRevocationOverFullQueue(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, boardID := uuid.New(), uuid.New()
	client := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, Send: make(chan []byte, 2)}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}
	if !client.Enqueue([]byte(`{"event":"scene.patch","sequence":7}`)) ||
		!client.Enqueue([]byte(`{"event":"comment.changed","data":{"body":"privado"}}`)) {
		t.Fatal("could not fill the client queue")
	}

	final := OutgoingMessage{Event: EventAccessRevoked, Code: "access_revoked"}
	hub.Disconnect(accountID, boardID, []uuid.UUID{client.ID}, &final)

	payload := client.TakeTerminal()
	var outgoing OutgoingMessage
	if err := json.Unmarshal(payload, &outgoing); err != nil {
		t.Fatal(err)
	}
	if outgoing.Event != EventAccessRevoked || outgoing.Code != "access_revoked" {
		t.Fatalf("queued data survived revocation priority: %s", payload)
	}
	if len(client.Send) != 0 {
		t.Fatal("revocation queue retained a prior payload")
	}
	select {
	case <-client.Done():
	default:
		t.Fatal("revoked client remained open")
	}
}

func TestRoomHubFindsOnlyTenantScopedStaleAccessRevisions(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, otherAccountID, boardID := uuid.New(), uuid.New(), uuid.New()
	current := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 7, Send: make(chan []byte, 1)}
	stale := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 6, Send: make(chan []byte, 1)}
	otherTenant := &RealtimeClient{ID: uuid.New(), AccountID: otherAccountID, BoardID: boardID, AccessRevision: 6, Send: make(chan []byte, 1)}
	for _, client := range []*RealtimeClient{current, stale, otherTenant} {
		if err := hub.Register(client); err != nil {
			t.Fatal(err)
		}
	}
	ids := hub.StaleAccessRevisionClientIDs(accountID, boardID, 7)
	if len(ids) != 1 || ids[0] != stale.ID {
		t.Fatalf("stale clients = %v, want only %s", ids, stale.ID)
	}
	hub.Disconnect(accountID, boardID, ids, nil)
	if got := hub.Count(accountID, boardID); got != 1 {
		t.Fatalf("current tenant clients = %d, want 1", got)
	}
	if got := hub.Count(otherAccountID, boardID); got != 1 {
		t.Fatalf("cross-tenant socket was disconnected: %d", got)
	}
}

func TestRoomHubUpdatesAuthorizationAndActorMetadataWithinTenant(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, otherAccountID, boardID, userID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	client := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 2,
		Actor: RealtimeActor{ID: userID, UserID: &userID, Access: "view"}, Send: make(chan []byte, 1)}
	other := &RealtimeClient{ID: uuid.New(), AccountID: otherAccountID, BoardID: boardID, AccessRevision: 2,
		Actor: RealtimeActor{ID: userID, UserID: &userID, Access: "view"}, Send: make(chan []byte, 1)}
	for _, item := range []*RealtimeClient{client, other} {
		if err := hub.Register(item); err != nil {
			t.Fatal(err)
		}
	}
	updated, ok := hub.UpdateClientAuthorization(accountID, boardID, client.ID, 3, "edit")
	if !ok || updated != client {
		t.Fatal("tenant-scoped authorization update did not find the client")
	}
	snapshot := client.AuthorizationSnapshot()
	actor := client.ActorSnapshot()
	if snapshot.AccessRevision != 3 || snapshot.Access != "edit" || actor.Access != "edit" || snapshot.CheckedAt.IsZero() {
		t.Fatalf("authorization metadata was not updated atomically: snapshot=%#v actor=%#v", snapshot, actor)
	}
	if _, ok := hub.UpdateClientAuthorization(accountID, boardID, other.ID, 3, "edit"); ok {
		t.Fatal("authorization update crossed the account boundary")
	}
	otherSnapshot := other.AuthorizationSnapshot()
	if otherSnapshot.AccessRevision != 2 || otherSnapshot.Access != "view" {
		t.Fatalf("other tenant metadata changed: %#v", otherSnapshot)
	}
}

func TestRealtimeClientAuthorizationRevisionNeverMovesBackward(t *testing.T) {
	t.Parallel()
	client := &RealtimeClient{AccessRevision: 5,
		Actor: RealtimeActor{Access: "edit"}, Send: make(chan []byte, 1)}
	if client.UpdateAuthorization(4, "view") {
		t.Fatal("stale authorization update was accepted")
	}
	snapshot := client.AuthorizationSnapshot()
	if snapshot.AccessRevision != 5 || snapshot.Access != "edit" {
		t.Fatalf("stale resolver rolled authorization backward: %#v", snapshot)
	}
	if !client.UpdateAuthorization(6, "comment") {
		t.Fatal("newer canonical authorization was rejected")
	}
	snapshot = client.AuthorizationSnapshot()
	if snapshot.AccessRevision != 6 || snapshot.Access != "comment" {
		t.Fatalf("newer authorization was not applied: %#v", snapshot)
	}
}

func TestRoomHubActivationBarrierDeliversSnapshotBeforeConcurrentPatch(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, boardID := uuid.New(), uuid.New()
	client := &RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Send: make(chan []byte, 8), HoldUntilActivated: true,
	}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}

	broadcastDone := make(chan struct{})
	go func() {
		defer close(broadcastDone)
		slow := hub.Broadcast(accountID, boardID, OutgoingMessage{Event: EventScenePatch, Sequence: 11}, uuid.Nil)
		if len(slow) != 0 {
			t.Errorf("held client was treated as slow: %v", slow)
		}
	}()
	<-broadcastDone
	if len(client.Send) != 0 {
		t.Fatal("concurrent patch became deliverable before the initial snapshot")
	}

	snapshot, err := json.Marshal(OutgoingMessage{Event: EventSceneSnapshot, Sequence: 10})
	if err != nil {
		t.Fatal(err)
	}
	if !client.ActivateWithInitial(snapshot) {
		t.Fatal("could not release initial snapshot barrier")
	}
	first, ok := client.TakeBootstrap()
	if !ok {
		t.Fatal("initial snapshot missing from bootstrap")
	}
	second, ok := client.TakeBootstrap()
	if !ok {
		t.Fatal("patch observed during snapshot read was lost")
	}
	var firstMessage, secondMessage OutgoingMessage
	if err := json.Unmarshal(first, &firstMessage); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(second, &secondMessage); err != nil {
		t.Fatal(err)
	}
	if firstMessage.Event != EventSceneSnapshot || firstMessage.Sequence != 10 ||
		secondMessage.Event != EventScenePatch || secondMessage.Sequence != 11 {
		t.Fatalf("activation order = %#v then %#v", firstMessage, secondMessage)
	}

	hub.Broadcast(accountID, boardID, OutgoingMessage{Event: EventScenePatch, Sequence: 12}, uuid.Nil)
	select {
	case payload := <-client.Send:
		var message OutgoingMessage
		if err := json.Unmarshal(payload, &message); err != nil {
			t.Fatal(err)
		}
		if message.Sequence != 12 {
			t.Fatalf("post-activation sequence = %d, want 12", message.Sequence)
		}
	default:
		t.Fatal("post-activation patch was not queued")
	}
}

func TestRealtimeClientControlLaneNeverDisplacesDurableQueue(t *testing.T) {
	t.Parallel()
	client := &RealtimeClient{Send: make(chan []byte, 2)}
	scene := []byte(`{"event":"scene.patch","sequence":7}`)
	comment := []byte(`{"event":"comment.changed","data":{"body":"durable"}}`)
	if !client.Enqueue(scene) || !client.Enqueue(comment) {
		t.Fatal("could not fill durable queue")
	}
	oldControl := []byte(`{"event":"error","code":"permission_changed","data":{"access":"comment"}}`)
	latestControl := []byte(`{"event":"error","code":"permission_changed","data":{"access":"view"}}`)
	if !client.EnqueueControlLatest(oldControl) || !client.EnqueueControlLatest(latestControl) {
		t.Fatal("could not queue permission control")
	}
	if got := <-client.Send; string(got) != string(scene) {
		t.Fatalf("scene was displaced by control: %s", got)
	}
	if got := <-client.Send; string(got) != string(comment) {
		t.Fatalf("comment was displaced by control: %s", got)
	}
	select {
	case got := <-client.Control():
		if string(got) != string(latestControl) {
			t.Fatalf("control lane did not retain latest canonical notice: %s", got)
		}
	default:
		t.Fatal("permission control was not queued independently")
	}
}

func TestRoomHubBoardIDsForAccountReturnsOnlyLocalActiveRooms(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, otherAccountID := uuid.New(), uuid.New()
	boardA, boardB, boardOther := uuid.New(), uuid.New(), uuid.New()
	clients := []*RealtimeClient{
		{ID: uuid.New(), AccountID: accountID, BoardID: boardA, Send: make(chan []byte, 1)},
		{ID: uuid.New(), AccountID: accountID, BoardID: boardB, Send: make(chan []byte, 1)},
		{ID: uuid.New(), AccountID: otherAccountID, BoardID: boardOther, Send: make(chan []byte, 1)},
	}
	for _, client := range clients {
		if err := hub.Register(client); err != nil {
			t.Fatal(err)
		}
	}
	hub.Disconnect(accountID, boardB, []uuid.UUID{clients[1].ID}, nil)
	got := hub.BoardIDsForAccount(accountID)
	if len(got) != 1 || got[0] != boardA {
		t.Fatalf("active account rooms = %v, want only %s", got, boardA)
	}
}

func TestRealtimeClientAuthorizationSnapshotsStayAtomicUnderUpdates(t *testing.T) {
	t.Parallel()
	userID := uuid.New()
	client := &RealtimeClient{AccessRevision: 0,
		Actor: RealtimeActor{UserID: &userID, Access: "view"}, Send: make(chan []byte, 1)}
	var wg sync.WaitGroup
	errorsFound := make(chan error, 1)
	wg.Add(2)
	go func() {
		defer wg.Done()
		for revision := int64(1); revision <= 2_000; revision++ {
			access := "view"
			if revision%2 == 1 {
				access = "edit"
			}
			client.UpdateAuthorization(revision, access)
		}
	}()
	go func() {
		defer wg.Done()
		for range 2_000 {
			snapshot := client.AuthorizationSnapshot()
			want := "view"
			if snapshot.AccessRevision%2 == 1 {
				want = "edit"
			}
			if snapshot.Access != want {
				select {
				case errorsFound <- fmt.Errorf("revision/access torn: %#v", snapshot):
				default:
				}
				return
			}
		}
	}()
	wg.Wait()
	select {
	case err := <-errorsFound:
		t.Fatal(err)
	default:
	}
}

func TestRealtimeClientSuppressesDequeuedPayloadAfterTerminalClose(t *testing.T) {
	t.Parallel()
	client := &RealtimeClient{Send: make(chan []byte, 1)}
	client.initialize()
	queued := []byte(`{"event":"scene.patch","sequence":8}`)
	if !client.Enqueue(queued) {
		t.Fatal("could not queue payload")
	}
	dequeued := <-client.Send
	terminal := []byte(`{"event":"access.revoked","code":"access_revoked"}`)
	client.CloseWithTerminal(terminal)
	delivered, err := client.DeliverIfActive(dequeued, func([]byte) error {
		return errors.New("stale payload was delivered")
	})
	if err != nil || delivered {
		t.Fatalf("dequeued payload survived terminal close: delivered=%v err=%v", delivered, err)
	}
	if got := client.TakeTerminal(); string(got) != string(terminal) {
		t.Fatalf("terminal payload = %s, want %s", got, terminal)
	}
}

func TestRoomHubSlowDisconnectPurgesQueueWithoutLaterDrain(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, boardID := uuid.New(), uuid.New()
	client := &RealtimeClient{ID: uuid.New(), AccountID: accountID, BoardID: boardID, Send: make(chan []byte, 2)}
	if err := hub.Register(client); err != nil {
		t.Fatal(err)
	}
	if !client.Enqueue([]byte(`{"event":"scene.patch","sequence":1}`)) ||
		!client.Enqueue([]byte(`{"event":"scene.patch","sequence":2}`)) {
		t.Fatal("could not saturate queue")
	}
	hub.Disconnect(accountID, boardID, []uuid.UUID{client.ID}, nil)
	if len(client.Send) != 0 || len(client.TakeTerminal()) != 0 {
		t.Fatal("slow disconnect retained regular or terminal payloads")
	}
	if delivered, err := client.DeliverIfActive([]byte(`{"event":"scene.patch"}`), func([]byte) error { return nil }); err != nil || delivered {
		t.Fatalf("closed slow client remained deliverable: delivered=%v err=%v", delivered, err)
	}
}

func TestRoomHubFanoutAuthorizationSelectsStaleForcedAndExpiredGuests(t *testing.T) {
	t.Parallel()
	hub := NewRoomHub()
	accountID, boardID := uuid.New(), uuid.New()
	now := time.Now().UTC()
	activeExpiry, expiredAt := now.Add(time.Minute), now.Add(-time.Second)
	activeGuestID, expiredGuestID, userID := uuid.New(), uuid.New(), uuid.New()
	clients := []*RealtimeClient{
		{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 4,
			Actor: RealtimeActor{UserID: &userID}, Send: make(chan []byte, 1)},
		{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 4, GuestExpiresAt: &activeExpiry,
			Actor: RealtimeActor{GuestID: &activeGuestID}, Send: make(chan []byte, 1)},
		{ID: uuid.New(), AccountID: accountID, BoardID: boardID, AccessRevision: 4, GuestExpiresAt: &expiredAt,
			Actor: RealtimeActor{GuestID: &expiredGuestID}, Send: make(chan []byte, 1)},
	}
	for _, client := range clients {
		if err := hub.Register(client); err != nil {
			t.Fatal(err)
		}
	}
	selected := hub.FanoutAuthorizationClients(accountID, boardID, 4, now, false)
	if len(selected) != 1 || selected[0].ClientID != clients[2].ID {
		t.Fatalf("normal fanout selected %#v, want only expired guest", selected)
	}
	if forced := hub.FanoutAuthorizationClients(accountID, boardID, 4, now, true); len(forced) != len(clients) {
		t.Fatalf("forced access signal selected %d clients, want %d", len(forced), len(clients))
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
