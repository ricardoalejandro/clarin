package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
)

// Real read handlers and SQL run in a newly created disposable database. No
// WhatsApp client, session, storage service or outbound route is instantiated.
func TestChatGroupContextIntegration(t *testing.T) {
	if os.Getenv("CLARIN_RUN_CHAT_GROUP_CONTEXT_INTEGRATION") != "1" {
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
	name := "clarin_group_context_" + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	account, foreign, device, otherDevice := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Context QA'),($2,'Other QA')`, account, foreign)
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$3,'First'),($2,$3,'Second')`, device, otherDevice, account)
	chat, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "120099@g.us", "Context QA")
	if err != nil {
		t.Fatal(err)
	}
	otherChat, err := repos.Chat.GetOrCreateGroup(ctx, account, otherDevice, chat.JID, "Context QA")
	if err != nil {
		t.Fatal(err)
	}
	members := []domain.GroupParticipant{
		{JID: "51999000111@s.whatsapp.net", LID: "7001@lid", Name: "Ana", Role: "member"},
		{JID: "51999000112@s.whatsapp.net", Name: "Luis", Role: "member"},
	}
	if err = repos.Chat.SaveGroup(ctx, account, chat.ID, &domain.ChatGroup{Subject: "Context QA", MembershipStatus: "member", Kind: "group"}, members); err != nil {
		t.Fatal(err)
	}
	server := &Server{repos: repos, services: service.NewServices(repos, nil, nil)}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		actorAccount := account
		if c.Get("X-Test-Foreign-Account") == "1" {
			actorAccount = foreign
		}
		c.Locals("account_id", actorAccount)
		return c.Next()
	})
	app.Get("/chats/:id/messages/:messageId/context", server.handleGetMessageContext)
	app.Get("/chats/:id/messages/search", server.handleSearchMessages)
	app.Get("/chats/:id/messages", server.handleGetMessages)
	type responseBody struct {
		Success  bool              `json:"success"`
		Target   *domain.Message   `json:"target"`
		Messages []*domain.Message `json:"messages"`
	}
	get := func(t *testing.T, path string, foreignAccount bool, wantStatus int) responseBody {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		if foreignAccount {
			request.Header.Set("X-Test-Foreign-Account", "1")
		}
		response, err := app.Test(request, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != wantStatus {
			t.Fatalf("read status=%d, want %d", response.StatusCode, wantStatus)
		}
		var body responseBody
		if err = json.NewDecoder(response.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if wantStatus == http.StatusOK && !body.Success {
			t.Fatal("read did not succeed")
		}
		return body
	}
	base := time.Now().UTC().Truncate(time.Second)
	for index, variant := range []string{"text", "recoverable", "too_large"} {
		t.Run(variant, func(t *testing.T) {
			body := "contextqa @51999000111"
			message := &domain.Message{
				AccountID: account, ChatID: chat.ID, DeviceID: &device,
				MessageID: "context-" + variant, MessageType: strPtr("text"), Body: &body,
				Timestamp: base.Add(time.Duration(index) * time.Second), Status: strPtr("sent"), IsFromMe: true,
				FromJID: &members[0].LID, QuotedSender: &members[1].JID,
				QuotedMessageID: strPtr("prior-message"), QuotedBody: strPtr("Prior body"),
				Mentions: []domain.MessageMention{{JID: members[0].JID}},
			}
			if variant != "text" {
				message.MessageType = strPtr("document")
				message.MediaFilename = strPtr("context.pdf")
				message.MediaMimetype = strPtr("application/pdf")
			}
			if variant == "too_large" {
				message.MediaUnavailableReason = "group_media_too_large"
			}
			if err = repos.Message.Create(ctx, message); err != nil {
				t.Fatal(err)
			}
			if variant == "recoverable" {
				if err = repos.Message.RememberGroupMedia(ctx, account, chat.ID, message.MessageID, []byte("synthetic-payload")); err != nil {
					t.Fatal(err)
				}
			}
			assertProjection := func(got *domain.Message) {
				t.Helper()
				if got == nil || got.ID != message.ID || got.AccountID != account || got.ChatID != chat.ID {
					t.Fatal("message identity or scope changed")
				}
				if len(got.Mentions) != 1 || got.Mentions[0].JID != members[0].JID || got.Mentions[0].Name != "Ana" {
					t.Fatal("persisted mention missing from projection")
				}
				if got.FromName == nil || *got.FromName != "Ana" || got.QuotedSenderName == nil || *got.QuotedSenderName != "Luis" || got.QuotedSender == nil || *got.QuotedSender != members[1].JID || got.QuotedBody == nil || *got.QuotedBody != "Prior body" {
					t.Fatal("sender/quote identity and labels must survive hydration")
				}
				if got.MediaRecoverable != (variant == "recoverable") || got.MediaUnavailableReason != message.MediaUnavailableReason || got.MediaDeleted {
					t.Fatal("canonical media availability missing from projection")
				}
			}
			assertContains := func(messages []*domain.Message) {
				t.Helper()
				for _, got := range messages {
					if got.ID == message.ID {
						assertProjection(got)
						return
					}
				}
				t.Fatal("message absent from response window")
			}
			path := "/chats/" + chat.ID.String() + "/messages/" + message.ID.String() + "/context"
			for reload := 0; reload < 2; reload++ {
				result := get(t, path, false, http.StatusOK)
				assertProjection(result.Target)
				assertContains(result.Messages)
			}
			assertContains(get(t, "/chats/"+chat.ID.String()+"/messages?limit=50", false, http.StatusOK).Messages)
			assertContains(get(t, "/chats/"+chat.ID.String()+"/messages/search?q=contextqa", false, http.StatusOK).Messages)
			get(t, path, true, http.StatusNotFound)
			get(t, "/chats/"+otherChat.ID.String()+"/messages/"+message.ID.String()+"/context", false, http.StatusNotFound)

			// A caller can hold duplicate objects plus stale foreign projections.
			// Only the matching account/chat copies may receive DB state or labels.
			copies := make([]*domain.Message, 0, 2)
			for i := 0; i < 2; i++ {
				copy, err := repos.Message.GetByReference(ctx, account, chat.ID, message.ID.String())
				if err != nil {
					t.Fatal(err)
				}
				copies = append(copies, copy)
			}
			foreignProjections := []*domain.Message{
				{ID: message.ID, AccountID: foreign, ChatID: chat.ID, FromJID: &members[0].LID, QuotedSender: &members[1].JID, Mentions: []domain.MessageMention{{JID: members[0].JID}}, MediaUnavailableReason: "untouched"},
				{ID: message.ID, AccountID: account, ChatID: otherChat.ID, FromJID: &members[0].LID, QuotedSender: &members[1].JID, Mentions: []domain.MessageMention{{JID: members[0].JID}}, MediaUnavailableReason: "untouched"},
			}
			projections := append(append(copies, nil), foreignProjections...)
			if err = repos.Message.HydrateMentions(ctx, account, chat.ID, projections); err != nil {
				t.Fatal(err)
			}
			for _, copy := range copies {
				assertProjection(copy)
			}
			for _, foreignCopy := range foreignProjections {
				if foreignCopy.MediaUnavailableReason != "untouched" || foreignCopy.MediaRecoverable || foreignCopy.Mentions[0].Name != "" || foreignCopy.FromName != nil || foreignCopy.QuotedSenderName != nil {
					t.Fatal("hydration altered a foreign account/chat projection")
				}
			}
		})
	}
}
