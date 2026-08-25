package api

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	clarincache "github.com/naperu/clarin/pkg/cache"
)

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

	assertEventuallyRedisMessage(t, 5*time.Second, target.Send, func() {
		serverA.revokeWhiteboardUserSockets(accountID, boardID, userID)
	}, func(message whiteboardcore.OutgoingMessage) bool {
		return message.Event == whiteboardcore.EventAccessRevoked && message.Code == "access_revoked"
	})
	select {
	case <-target.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("remote access revocation did not close the target client")
	}
	select {
	case <-otherAccount.Done():
		t.Fatal("remote access revocation crossed the account boundary")
	case <-time.After(150 * time.Millisecond):
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
