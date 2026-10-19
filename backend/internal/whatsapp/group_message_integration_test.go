package whatsapp

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/config"
	"github.com/naperu/clarin/pkg/database"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func TestGroupMessageTransportIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_GROUP_MESSAGE_INTEGRATION") != "1" {
		t.Skip("requires isolated PostgreSQL")
	}
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || parsed.Host == "" {
		t.Fatal("DATABASE_URL required")
	}
	ctx := context.Background()
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	name := "clarin_group_transport_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") })
	parsed.Path = "/" + name
	db, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	account, device := uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Transport QA')`, account)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'Synthetic')`, device, account)
	jid := types.NewJID("120088", types.GroupServer)
	author := types.NewJID("51999000111", types.DefaultUserServer)
	chat, err := repos.Chat.GetOrCreateGroup(ctx, account, device, jid.String(), "Transport QA")
	if err != nil {
		t.Fatal(err)
	}
	exec(`CREATE FUNCTION reject_transport_crm() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'group reached Leads'; END $$`)
	exec(`CREATE TRIGGER reject_transport_crm BEFORE INSERT OR UPDATE OR DELETE ON leads FOR EACH STATEMENT EXECUTE FUNCTION reject_transport_crm()`)
	hub := ws.NewHub()
	client := &ws.Client{ID: uuid.NewString(), AccountID: account, UserID: uuid.New(), Send: make(chan []byte, 16), Permissions: map[string]bool{domain.PermChats: true}}
	if !hub.RegisterAtAuthorityEpoch(client, hub.AuthorityEpoch(account, client.UserID)) {
		t.Fatal("register synthetic observer")
	}
	t.Cleanup(func() { hub.DisconnectAccountForAuthority(account) })
	go hub.Run()
	pool := &DevicePool{repos: repos, hub: hub, cfg: &config.Config{WhatsAppGroupChatsEnabled: true}}
	instance := &DeviceInstance{ID: device, AccountID: account, ReceiveMessages: true}
	now := time.Now().UTC().Truncate(time.Second)
	info := types.MessageInfo{MessageSource: types.MessageSource{Chat: jid, Sender: author, IsGroup: true}, ID: "same-provider-id", Timestamp: now}
	key := &waE2E.SenderKeyDistributionMessage{AxolotlSenderKeyDistributionMessage: []byte{1}}
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: &waE2E.Message{SenderKeyDistributionMessage: key}})
	assertCount := func(wantRows, wantUnread int) {
		t.Helper()
		var rows, unread, leads int
		var pending bool
		if err := db.QueryRow(ctx, `SELECT (SELECT count(*) FROM messages WHERE account_id=$1 AND chat_id=$2), unread_count,waiting_since IS NOT NULL,(SELECT count(*) FROM leads WHERE account_id=$1) FROM chats WHERE account_id=$1 AND id=$2`, account, chat.ID).Scan(&rows, &unread, &pending, &leads); err != nil {
			t.Fatal(err)
		}
		if rows != wantRows || unread != wantUnread || pending || leads != 0 {
			t.Fatalf("rows=%d unread=%d pending=%v leads=%d", rows, unread, pending, leads)
		}
	}
	assertCount(0, 0)
	text := &events.Message{Info: info, Message: &waE2E.Message{Conversation: proto.String("Authentic group text")}}
	pool.handleGroupMessage(ctx, instance, text)
	assertCount(1, 1)
	stored, err := repos.Message.GetByReference(ctx, account, chat.ID, info.ID)
	if err != nil || stored.Body == nil || *stored.Body != "Authentic group text" {
		t.Fatal("real payload was consumed by transport event", err)
	}
	observe := func(want string) {
		t.Helper()
		hub.BroadcastToAccountWithPermission(account, domain.PermChats, "qa_barrier", nil)
		contentEvents := 0
		for {
			select {
			case raw := <-client.Send:
				var event struct {
					Event string `json:"event"`
					Data  struct {
						Message *domain.Message `json:"message"`
					} `json:"data"`
				}
				if err := json.Unmarshal(raw, &event); err != nil {
					t.Fatal(err)
				}
				if event.Event == "qa_barrier" {
					if contentEvents != 1 {
						t.Fatalf("content event count=%d, want 1", contentEvents)
					}
					return
				}
				if event.Event == ws.EventChatUpdate {
					continue
				}
				if event.Event != want || event.Data.Message == nil || event.Data.Message.IsEdited {
					t.Fatalf("unexpected content event=%s, want=%s", event.Event, want)
				}
				contentEvents++
			case <-time.After(2 * time.Second):
				t.Fatal("canonical content event missing")
			}
		}
	}
	observe(ws.EventNewMessage)
	pool.handleGroupMessage(ctx, instance, text)
	assertCount(1, 1)

	// A previously persisted technical placeholder can be repaired only by its
	// authentic redelivery. The read decision and unread count remain intact.
	empty, kind, status, sender := "", domain.MessageTypeText, "received", author.String()
	placeholder := &domain.Message{AccountID: account, ChatID: chat.ID, DeviceID: &device, MessageID: "legacy-empty", FromJID: &sender, Body: &empty, MessageType: &kind, Status: &status, Timestamp: now.Add(time.Second), IsRead: true}
	if err = repos.Message.Create(ctx, placeholder); err != nil {
		t.Fatal(err)
	}
	info.ID, info.Timestamp = placeholder.MessageID, placeholder.Timestamp
	pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: &waE2E.Message{SenderKeyDistributionMessage: key, Conversation: proto.String("Authentic redelivery")}})
	assertCount(2, 1)
	repaired, err := repos.Message.GetByReference(ctx, account, chat.ID, placeholder.ID.String())
	if err != nil || repaired.Body == nil || *repaired.Body != "Authentic redelivery" || !repaired.IsRead || repaired.IsEdited || !repaired.Timestamp.Equal(placeholder.Timestamp) {
		t.Fatal("repair lost content or lifecycle", err)
	}
	observe("message_media_updated")

	// Identical text sent twice is two user messages when the provider IDs differ.
	// Deduplication belongs to the provider identity, never the message body.
	for index, providerID := range []string{"same-body-first", "same-body-second"} {
		info.ID, info.Timestamp = providerID, now.Add(time.Duration(index+2)*time.Second)
		pool.handleGroupMessage(ctx, instance, &events.Message{Info: info, Message: &waE2E.Message{Conversation: proto.String("Repeated visible payload")}})
		observe(ws.EventNewMessage)
	}
	assertCount(4, 3)
	var repeatedRows, distinctProviderIDs int
	if err = db.QueryRow(ctx, `SELECT count(*),count(DISTINCT message_id) FROM messages WHERE account_id=$1 AND chat_id=$2 AND body=$3`, account, chat.ID, "Repeated visible payload").Scan(&repeatedRows, &distinctProviderIDs); err != nil || repeatedRows != 2 || distinctProviderIDs != 2 {
		t.Fatal("same text with distinct provider IDs must remain two messages", err)
	}
	t.Run("recovered media snapshot", func(t *testing.T) {
		testGroupMediaSnapshot(t, ctx, pool, account, device, chat.ID)
	})
}
