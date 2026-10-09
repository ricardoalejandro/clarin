package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
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
	"github.com/naperu/clarin/internal/ws"
	"github.com/naperu/clarin/pkg/database"
)

func newFunctionalIntegrityIntegrationDB(t *testing.T, gate, prefix string) *pgxpool.Pool {
	t.Helper()
	if os.Getenv(gate) != "1" {
		t.Skip("requires isolated PostgreSQL")
	}
	ctx := context.Background()
	parsed, err := url.Parse(os.Getenv("DATABASE_URL"))
	if err != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost") || parsed.Port() != "15439" || (parsed.Path != "/clarin_cloud_dev" && parsed.Path != "/program_survey_integrity_test") {
		t.Fatal("exact isolated local QA database required")
	}
	adminURL := *parsed
	adminURL.Path = "/postgres"
	admin, err := pgxpool.New(ctx, adminURL.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	name := prefix + strings.ReplaceAll(uuid.NewString(), "-", "")
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
	if err = database.MigrateEventPipelines(db); err != nil {
		t.Fatal(err)
	}
	return db
}

// Real handlers, transactions and Hub routing run against a disposable DB;
// messages and websocket clients are synthetic and never contact a provider.
func TestChatDeletionRealtimeIntegration(t *testing.T) {
	db := newFunctionalIntegrityIntegrationDB(t, "CLARIN_RUN_CHAT_DELETION_INTEGRATION", "clarin_chat_delete_qa_")
	ctx := context.Background()
	repos := repository.NewRepositories(db)
	account, other := uuid.New(), uuid.New()
	exec := func(t *testing.T, query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(t, `INSERT INTO accounts(id,name) VALUES($1,'Delete QA'),($2,'Other QA')`, account, other)

	hub := ws.NewHub()
	register := func(tenant uuid.UUID, permission string) *ws.Client {
		t.Helper()
		client := &ws.Client{ID: uuid.NewString(), AccountID: tenant, UserID: uuid.New(), Send: make(chan []byte, 16), Permissions: map[string]bool{permission: true}}
		if !hub.RegisterAtAuthorityEpoch(client, hub.AuthorityEpoch(tenant, client.UserID)) {
			t.Fatal("synthetic WS registration failed")
		}
		return client
	}
	authorized := register(account, domain.PermChats)
	withoutChats := register(account, domain.PermContacts)
	foreign := register(other, domain.PermChats)
	defer hub.DisconnectAccountForAuthority(account)
	defer hub.DisconnectAccountForAuthority(other)
	go hub.Run()

	s := &Server{repos: repos, services: service.NewServices(repos, nil, hub), hub: hub}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		permissions := []string{domain.PermChats}
		if c.Get("X-Test-Permission") == "contacts" {
			permissions = []string{domain.PermContacts}
		}
		c.Locals("account_id", account)
		c.Locals("claims", &service.JWTClaims{UserID: authorized.UserID, AccountID: account, Role: "member", Permissions: permissions})
		return c.Next()
	})
	chats := app.Group("/chats", s.requirePermission(domain.PermChats))
	chats.Delete("/batch", s.handleDeleteChatsBatch)
	chats.Delete("/:id", s.handleDeleteChat)
	request := func(t *testing.T, path, body, permission string) int {
		t.Helper()
		req := httptest.NewRequest(http.MethodDelete, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Test-Permission", permission)
		response, err := app.Test(req, 10000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		return response.StatusCode
	}
	create := func(t *testing.T, tenant uuid.UUID) (uuid.UUID, uuid.UUID) {
		t.Helper()
		chat, contact := uuid.New(), uuid.New()
		jid := "qa_" + uuid.NewString() + "@clarin.contact"
		exec(t, `INSERT INTO contacts(id,account_id,jid) VALUES($1,$2,$3)`, contact, tenant, jid)
		exec(t, `INSERT INTO chats(id,account_id,jid,contact_id) VALUES($1,$2,$3,$4)`, chat, tenant, jid, contact)
		exec(t, `INSERT INTO messages(account_id,chat_id,message_id,body,timestamp) VALUES($1,$2,$3,'Synthetic QA',NOW())`, tenant, chat, uuid.NewString())
		return chat, contact
	}
	assertChatCount := func(t *testing.T, id uuid.UUID, want int) {
		t.Helper()
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM chats WHERE id=$1`, id).Scan(&count); err != nil || count != want {
			t.Fatalf("chat count=%d want=%d error=%v", count, want, err)
		}
	}
	assertMessageCount := func(t *testing.T, chatID uuid.UUID, want int) {
		t.Helper()
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM messages WHERE chat_id=$1`, chatID).Scan(&count); err != nil || count != want {
			t.Fatalf("message count=%d want=%d error=%v", count, want, err)
		}
	}
	assertSilent := func(t *testing.T, client *ws.Client) {
		t.Helper()
		select {
		case event := <-client.Send:
			t.Fatalf("unexpected websocket payload: %s", event)
		case <-time.After(50 * time.Millisecond):
		}
	}
	assertEvent := func(t *testing.T, ids []uuid.UUID, all bool) {
		t.Helper()
		select {
		case raw := <-authorized.Send:
			var event struct {
				Event     string                     `json:"event"`
				AccountID string                     `json:"account_id"`
				Data      map[string]json.RawMessage `json:"data"`
			}
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			if event.Event != "chat_deleted" || event.AccountID != account.String() || len(event.Data) != 1 {
				t.Fatalf("deletion event must contain only the scoped deletion contract: %s", raw)
			}
			if all {
				if string(event.Data["all"]) != "true" {
					t.Fatalf("delete-all payload: %s", raw)
				}
			} else {
				var got []uuid.UUID
				if err := json.Unmarshal(event.Data["chat_ids"], &got); err != nil {
					t.Fatal(err)
				}
				if fmt.Sprint(got) != fmt.Sprint(ids) {
					t.Fatalf("deleted IDs=%v want=%v", got, ids)
				}
			}
		case <-time.After(time.Second):
			t.Fatal("authorized websocket did not receive deletion")
		}
		assertSilent(t, withoutChats)
		assertSilent(t, foreign)
	}

	t.Run("individual preserves Contact and notifies only Chats viewers", func(t *testing.T) {
		chat, contact := create(t, account)
		if code := request(t, "/chats/"+chat.String(), "", ""); code != 200 {
			t.Fatalf("DELETE status=%d", code)
		}
		assertChatCount(t, chat, 0)
		assertMessageCount(t, chat, 0)
		var count int
		if err := db.QueryRow(ctx, `SELECT COUNT(*) FROM contacts WHERE id=$1`, contact).Scan(&count); err != nil || count != 1 {
			t.Fatalf("canonical Contact removed: count=%d error=%v", count, err)
		}
		assertEvent(t, []uuid.UUID{chat}, false)
	})
	t.Run("batch deduplicates IDs", func(t *testing.T) {
		first, _ := create(t, account)
		second, _ := create(t, account)
		body := fmt.Sprintf(`{"ids":[%q,%q,%q]}`, first, second, first)
		if code := request(t, "/chats/batch", body, ""); code != 200 {
			t.Fatalf("DELETE batch status=%d", code)
		}
		assertChatCount(t, first, 0)
		assertChatCount(t, second, 0)
		assertMessageCount(t, first, 0)
		assertMessageCount(t, second, 0)
		assertEvent(t, []uuid.UUID{first, second}, false)
	})
	t.Run("mixed-account failure rolls back and never broadcasts", func(t *testing.T) {
		own, _ := create(t, account)
		foreignChat, _ := create(t, other)
		body := fmt.Sprintf(`{"ids":[%q,%q]}`, own, foreignChat)
		if code := request(t, "/chats/batch", body, ""); code != 404 {
			t.Fatalf("foreign batch status=%d", code)
		}
		assertChatCount(t, own, 1)
		assertChatCount(t, foreignChat, 1)
		assertMessageCount(t, own, 1)
		assertMessageCount(t, foreignChat, 1)
		assertSilent(t, authorized)
	})
	t.Run("request permission denies deletion before mutation", func(t *testing.T) {
		chat, _ := create(t, account)
		if code := request(t, "/chats/"+chat.String(), "", "contacts"); code != 403 {
			t.Fatalf("missing permission status=%d", code)
		}
		assertChatCount(t, chat, 1)
		assertMessageCount(t, chat, 1)
		assertSilent(t, authorized)
	})
	t.Run("delete all is tenant scoped and emits all contract", func(t *testing.T) {
		own, _ := create(t, account)
		foreignChat, _ := create(t, other)
		if code := request(t, "/chats/batch", `{"delete_all":true}`, ""); code != 200 {
			t.Fatalf("delete all status=%d", code)
		}
		assertChatCount(t, own, 0)
		assertChatCount(t, foreignChat, 1)
		assertMessageCount(t, own, 0)
		assertMessageCount(t, foreignChat, 1)
		assertEvent(t, nil, true)
	})
}
