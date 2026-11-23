package whatsapp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
)

// Reuse the transport test's isolated migrated database. This exercises the
// exact recovery loader without contacting WhatsApp or downloading an attachment.
func testGroupMediaSnapshot(t *testing.T, ctx context.Context, pool *DevicePool, accountID, deviceID, otherChatID uuid.UUID) {
	t.Helper()
	chat, err := pool.repos.Chat.GetOrCreateGroup(ctx, accountID, deviceID, "120089@g.us", "Media snapshot QA")
	if err != nil {
		t.Fatal(err)
	}
	const authorPN, authorLID, authorName = "51999000222@s.whatsapp.net", "99000222@lid", "Synthetic author"
	const quotedPN, quotedName = "51999000333@s.whatsapp.net", "Synthetic quoted member"
	err = pool.repos.Chat.SaveGroup(ctx, accountID, chat.ID, &domain.ChatGroup{Subject: "Media snapshot QA", MembershipStatus: "member", Kind: "group"}, []domain.GroupParticipant{
		{JID: authorPN, LID: authorLID, Name: authorName},
		{JID: quotedPN, Name: quotedName},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []struct {
		name        string
		mediaURL    *string
		recoverable bool
		reason      string
	}{
		{name: "recovered", mediaURL: strPtr("https://example.invalid/recovered.png")},
		{name: "recoverable", recoverable: true},
		{name: "too-large", reason: groupMediaTooLargeReason},
	} {
		t.Run(state.name, func(t *testing.T) {
			message := &domain.Message{
				AccountID: accountID, DeviceID: &deviceID, ChatID: chat.ID, MessageID: "snapshot-" + state.name,
				FromJID: strPtr(authorLID), FromName: strPtr(""), Body: strPtr("Caption @51999000333"),
				MessageType: strPtr(domain.MessageTypeImage), MediaURL: state.mediaURL, MediaMimetype: strPtr("image/png"),
				MediaUnavailableReason: state.reason, IsRead: true, DeferAttention: true, Status: strPtr("received"), Timestamp: time.Now().UTC(),
				QuotedMessageID: strPtr("quoted-provider-id"), QuotedBody: strPtr("Quoted body"), QuotedSender: strPtr(quotedPN),
				Mentions: []domain.MessageMention{{JID: quotedPN}},
			}
			if err := pool.repos.Message.Create(ctx, message); err != nil {
				t.Fatal(err)
			}
			if state.recoverable {
				if err := pool.repos.Message.RememberGroupMedia(ctx, accountID, chat.ID, message.MessageID, []byte{1}); err != nil {
					t.Fatal(err)
				}
			}
			snapshot, err := pool.loadGroupMediaSnapshot(ctx, accountID, chat.ID, message.ID)
			if err != nil {
				t.Fatal(err)
			}
			// Serialize the same envelope type as the Hub: a client on another
			// tab must receive the roster name, never the stored empty name.
			raw, err := json.Marshal(&ws.Message{Event: "message_media_updated", AccountID: accountID.String(), Data: map[string]any{
				"chat_id": chat.ID, "device_id": deviceID, "message": snapshot,
			}})
			if err != nil {
				t.Fatal(err)
			}
			var event struct {
				Data struct {
					ChatID   uuid.UUID       `json:"chat_id"`
					DeviceID uuid.UUID       `json:"device_id"`
					Message  *domain.Message `json:"message"`
				} `json:"data"`
			}
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			got := event.Data.Message
			if got == nil || got.ID != message.ID || got.MessageID != message.MessageID || got.AccountID != accountID || got.ChatID != chat.ID ||
				got.DeviceID == nil || *got.DeviceID != deviceID || event.Data.ChatID != chat.ID || event.Data.DeviceID != deviceID {
				t.Fatal("snapshot lost canonical message or envelope identity")
			}
			if got.FromName == nil || *got.FromName != authorName || got.FromJID == nil || *got.FromJID != authorLID {
				t.Fatal("snapshot did not retain the roster name and canonical author identity")
			}
			if len(got.Mentions) != 1 || got.Mentions[0].JID != quotedPN || got.Mentions[0].Name != quotedName ||
				got.QuotedSenderName == nil || *got.QuotedSenderName != quotedName || got.QuotedMessageID == nil || *got.QuotedMessageID != *message.QuotedMessageID ||
				got.QuotedSender == nil || *got.QuotedSender != quotedPN || got.QuotedBody == nil || *got.QuotedBody != *message.QuotedBody || got.Body == nil || *got.Body != *message.Body {
				t.Fatal("snapshot lost mentions, caption or quote identity/display")
			}
			if got.MediaRecoverable != state.recoverable || got.MediaUnavailableReason != state.reason ||
				(got.MediaURL == nil) != (state.mediaURL == nil) || (got.MediaURL != nil && *got.MediaURL != *state.mediaURL) {
				t.Fatal("snapshot lost canonical media availability")
			}
			var storedName string
			if err := pool.repos.DB().QueryRow(ctx, `SELECT from_name FROM messages WHERE account_id=$1 AND chat_id=$2 AND id=$3`, accountID, chat.ID, message.ID).Scan(&storedName); err != nil || storedName != "" {
				t.Fatal("display hydration must not rewrite stored sender data", err)
			}
			for _, scope := range []struct{ account, chat uuid.UUID }{
				{uuid.New(), chat.ID}, {accountID, otherChatID},
			} {
				foreign, err := pool.loadGroupMediaSnapshot(ctx, scope.account, scope.chat, message.ID)
				if foreign != nil || !errors.Is(err, pgx.ErrNoRows) {
					t.Fatal("snapshot crossed account or chat scope", err)
				}
			}
		})
	}
}
