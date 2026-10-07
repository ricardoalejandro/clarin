package repository

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestMessageQuoteIntegrityHydratesWithoutChangingMessage(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	repos := NewRepositories(pool)
	device := uuid.New()
	integrityExec(t, pool, `INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Synthetic quote device')`, device, f.account)
	chat, err := repos.Chat.GetOrCreate(context.Background(), f.account, device, "51900000001@s.whatsapp.net", "Synthetic chat")
	if err != nil {
		t.Fatal(err)
	}
	body, kind, status := "Keep canonical body", "text", "sent"
	when := time.Now().UTC().Truncate(time.Second)
	message := &domain.Message{AccountID: f.account, ChatID: chat.ID, DeviceID: &device, MessageID: "synthetic-reply", Body: &body, MessageType: &kind, IsFromMe: true, IsRead: true, Status: &status, Timestamp: when, Sender: &domain.MessageSender{Origin: "history"}}
	if err = repos.Message.Create(context.Background(), message); err != nil {
		t.Fatal(err)
	}
	quoteID, preview, sender := "original-stanza", "Quoted\nUnicode á", "51900000001@s.whatsapp.net"
	direction := false
	quote := domain.MessageQuote{MessageID: &quoteID, Body: &preview, Sender: &sender, IsFromMe: &direction}
	if changed, err := repos.Message.HydrateMissingQuote(context.Background(), uuid.New(), chat.ID, message.MessageID, quote); err != nil || changed {
		t.Fatal("cross-account quote hydration accepted")
	}
	if changed, err := repos.Message.HydrateMissingQuote(context.Background(), f.account, chat.ID, message.MessageID, quote); err != nil || !changed {
		t.Fatalf("authentic quote not hydrated: %v", err)
	}
	if changed, err := repos.Message.HydrateMissingQuote(context.Background(), f.account, chat.ID, message.MessageID, quote); err != nil || changed {
		t.Fatal("duplicate context was not idempotent")
	}
	other := "different-stanza"
	quote.MessageID = &other
	quote.Body = nil
	if changed, err := repos.Message.HydrateMissingQuote(context.Background(), f.account, chat.ID, message.MessageID, quote); err != nil || changed {
		t.Fatal("contradictory quote replaced canonical context")
	}
	stored, err := repos.Message.GetByReference(context.Background(), f.account, chat.ID, message.MessageID)
	if err != nil || stored == nil || stored.QuotedMessageID == nil || *stored.QuotedMessageID != quoteID || stored.QuotedBody == nil || *stored.QuotedBody != preview {
		t.Fatalf("quote not available after canonical reload: %v", err)
	}
	if stored.Body == nil || *stored.Body != body || !stored.IsRead || !stored.IsFromMe || !stored.Timestamp.Equal(when) || stored.Sender == nil || stored.Sender.Origin != "history" {
		t.Fatal("hydration changed body, author, read or history origin")
	}
	var count int
	if err = pool.QueryRow(context.Background(), `SELECT COUNT(*) FROM messages WHERE account_id=$1 AND chat_id=$2`, f.account, chat.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("hydration duplicated the message")
	}
}
