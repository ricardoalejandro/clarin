package api

import (
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
)

func TestPreparedChatBindingRejectsChangedSenderRevisionAndAccount(t *testing.T) {
	account, device, owner := uuid.New(), uuid.New(), uuid.New()
	c := &domain.Chat{ID: uuid.New(), AccountID: account, DeviceID: &device, JID: "1200001@g.us", BindingRevision: 4, BindingState: "verified_continuity", WhatsAppOwnerID: &owner}
	if !preparedChatMatches(c, account, device, c.JID, 4) {
		t.Fatal("current verified preparation rejected")
	}
	for _, change := range []func(*domain.Chat){
		func(c *domain.Chat) { c.AccountID = uuid.New() },
		func(c *domain.Chat) { d := uuid.New(); c.DeviceID = &d },
		func(c *domain.Chat) { c.DeviceID = nil },
		func(c *domain.Chat) { c.BindingRevision++ },
		func(c *domain.Chat) { c.BindingState = "conflict" },
		func(c *domain.Chat) { c.BindingState = "pending" },
		func(c *domain.Chat) { c.WhatsAppOwnerID = nil },
		func(c *domain.Chat) { c.JID = "1200002@g.us" },
	} {
		copy := *c
		change(&copy)
		if preparedChatMatches(&copy, account, device, c.JID, 4) {
			t.Fatal("stale/foreign preparation accepted")
		}
	}
}
