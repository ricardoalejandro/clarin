package whatsapp

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestOutgoingChatContextKeepsSelectedHistoryAndSender(t *testing.T) {
	account, device, lidChatID, pnChatID := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	pn, lid := "51900000001@s.whatsapp.net", "70001@lid"
	send := domain.MessageSendContext{AccountID: account, ChatID: lidChatID}
	lidChat := &domain.Chat{ID: lidChatID, AccountID: account, DeviceID: &device, JID: lid}
	pnChat := &domain.Chat{ID: pnChatID, AccountID: account, DeviceID: &device, JID: pn}
	if !validOutgoingChatContext(send, lidChat, account, device, lid, "") {
		t.Fatal("original LID history rejected")
	}
	if !validOutgoingChatContext(send, lidChat, account, device, pn, lid) {
		t.Fatal("verified transport address changed the selected history")
	}
	if validOutgoingChatContext(send, pnChat, account, device, pn, lid) {
		t.Fatal("other PN history silently replaced selected LID history")
	}
	if validOutgoingChatContext(send, lidChat, account, device, pn, "") {
		t.Fatal("unverified PN/LID relation accepted")
	}
	if validOutgoingChatContext(send, lidChat, uuid.New(), device, lid, "") {
		t.Fatal("foreign account accepted")
	}
	if validOutgoingChatContext(send, lidChat, account, uuid.New(), lid, "") {
		t.Fatal("another sender silently accepted")
	}
	aliased := *lidChat
	aliased.ID = pnChatID
	if validOutgoingChatContext(send, &aliased, account, device, lid, "") {
		t.Fatal("stale canonical replacement silently accepted")
	}
}
