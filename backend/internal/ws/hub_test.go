package ws

import (
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
