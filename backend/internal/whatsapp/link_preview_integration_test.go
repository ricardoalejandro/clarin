package whatsapp

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/ws"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
	"testing"
	"time"
)

func testLinkPreviewTransport(t *testing.T, ctx context.Context, pool *DevicePool, instance *DeviceInstance, observer *ws.Client) {
	t.Helper()
	chat, err := pool.repos.Chat.GetOrCreateGroup(ctx, instance.AccountID, instance.ID, "120097@g.us", "Preview transport")
	if err != nil {
		t.Fatal(err)
	}
	link, body := "https://example.test/preview", "Original https://example.test/preview"
	info := types.MessageInfo{MessageSource: types.MessageSource{Chat: types.NewJID("120097", types.GroupServer), Sender: types.NewJID("51999000111", types.DefaultUserServer), IsGroup: true}, ID: "preview-transport", Timestamp: time.Now().UTC()}
	assertState := func() {
		t.Helper()
		var count, unread, leads int
		var pending bool
		if err := pool.repos.DB().QueryRow(ctx, `SELECT (SELECT count(*) FROM messages WHERE account_id=$1 AND chat_id=$2),unread_count,waiting_since IS NOT NULL,(SELECT count(*) FROM leads WHERE account_id=$1) FROM chats WHERE account_id=$1 AND id=$2`, instance.AccountID, chat.ID).Scan(&count, &unread, &pending, &leads); err != nil || count != 1 || unread != 1 || pending || leads != 0 {
			t.Fatalf("preview replay changed rows=%d unread=%d pending=%v leads=%d err=%v", count, unread, pending, leads, err)
		}
	}
	readEvent := func(want string, wantPreview bool, localID uuid.UUID) {
		t.Helper()
		pool.hub.BroadcastToAccountWithPermission(instance.AccountID, domain.PermChats, "preview_barrier", nil)
		count := 0
		for {
			select {
			case raw := <-observer.Send:
				var event struct {
					Event string                     `json:"event"`
					Data  map[string]json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(raw, &event); err != nil {
					t.Fatal(err)
				}
				if event.Event == "preview_barrier" {
					if count != 1 {
						t.Fatalf("event count=%d want1", count)
					}
					return
				}
				// Cache invalidation publishes the canonical chat state before its
				// content event. Count only content, without accepting another chat.
				if event.Event == ws.EventChatUpdate {
					var stateChatID uuid.UUID
					if err := json.Unmarshal(event.Data["chat_id"], &stateChatID); err != nil || stateChatID != chat.ID {
						t.Fatal("chat state event crossed the preview fixture scope", err)
					}
					continue
				}
				if event.Event != want {
					t.Fatalf("unexpected event %s wanted %s", event.Event, want)
				}
				count++
				if want == "message_link_preview_updated" {
					var id uuid.UUID
					_ = json.Unmarshal(event.Data["message_id"], &id)
					var snapshot string
					_ = json.Unmarshal(event.Data["body_snapshot"], &snapshot)
					if id != localID || snapshot != body {
						t.Fatal("enrichment event lost UUID/body guard")
					}
				}
				if want == ws.EventMessageEdited || want == "message_link_preview_updated" {
					var version int64
					if err := json.Unmarshal(event.Data["link_preview_version"], &version); err != nil || version < 1 {
						t.Fatal("preview event omitted committed version", err)
					}
					raw, ok := event.Data["link_preview"]
					if !ok || (string(raw) != "null") != wantPreview {
						t.Fatal("partial event omitted canonical preview state")
					}
				}
			case <-time.After(2 * time.Second):
				t.Fatal("preview event missing")
			}
		}
	}
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: &waE2E.Message{Conversation: &body}})
	readEvent(ws.EventNewMessage, false, uuid.Nil)
	assertState()
	stored, err := pool.repos.Message.GetByReference(ctx, instance.AccountID, chat.ID, info.ID)
	if err != nil {
		t.Fatal(err)
	}
	payload := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: &body, MatchedText: &link, Title: proto.String("Preview"), Description: proto.String("Received metadata"), JPEGThumbnail: []byte("invalid JPEG")}}
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: payload})
	readEvent("message_link_preview_updated", true, stored.ID)
	assertState()
	// Repeated provider delivery cannot generate a second arrival or update.
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: payload})
	assertState()
	editedBody := "Edited without a link"
	pool.applyGroupProtocol(ctx, instance, chat, &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: &info.ID}, EditedMessage: &waE2E.Message{Conversation: &editedBody}, TimestampMS: proto.Int64(time.Now().UnixMilli())})
	readEvent(ws.EventMessageEdited, false, stored.ID)
	assertState()
	current, err := pool.repos.Message.GetByReference(ctx, instance.AccountID, chat.ID, info.ID)
	if err != nil || current.LinkPreview != nil || current.Body == nil || *current.Body != editedBody || !current.IsEdited {
		t.Fatal("edit retained stale preview or lost body", err)
	}
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: payload})
	assertState()
	// A subsequent edit replaces the card using only its own provider metadata.
	newLink, newBody := "https://example.test/new", "New https://example.test/new"
	newPayload := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: &newBody, MatchedText: &newLink, Title: proto.String("New preview")}}
	pool.applyGroupProtocol(ctx, instance, chat, &waE2E.ProtocolMessage{Type: waE2E.ProtocolMessage_MESSAGE_EDIT.Enum(), Key: &waCommon.MessageKey{ID: &info.ID}, EditedMessage: newPayload, TimestampMS: proto.Int64(time.Now().Add(time.Second).UnixMilli())})
	readEvent(ws.EventMessageEdited, true, stored.ID)
	assertState()
	current, err = pool.repos.Message.GetByReference(ctx, instance.AccountID, chat.ID, info.ID)
	if err != nil || current.LinkPreview == nil || current.LinkPreview.URL != newLink {
		t.Fatal("new edit did not replace preview", err)
	}
}
