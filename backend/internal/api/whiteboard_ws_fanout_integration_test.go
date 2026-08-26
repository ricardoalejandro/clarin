package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	"github.com/naperu/clarin/internal/ws"
	clarincache "github.com/naperu/clarin/pkg/cache"
)

func TestWhiteboardHubControlAcrossInstances(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION=1 with a disposable REDIS_URL")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Fatal("REDIS_URL is required for the whiteboard Redis integration test")
	}
	cacheA, err := clarincache.New(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cacheB, err := clarincache.New(redisURL)
	if err != nil {
		_ = cacheA.Close()
		t.Fatal(err)
	}
	serverA := &Server{cache: cacheA, whiteboardInstanceID: uuid.New()}
	serverB := &Server{cache: cacheB, hub: ws.NewHub(), whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	go serverB.hub.Run()
	serverB.startWhiteboardFanout()
	t.Cleanup(func() {
		if serverB.whiteboardFanoutCancel != nil {
			serverB.whiteboardFanoutCancel()
		}
		_ = cacheA.Close()
		_ = cacheB.Close()
	})

	accountID, otherAccountID := uuid.New(), uuid.New()
	target := &ws.Client{ID: "Hub target", AccountID: accountID, UserID: uuid.New(), Send: make(chan []byte, 2), Permissions: map[string]bool{domain.PermWhiteboards: true}}
	withoutPermission := &ws.Client{ID: "Hub denied", AccountID: accountID, UserID: uuid.New(), Send: make(chan []byte, 2), Permissions: map[string]bool{}}
	other := &ws.Client{ID: "Hub other account", AccountID: otherAccountID, UserID: uuid.New(), Send: make(chan []byte, 2), Permissions: map[string]bool{domain.PermWhiteboards: true}}
	for _, client := range []*ws.Client{target, withoutPermission, other} {
		if !serverB.hub.RegisterAtAuthorityEpoch(client, serverB.hub.AuthorityEpoch(client.AccountID, client.UserID)) {
			t.Fatalf("could not register %s", client.ID)
		}
	}

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(75 * time.Millisecond)
	defer ticker.Stop()
	for {
		serverA.notifyWhiteboardWorkHubRevoked(accountID)
		select {
		case raw := <-target.Send:
			var message ws.Message
			if err := json.Unmarshal(raw, &message); err != nil {
				t.Fatal(err)
			}
			payload, ok := message.Data.(map[string]any)
			if message.Event != ws.EventTaskUpdate || !ok || payload["action"] != whiteboardWorkHubRevokedAction {
				t.Fatalf("unexpected remote Hub control: %#v", message)
			}
			select {
			case leaked := <-withoutPermission.Send:
				t.Fatalf("Hub control crossed module permission: %s", leaked)
			default:
			}
			select {
			case leaked := <-other.Send:
				t.Fatalf("Hub control crossed account boundary: %s", leaked)
			default:
			}
			return
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("timed out waiting for remote Hub control")
		}
	}
}

// This opt-in integration test uses a disposable Redis instance to prove that
// fan-out and immediate revocation work across two backend instances without
// crossing the account boundary. Unit tests cover the in-memory room hub.
func TestWhiteboardRedisFanoutAcrossInstances(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION=1 with a disposable REDIS_URL")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Fatal("REDIS_URL is required for the whiteboard Redis integration test")
	}

	cacheA, err := clarincache.New(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cacheB, err := clarincache.New(redisURL)
	if err != nil {
		_ = cacheA.Close()
		t.Fatal(err)
	}
	serverA := &Server{cache: cacheA, whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	serverB := &Server{cache: cacheB, whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	serverA.startWhiteboardFanout()
	serverB.startWhiteboardFanout()
	t.Cleanup(func() {
		if serverA.whiteboardFanoutCancel != nil {
			serverA.whiteboardFanoutCancel()
		}
		if serverB.whiteboardFanoutCancel != nil {
			serverB.whiteboardFanoutCancel()
		}
		_ = cacheA.Close()
		_ = cacheB.Close()
	})

	accountID, otherAccountID, boardID := uuid.New(), uuid.New(), uuid.New()
	userID := uuid.New()
	target := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: userID, UserID: &userID}, Send: make(chan []byte, 16),
	}
	otherAccount := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: otherAccountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: userID, UserID: &userID}, Send: make(chan []byte, 16),
	}
	guestID := uuid.New()
	guest := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: guestID, GuestID: &guestID}, Send: make(chan []byte, 16),
	}
	if err := serverB.whiteboardRooms.Register(target); err != nil {
		t.Fatal(err)
	}
	if err := serverB.whiteboardRooms.Register(otherAccount); err != nil {
		t.Fatal(err)
	}
	if err := serverB.whiteboardRooms.Register(guest); err != nil {
		t.Fatal(err)
	}

	patch := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventScenePatch, Sequence: 42}
	assertEventuallyRedisMessage(t, 5*time.Second, target.Send, func() {
		serverA.broadcastWhiteboardMessage(accountID, boardID, patch, uuid.Nil)
	}, func(message whiteboardcore.OutgoingMessage) bool {
		return message.Event == whiteboardcore.EventScenePatch && message.Sequence == 42
	})
	select {
	case payload := <-otherAccount.Send:
		t.Fatalf("cross-account Redis fanout leaked: %s", payload)
	case <-time.After(150 * time.Millisecond):
	}
	time.Sleep(150 * time.Millisecond)
	for {
		select {
		case <-guest.Send:
			continue
		default:
			goto guestSceneQueueDrained
		}
	}

guestSceneQueueDrained:

	comment := whiteboardcore.OutgoingMessage{Event: whiteboardcore.EventCommentChanged,
		Data: map[string]any{"action": "created", "thread": map[string]any{"id": uuid.New(), "body": "solo miembros"}}}
	assertEventuallyRedisMessage(t, 5*time.Second, target.Send, func() {
		serverA.broadcastWhiteboardMemberMessage(accountID, boardID, comment, uuid.Nil)
	}, func(message whiteboardcore.OutgoingMessage) bool {
		return message.Event == whiteboardcore.EventCommentChanged
	})
	select {
	case payload := <-guest.Send:
		t.Fatalf("comment Redis fanout leaked to guest: %s", payload)
	case <-time.After(200 * time.Millisecond):
	}

	assertEventuallyWhiteboardClientClosed(t, 5*time.Second, target, func() {
		serverA.revokeWhiteboardUserSockets(accountID, boardID, userID)
	})
	var terminal whiteboardcore.OutgoingMessage
	if err := json.Unmarshal(target.TakeTerminal(), &terminal); err != nil {
		t.Fatal(err)
	}
	if terminal.Event != whiteboardcore.EventAccessRevoked || terminal.Code != "access_revoked" {
		t.Fatalf("unexpected remote terminal: %#v", terminal)
	}
	select {
	case <-otherAccount.Done():
		t.Fatal("remote access revocation crossed the account boundary")
	case <-time.After(150 * time.Millisecond):
	}
}

func TestGeneralWebSocketAuthoritySignalAcrossInstances(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION=1 with a disposable REDIS_URL")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Fatal("REDIS_URL is required for the realtime Redis integration test")
	}

	cacheA, err := clarincache.New(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cacheB, err := clarincache.New(redisURL)
	if err != nil {
		_ = cacheA.Close()
		t.Fatal(err)
	}
	serverA := &Server{cache: cacheA, hub: ws.NewHub(), whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	serverB := &Server{cache: cacheB, hub: ws.NewHub(), whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	serverA.startWhiteboardFanout()
	serverB.startWhiteboardFanout()
	t.Cleanup(func() {
		if serverA.whiteboardFanoutCancel != nil {
			serverA.whiteboardFanoutCancel()
		}
		if serverB.whiteboardFanoutCancel != nil {
			serverB.whiteboardFanoutCancel()
		}
		_ = cacheA.Close()
		_ = cacheB.Close()
	})

	accountID, otherAccountID := uuid.New(), uuid.New()
	target := &ws.Client{ID: "target", AccountID: accountID, UserID: uuid.New(), Send: make(chan []byte, 1)}
	other := &ws.Client{ID: "other", AccountID: otherAccountID, UserID: uuid.New(), Send: make(chan []byte, 1)}
	if !serverB.hub.RegisterAtAuthorityEpoch(target, serverB.hub.AuthorityEpoch(target.AccountID, target.UserID)) ||
		!serverB.hub.RegisterAtAuthorityEpoch(other, serverB.hub.AuthorityEpoch(other.AccountID, other.UserID)) {
		t.Fatal("could not register remote general WebSocket clients")
	}

	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(75 * time.Millisecond)
	defer ticker.Stop()
	for serverB.hub.GetAccountClientCount(accountID) != 0 {
		serverA.publishGeneralRealtimeUserAuthorityChanged(accountID)
		select {
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("timed out waiting for remote general WebSocket authority closure")
		}
	}
	if got := serverB.hub.GetAccountClientCount(otherAccountID); got != 1 {
		t.Fatalf("cross-instance authority signal crossed tenant boundary: %d sockets remain", got)
	}
	select {
	case <-other.Send:
		t.Fatal("other-account general socket was closed")
	default:
	}
}

func assertEventuallyWhiteboardClientClosed(
	t *testing.T,
	timeout time.Duration,
	client *whiteboardcore.RealtimeClient,
	publish func(),
) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(75 * time.Millisecond)
	defer ticker.Stop()
	for {
		publish()
		select {
		case <-client.Done():
			return
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("timed out waiting for remote client closure")
		}
	}
}

func TestWhiteboardPresentationLeaseAcrossInstances(t *testing.T) {
	if os.Getenv("CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION") != "1" {
		t.Skip("set CLARIN_RUN_WHITEBOARD_REDIS_INTEGRATION=1 with a disposable REDIS_URL")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		t.Fatal("REDIS_URL is required for the whiteboard Redis integration test")
	}
	cacheA, err := clarincache.New(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	cacheB, err := clarincache.New(redisURL)
	if err != nil {
		_ = cacheA.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cacheA.Close()
		_ = cacheB.Close()
	})
	serverA := &Server{cache: cacheA, whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	serverB := &Server{cache: cacheB, whiteboardRooms: whiteboardcore.NewRoomHub(), whiteboardInstanceID: uuid.New()}
	accountID, boardID := uuid.New(), uuid.New()
	presenterA := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), DisplayName: "Ana", Access: "edit"}, Send: make(chan []byte, 16),
	}
	presenterB := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), DisplayName: "Luis", Access: "edit"}, Send: make(chan []byte, 16),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := serverA.registerWhiteboardPresence(ctx, presenterA); err != nil {
		t.Fatal(err)
	}
	if err := serverB.registerWhiteboardPresence(ctx, presenterB); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		serverA.unregisterWhiteboardPresence(presenterA)
		serverB.unregisterWhiteboardPresence(presenterB)
	})

	presentationID := uuid.New()
	started, idempotent, err := serverA.startWhiteboardPresentation(ctx, presenterA, presentationID)
	if err != nil || idempotent || started.ID != presentationID {
		t.Fatalf("first presenter did not acquire the lease: %#v %v", started, err)
	}
	if _, _, err := serverB.startWhiteboardPresentation(ctx, presenterB, uuid.New()); !errors.Is(err, errWhiteboardPresentationOccupied) {
		t.Fatalf("second backend instance bypassed the unique lease: %v", err)
	}
	snapshot, err := serverB.activeWhiteboardPresentation(ctx, accountID, boardID)
	if err != nil || snapshot == nil || snapshot.Actor.ID != presenterA.Actor.ID {
		t.Fatalf("late-join snapshot did not resolve the cross-instance presenter: %#v %v", snapshot, err)
	}
	if err := serverA.refreshWhiteboardPresentation(ctx, presenterA); err != nil {
		t.Fatalf("server-side renewal failed: %v", err)
	}
	serverA.releaseWhiteboardPresentation(presenterA, "presenter_left")
	if active, err := serverB.activeWhiteboardPresentation(ctx, accountID, boardID); err != nil || active != nil {
		t.Fatalf("disconnect cleanup left an active presentation: %#v %v", active, err)
	}

	otherAccountPresenter := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: uuid.New(), BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: uuid.New(), DisplayName: "Marta", Access: "edit"}, Send: make(chan []byte, 4),
	}
	if err := serverB.registerWhiteboardPresence(ctx, otherAccountPresenter); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { serverB.unregisterWhiteboardPresence(otherAccountPresenter) })
	if _, _, err := serverB.startWhiteboardPresentation(ctx, otherAccountPresenter, uuid.New()); err != nil {
		t.Fatalf("one account presentation blocked another account: %v", err)
	}
	serverB.releaseWhiteboardPresentation(otherAccountPresenter, "test_cleanup")
}

func assertEventuallyRedisMessage(
	t *testing.T,
	timeout time.Duration,
	messages <-chan []byte,
	publish func(),
	accept func(whiteboardcore.OutgoingMessage) bool,
) {
	t.Helper()
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(75 * time.Millisecond)
	defer ticker.Stop()
	for {
		publish()
		select {
		case payload := <-messages:
			var message whiteboardcore.OutgoingMessage
			if err := json.Unmarshal(payload, &message); err != nil {
				t.Fatalf("decode Redis fanout message: %v (%s)", err, payload)
			}
			if accept(message) {
				return
			}
		case <-ticker.C:
		case <-deadline.C:
			t.Fatal("timed out waiting for cross-instance Redis fanout")
		}
	}
}
