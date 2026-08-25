package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestAttachReactionsToMessagesKeepsAccountAndChatIsolation(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	otherAccountID := uuid.New()
	chatID := uuid.New()
	otherChatID := uuid.New()
	message := &domain.Message{AccountID: accountID, ChatID: chatID, MessageID: "target-1"}
	otherMessage := &domain.Message{AccountID: otherAccountID, ChatID: chatID, MessageID: "target-1"}
	valid := &domain.MessageReaction{
		AccountID: accountID, ChatID: chatID, TargetMessageID: "target-1",
		SenderJID: "51999999999@s.whatsapp.net", Emoji: "👍", Timestamp: time.Now(),
	}
	reactions := []*domain.MessageReaction{
		valid,
		{AccountID: otherAccountID, ChatID: chatID, TargetMessageID: "target-1", Emoji: "🚫"},
		{AccountID: accountID, ChatID: otherChatID, TargetMessageID: "target-1", Emoji: "🚫"},
		nil,
	}

	attachReactionsToMessages(accountID, chatID, []*domain.Message{message, otherMessage, nil}, reactions)

	if len(message.Reactions) != 1 || message.Reactions[0] != valid {
		t.Fatalf("message reactions = %#v, want only account/chat scoped reaction", message.Reactions)
	}
	if otherMessage.Reactions != nil {
		t.Fatalf("other account message was mutated: %#v", otherMessage.Reactions)
	}
}

func TestAttachReactionsToMessagesClearsStaleSnapshot(t *testing.T) {
	t.Parallel()

	accountID := uuid.New()
	chatID := uuid.New()
	message := &domain.Message{
		AccountID: accountID,
		ChatID:    chatID,
		MessageID: "target-1",
		Reactions: []*domain.MessageReaction{{Emoji: "stale"}},
	}

	attachReactionsToMessages(accountID, chatID, []*domain.Message{message}, nil)

	if message.Reactions != nil {
		t.Fatalf("message reactions = %#v, want canonical empty snapshot", message.Reactions)
	}
}
