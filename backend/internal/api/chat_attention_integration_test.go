package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/pkg/database"
)

// Uses a unique disposable database. It must never share the production DB.
func TestChatAttentionIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_ATTENTION_INTEGRATION") != "1" {
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
	defer admin.Close()
	name := "clarin_chat_qa_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE DATABASE "+name); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(ctx, "DROP DATABASE "+name+" WITH (FORCE)") }()
	parsed.Path = "/" + name
	db, err := pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	repos := repository.NewRepositories(db)
	account, other, device, actor := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, e := db.Exec(ctx, query, args...); e != nil {
			t.Fatal(e)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Chat QA'),($2,'Other QA')`, account, other)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$2,'QA device')`, device, account)
	exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name,is_admin) VALUES($1,$2,'chat-qa','chat-qa@test.invalid','not-a-login','Asesora QA',TRUE)`, actor, account)
	chat, err := repos.Chat.GetOrCreate(ctx, account, device, "51999000001@s.whatsapp.net", "QA contact")
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Truncate(time.Second)
	create := func(id string, own bool, at time.Time, source string) *domain.Message {
		t.Helper()
		body := "QA"
		msg := &domain.Message{AccountID: account, DeviceID: &device, ChatID: chat.ID, MessageID: id, FromJID: &chat.JID, Body: &body, MessageType: strPtr("text"), IsFromMe: own, Status: strPtr("sent"), Timestamp: at}
		if source != "" {
			msg.Sender = &domain.MessageSender{Origin: source}
			msg.IsRead = source == "history"
		}
		if e := repos.Message.Create(ctx, msg); e != nil {
			t.Fatal(e)
		}
		return msg
	}
	state := func(unread int, pending bool) *domain.ChatState {
		t.Helper()
		st, e := repos.Chat.State(ctx, account, chat.ID)
		if e != nil {
			t.Fatal(e)
		}
		if st.UnreadCount != unread || st.NeedsReply != pending {
			t.Fatalf("state unread=%d pending=%v want %d %v", st.UnreadCount, st.NeedsReply, unread, pending)
		}
		return st
	}
	first := create("in-1", false, base, "")
	state(1, true)
	// Repair stale legacy counters once, without marking unread messages as read.
	exec(`UPDATE chats SET unread_count=42 WHERE account_id=$1 AND id=$2`, account, chat.ID)
	exec(`DELETE FROM migration_flags WHERE key='chat_attention_20260921'`)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	state(1, true)
	// Duplicate provider events, including concurrent echoes, increment once.
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); copy := *first; _ = repos.Message.Create(ctx, &copy) }()
	}
	wg.Wait()
	state(1, true)
	if _, _, err = repos.Chat.MarkAsRead(ctx, other, chat.ID, first.ID.String()); err == nil {
		t.Fatal("cross-account read accepted")
	}
	if _, _, err = repos.Chat.MarkAsRead(ctx, account, chat.ID, uuid.NewString()); err == nil {
		t.Fatal("unknown watermark accepted")
	}
	if _, _, err = repos.Chat.MarkAsRead(ctx, account, chat.ID, first.ID.String()); err != nil {
		t.Fatal(err)
	}
	state(0, true)
	second := create("in-2", false, base.Add(time.Second), "")
	if _, _, err = repos.Chat.MarkAsRead(ctx, account, chat.ID, first.ID.String()); err != nil {
		t.Fatal(err)
	}
	state(1, true)
	create("auto", true, base.Add(2*time.Second), "automation")
	state(1, true)
	create("history", false, base.Add(-time.Hour), "history")
	state(1, true)
	// An answer only clears the boundary captured before the provider send.
	sendctx := domain.WithMessageSendContext(ctx, domain.MessageSendContext{AccountID: account, ChatID: chat.ID, Sender: domain.MessageSender{UserID: &actor, Name: "Asesora QA", Origin: "manual"}, ThroughAt: &first.Timestamp, ThroughID: &first.ID})
	body := "Respuesta QA"
	out := &domain.Message{AccountID: account, DeviceID: &device, ChatID: chat.ID, MessageID: "manual", FromJID: strPtr("me"), Body: &body, MessageType: strPtr("text"), IsFromMe: true, Status: strPtr("sent"), Timestamp: base.Add(3 * time.Second)}
	if err = repos.Message.Create(sendctx, out); err != nil {
		t.Fatal(err)
	}
	st := state(1, true)
	if !st.WaitingSince.Equal(second.Timestamp) {
		t.Fatal("new inbound was swallowed by an older reply")
	}
	// The same author survives history, search, context and provider echo races.
	readback, err := repos.Message.GetByMessageID(ctx, chat.ID, out.MessageID)
	if err != nil || readback.Sender == nil || readback.Sender.UserID == nil || *readback.Sender.UserID != actor {
		t.Fatalf("sender missing: %v", err)
	}
	history, err := repos.Message.GetByChatID(ctx, chat.ID, 50, 0)
	if err != nil || len(history) != 5 {
		t.Fatalf("history: %d %v", len(history), err)
	}
	window, err := repos.Message.GetWindowByChatID(ctx, account, chat.ID, 50, 0)
	if err != nil || len(window) != 5 {
		t.Fatalf("context: %d %v", len(window), err)
	}
	ref, err := repos.Message.GetByReference(ctx, account, chat.ID, out.MessageID)
	if err != nil || ref.Sender == nil {
		t.Fatalf("reference: %v", err)
	}
	echo := create("echo", true, base.Add(4*time.Second), "whatsapp_external")
	echoContext := domain.WithMessageSendContext(ctx, domain.MessageSendContext{AccountID: account, ChatID: chat.ID, Sender: domain.MessageSender{UserID: &actor, Name: "Asesora QA", Origin: "quick_reply"}, ThroughAt: &second.Timestamp, ThroughID: &second.ID, DeferAttention: true})
	if err = repos.Message.Create(echoContext, echo); err != nil {
		t.Fatal(err)
	}
	state(1, true)
	if err = repos.Chat.AcknowledgeAttention(ctx, other, chat.ID, second.ID.String()); err == nil {
		t.Fatal("cross-account attention accepted")
	}
	if err = repos.Chat.AcknowledgeAttention(ctx, account, chat.ID, second.ID.String()); err != nil {
		t.Fatal(err)
	}
	state(0, false)
	if err = database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	state(0, false)
	third := create("in-3", false, base.Add(5*time.Second), "")
	state(1, true)
	if err = repos.Message.MarkAsRevoked(ctx, account, chat.JID, third.MessageID); err != nil {
		t.Fatal(err)
	}
	state(0, false)
	fourth := create("in-4", false, base.Add(6*time.Second), "")
	state(1, true)
	rows, total, err := repos.Chat.GetByAccountIDWithFilters(ctx, account, domain.ChatFilter{PendingOnly: true, Limit: 50})
	if err != nil || total != 1 || len(rows) != 1 || rows[0].WaitingSince == nil {
		t.Fatalf("pending query: %d %d %v", total, len(rows), err)
	}
	foreign, foreignTotal, err := repos.Chat.GetByAccountIDWithFilters(ctx, other, domain.ChatFilter{PendingOnly: true, Limit: 50})
	if err != nil || foreignTotal != 0 || len(foreign) != 0 {
		t.Fatal("pending tenant leak")
	}
	_, _, err = repos.Chat.GetByAccountIDWithFilters(ctx, account, domain.ChatFilter{PendingOnly: true, Limit: 1, AfterWaitingAt: &fourth.Timestamp, AfterID: chat.ID})
	if err != nil {
		t.Fatal(err)
	}
	// Exercise authenticated attribution/idempotency around a fake provider.
	s := &Server{repos: repos}
	app := fiber.New()
	calls := 0
	app.Use(func(c *fiber.Ctx) error { c.Locals("account_id", account); c.Locals("user_id", actor); return c.Next() })
	app.Post("/send", s.messageActorMiddleware, func(c *fiber.Ctx) error {
		calls++
		copy := *out
		copy.MessageID = fmt.Sprintf("api-%d", calls)
		copy.Timestamp = base.Add(8 * time.Second)
		copy.Sender = nil
		copy.ID = uuid.Nil
		if e := repos.Message.Create(c.Context(), &copy); e != nil {
			return e
		}
		return c.JSON(fiber.Map{"success": true, "message": copy})
	})
	operation := uuid.NewString()
	payload := fmt.Sprintf(`{"chat_id":%q,"to":%q,"client_operation_id":%q,"attention_through_message_id":%q,"body":"QA","sender":{"name":"Forged","user_id":%q}}`, chat.ID.String(), chat.JID, operation, fourth.ID.String(), uuid.NewString())
	request := func(raw string) (int, []byte) {
		t.Helper()
		req := httptest.NewRequest("POST", "/send", strings.NewReader(raw))
		req.Header.Set("Content-Type", "application/json")
		res, e := app.Test(req, 10000)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	code, data := request(payload)
	if code != 200 {
		t.Fatalf("first send: %d %s", code, data)
	}
	var sent struct {
		Message domain.Message `json:"message"`
	}
	if err = json.Unmarshal(data, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Message.Sender == nil || sent.Message.Sender.Name != "Asesora QA" || *sent.Message.Sender.UserID != actor {
		t.Fatal("spoofed sender accepted")
	}
	// A later revocation cannot invalidate a previously observed boundary or replay.
	if err = repos.Message.MarkAsRevoked(ctx, account, chat.JID, fourth.MessageID); err != nil {
		t.Fatal(err)
	}
	code, _ = request(payload)
	if code != 200 || calls != 1 {
		t.Fatalf("retry duplicated provider call: %d %d", code, calls)
	}
	code, _ = request(strings.Replace(payload, `"body":"QA"`, `"body":"changed"`, 1))
	if code != 409 || calls != 1 {
		t.Fatal("operation content conflict accepted")
	}
	// Simulate losing the HTTP response after the provider message was persisted.
	exec(`UPDATE chat_send_operations SET state='uncertain',response=NULL WHERE account_id=$1 AND id=$2`, account, operation)
	code, _ = request(payload)
	if code != 200 || calls != 1 {
		t.Fatal("lost response repeated a confirmed provider send")
	}
	// Without confirmation, an uncertain operation must never call the provider twice.
	exec(`UPDATE messages SET send_operation_id=NULL WHERE account_id=$1 AND send_operation_id=$2`, account, operation)
	code, _ = request(payload)
	if code != 409 || calls != 1 {
		t.Fatal("uncertain outcome repeated the provider send")
	}
	// Legacy and ordered quick replies round-trip without converting the caption to text.
	asset, e := repos.MediaAsset.Upsert(ctx, repository.MediaAssetUpsert{AccountID: account, ContentHash: "chat-qa", ObjectKey: account.String() + "/qa.png", MediaType: "image", ContentType: "image/png", Filename: "qa.png", SizeBytes: 1})
	if e != nil {
		t.Fatal(e)
	}
	attachmentID := uuid.New()
	qr := &domain.QuickReply{AccountID: account, Shortcut: "qa-sequence", Body: "Hello", Attachments: []domain.QuickReplyAttachment{{ID: attachmentID, MediaAssetID: &asset.ID, MediaType: "image", Caption: "*caption*\n😊"}}, Items: []domain.QuickReplyItem{{ID: uuid.New(), Type: "media", AttachmentID: &attachmentID}, {ID: uuid.New(), Type: "text", Text: "Hello"}}}
	if qr, err = repos.QuickReply.Create(ctx, qr); err != nil {
		t.Fatal(err)
	}
	loaded, e := repos.QuickReply.GetByID(ctx, account, qr.ID)
	if e != nil || len(loaded.Items) != 2 || loaded.Attachments[0].Caption != "*caption*\n😊" {
		t.Fatalf("quick reply round-trip: %v", e)
	}
}
