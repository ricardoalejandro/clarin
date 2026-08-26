package ws

import (
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestClientCanReceiveSensitiveEvents(t *testing.T) {
	withoutChats := &Client{Permissions: map[string]bool{domain.PermContacts: true}}
	withChats := &Client{Permissions: map[string]bool{domain.PermChats: true}}
	admin := &Client{Permissions: map[string]bool{domain.PermAll: true}}

	statusMessage := &Message{Event: EventWhatsAppStatus, Data: map[string]string{"text": "private"}}
	if clientCanReceive(withoutChats, statusMessage) {
		t.Fatal("client without Chats received a WhatsApp status payload")
	}
	if !clientCanReceive(withChats, statusMessage) || !clientCanReceive(admin, statusMessage) {
		t.Fatal("authorized client was denied a WhatsApp status payload")
	}

	restricted := &Message{Event: EventNotification, RequiredPermission: domain.PermReports}
	if clientCanReceive(withChats, restricted) {
		t.Fatal("client received an event from an unrelated module")
	}
	unrestricted := &Message{Event: EventVersionUpdate}
	if !clientCanReceive(withoutChats, unrestricted) {
		t.Fatal("ordinary account event was unexpectedly denied")
	}
}

func TestClientCanReceiveTargetedTaskEvent(t *testing.T) {
	target := uuid.New()
	other := uuid.New()
	message := &Message{Event: EventTaskReminder, RequiredPermission: domain.PermTasks, TargetUserIDs: []uuid.UUID{target}}
	if !clientCanReceive(&Client{UserID: target, Permissions: map[string]bool{domain.PermTasks: true}}, message) {
		t.Fatal("targeted user with Tasks permission was denied")
	}
	if clientCanReceive(&Client{UserID: other, Permissions: map[string]bool{domain.PermTasks: true}}, message) {
		t.Fatal("non-targeted user received a private task reminder")
	}
	if clientCanReceive(&Client{UserID: target, Permissions: map[string]bool{domain.PermContacts: true}}, message) {
		t.Fatal("targeted user without Tasks permission received a task reminder")
	}
}

func TestReactionBroadcastRequiresChatsPermission(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	accountID := uuid.New()
	hub.BroadcastToAccountWithPermission(accountID, domain.PermChats, EventMessageReaction, map[string]string{"emoji": "👍"})
	message := <-hub.broadcast

	if message.AccountID != accountID.String() || message.Event != EventMessageReaction || message.RequiredPermission != domain.PermChats {
		t.Fatalf("reaction broadcast metadata = %#v", message)
	}
	if clientCanReceive(&Client{Permissions: map[string]bool{domain.PermContacts: true}}, message) {
		t.Fatal("client without Chats permission received a reaction")
	}
	if !clientCanReceive(&Client{Permissions: map[string]bool{domain.PermChats: true}}, message) {
		t.Fatal("client with Chats permission was denied a reaction")
	}
}

func TestDisconnectUsersRemovesEveryAccountSocketWithoutTouchingOtherUsers(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	targetUserID, retainedUserID := uuid.New(), uuid.New()
	accountA, accountB := uuid.New(), uuid.New()
	targetA := &Client{ID: "target-a", UserID: targetUserID, AccountID: accountA, Send: make(chan []byte, 1)}
	targetB := &Client{ID: "target-b", UserID: targetUserID, AccountID: accountB, Send: make(chan []byte, 1)}
	retained := &Client{ID: "retained", UserID: retainedUserID, AccountID: accountA, Send: make(chan []byte, 1)}
	hub.clients[targetA] = true
	hub.clients[targetB] = true
	hub.clients[retained] = true
	hub.accountClients[accountA] = map[*Client]bool{targetA: true, retained: true}
	hub.accountClients[accountB] = map[*Client]bool{targetB: true}

	hub.DisconnectUsers([]uuid.UUID{targetUserID, targetUserID, uuid.Nil})

	if len(hub.clients) != 1 || !hub.clients[retained] {
		t.Fatalf("remaining clients = %#v, want only the unrelated user", hub.clients)
	}
	if len(hub.accountClients[accountA]) != 1 || !hub.accountClients[accountA][retained] {
		t.Fatal("target socket was not removed from the shared account index")
	}
	if _, exists := hub.accountClients[accountB]; exists {
		t.Fatal("empty account socket index was retained")
	}
	if _, open := <-targetA.Send; open {
		t.Fatal("first revoked socket send lane remains open")
	}
	if _, open := <-targetB.Send; open {
		t.Fatal("second revoked socket send lane remains open")
	}
	select {
	case <-retained.Send:
		t.Fatal("unrelated socket send lane was closed")
	default:
	}
}

func TestUserAuthorityEpochClosesRegisterAfterInvalidationRace(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	accountID, userID := uuid.New(), uuid.New()
	staleEpoch := hub.AuthorityEpoch(accountID, userID)

	hub.DisconnectUsers([]uuid.UUID{userID})
	stale := &Client{ID: "stale", AccountID: accountID, UserID: userID, Send: make(chan []byte, 1)}
	if hub.RegisterAtAuthorityEpoch(stale, staleEpoch) {
		t.Fatal("socket registered with an authority epoch captured before session invalidation")
	}
	if got := hub.GetAccountClientCount(accountID); got != 0 {
		t.Fatalf("stale registration changed account client count: %d", got)
	}

	current := &Client{ID: "current", AccountID: accountID, UserID: userID, Send: make(chan []byte, 1)}
	if !hub.RegisterAtAuthorityEpoch(current, hub.AuthorityEpoch(accountID, userID)) {
		t.Fatal("socket with the current authority epoch was rejected")
	}
}

func TestAccountAuthorityDisconnectIsTenantScopedAndRejectsStaleRegistration(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	accountID, otherAccountID := uuid.New(), uuid.New()
	target := &Client{ID: "target", AccountID: accountID, UserID: uuid.New(), Send: make(chan []byte, 1)}
	other := &Client{ID: "other", AccountID: otherAccountID, UserID: uuid.New(), Send: make(chan []byte, 1)}
	targetEpoch := hub.AuthorityEpoch(target.AccountID, target.UserID)
	if !hub.RegisterAtAuthorityEpoch(target, targetEpoch) ||
		!hub.RegisterAtAuthorityEpoch(other, hub.AuthorityEpoch(other.AccountID, other.UserID)) {
		t.Fatal("could not register authority test sockets")
	}

	hub.DisconnectAccountForAuthority(accountID)

	if got := hub.GetAccountClientCount(accountID); got != 0 {
		t.Fatalf("revoked account retained %d sockets", got)
	}
	if got := hub.GetAccountClientCount(otherAccountID); got != 1 {
		t.Fatalf("authority signal crossed account boundary: %d sockets remain", got)
	}
	if _, open := <-target.Send; open {
		t.Fatal("revoked account socket remains open")
	}
	select {
	case <-other.Send:
		t.Fatal("other account socket was closed")
	default:
	}

	late := &Client{ID: "late", AccountID: accountID, UserID: target.UserID, Send: make(chan []byte, 1)}
	if hub.RegisterAtAuthorityEpoch(late, targetEpoch) {
		t.Fatal("account socket registered with a pre-invalidation epoch")
	}
}

func TestConcurrentUserInvalidationCannotLeaveLateSocketRegistered(t *testing.T) {
	t.Parallel()

	for iteration := 0; iteration < 128; iteration++ {
		hub := NewHub()
		accountID, userID := uuid.New(), uuid.New()
		epoch := hub.AuthorityEpoch(accountID, userID)
		client := &Client{ID: "racing", AccountID: accountID, UserID: userID, Send: make(chan []byte, 1)}
		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			hub.RegisterAtAuthorityEpoch(client, epoch)
		}()
		go func() {
			defer wg.Done()
			<-start
			hub.DisconnectUsers([]uuid.UUID{userID})
		}()
		close(start)
		wg.Wait()
		if got := hub.GetAccountClientCount(accountID); got != 0 {
			t.Fatalf("iteration %d retained %d sockets after concurrent invalidation", iteration, got)
		}
	}
}
