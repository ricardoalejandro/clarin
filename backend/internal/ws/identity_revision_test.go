package ws

import (
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestIdentityRevisionNoticeIsRestrictedToChatsOrReports(t *testing.T) {
	for _, event := range []string{EventWhatsAppIdentityUpdated, EventWhatsAppCRMIdentityUpdated} {
		msg := &Message{Event: event}
		for _, permission := range []string{domain.PermChats, domain.PermReports, domain.PermAll} {
			if !clientCanReceive(&Client{Permissions: map[string]bool{permission: true}}, msg) {
				t.Fatal("module subscriber omitted")
			}
		}
		for _, permission := range []string{domain.PermContacts, domain.PermDevices, domain.PermLeads, ""} {
			if clientCanReceive(&Client{Permissions: map[string]bool{permission: true}}, msg) {
				t.Fatal("unrelated subscriber received identity notice")
			}
		}
		if clientCanReceive(nil, msg) {
			t.Fatal("missing client accepted")
		}
	}
}
