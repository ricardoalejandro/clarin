package api

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/ws"
)

func TestRemoteUserAuthoritySignalDisconnectsOnlyItsAccount(t *testing.T) {
	t.Parallel()

	hub := ws.NewHub()
	targetAccount, otherAccount := uuid.New(), uuid.New()
	target := &ws.Client{ID: "target", AccountID: targetAccount, UserID: uuid.New(), Send: make(chan []byte, 1)}
	other := &ws.Client{ID: "other", AccountID: otherAccount, UserID: uuid.New(), Send: make(chan []byte, 1)}
	if !hub.RegisterAtAuthorityEpoch(target, hub.AuthorityEpoch(target.AccountID, target.UserID)) ||
		!hub.RegisterAtAuthorityEpoch(other, hub.AuthorityEpoch(other.AccountID, other.UserID)) {
		t.Fatal("could not register general realtime test clients")
	}

	server := &Server{hub: hub}
	server.applyGeneralRealtimeUserAuthorityChanged(targetAccount)

	if got := hub.GetAccountClientCount(targetAccount); got != 0 {
		t.Fatalf("remote authority signal retained %d target-account sockets", got)
	}
	if got := hub.GetAccountClientCount(otherAccount); got != 1 {
		t.Fatalf("remote authority signal crossed tenant boundary: %d sockets remain", got)
	}
	if _, open := <-target.Send; open {
		t.Fatal("target-account socket remains open")
	}
	select {
	case <-other.Send:
		t.Fatal("other-account socket was closed")
	default:
	}
}
