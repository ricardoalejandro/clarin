package ws

import (
	"testing"

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
