package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/pkg/config"
)

// Exercise the actual paginated HTTP contract using synthetic PostgreSQL data.
// No WhatsApp client is connected and no outbound route is registered.
func TestGroupParticipantsAdminFirstHTTPPostgres(t *testing.T) {
	ctx := context.Background()
	db := forwardingAPIPool(t)
	repos := repository.NewRepositories(db)
	account, foreign, device, otherDevice := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic order HTTP'),($2,'Synthetic foreign order HTTP')`, account, foreign)
	t.Cleanup(func() {
		_, _ = db.Exec(ctx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, foreign})
	})
	exec(`INSERT INTO devices(id,account_id,name) VALUES($1,$3,'First order device'),($2,$3,'Second order device')`, device, otherDevice, account)
	chat, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "1200772@g.us", "Order HTTP")
	if err != nil {
		t.Fatal(err)
	}
	other, err := repos.Chat.GetOrCreateGroup(ctx, account, otherDevice, chat.JID, "Other order HTTP")
	if err != nil {
		t.Fatal(err)
	}
	metadata := &domain.ChatGroup{Subject: "Order HTTP", MembershipStatus: "member", Kind: "group"}
	members := make([]domain.GroupParticipant, 70)
	for i := range members {
		members[i] = domain.GroupParticipant{JID: fmt.Sprintf("519100%05d@s.whatsapp.net", i), Name: fmt.Sprintf("Synthetic %03d", i), NameSource: "full_name", Role: "member"}
	}
	members[68].Role, members[69].Role = "super_admin", "admin"
	for _, i := range []int{1, 68, 69} {
		members[i].Name = "Needle " + members[i].Name
	}
	for _, id := range []uuid.UUID{chat.ID, other.ID} {
		if err = repos.Chat.SaveGroup(ctx, account, id, metadata, members); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{DatabaseURL: db.Config().ConnString(), JWTSecret: "synthetic-order-only", WhatsAppGroupChatsEnabled: true}
	pool, err := whatsapp.NewDevicePool(cfg, repos, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &Server{cfg: cfg, repos: repos, pool: pool, services: service.NewServices(repos, pool, nil)}
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		active := account
		if c.Get("X-Test-Foreign") == "1" {
			active = foreign
		}
		c.Locals("account_id", active)
		c.Locals("claims", &service.JWTClaims{AccountID: active, Role: domain.RoleAgent, Permissions: []string{domain.PermChats}})
		return c.Next()
	})
	app.Get("/api/chats/:id/group/participants", server.requirePermission(domain.PermChats), server.handleGetGroupParticipants)
	type body struct {
		Success          bool                      `json:"success"`
		Order            *string                   `json:"order"`
		Code             string                    `json:"code"`
		Participants     []domain.GroupParticipant `json:"participants"`
		NextCursor       string                    `json:"next_cursor"`
		GroupRevision    int64                     `json:"group_revision"`
		IdentityRevision int64                     `json:"identity_revision"`
	}
	get := func(chatID uuid.UUID, query url.Values, foreignAccount bool, wantStatus int) body {
		t.Helper()
		req := httptest.NewRequest("GET", "/api/chats/"+chatID.String()+"/group/participants?"+query.Encode(), nil)
		if foreignAccount {
			req.Header.Set("X-Test-Foreign", "1")
		}
		response, err := app.Test(req, 20000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != wantStatus {
			t.Fatalf("order response status=%d want=%d", response.StatusCode, wantStatus)
		}
		if wantStatus == 404 {
			return body{}
		}
		var result body
		if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if wantStatus == 200 && !result.Success {
			t.Fatal("participant read did not succeed")
		}
		return result
	}
	legacy := get(chat.ID, url.Values{}, false, 200)
	if legacy.Order != nil || len(legacy.Participants) != 50 || legacy.Participants[0].JID != members[0].JID || legacy.NextCursor != members[49].JID {
		t.Fatal("legacy HTTP pagination changed")
	}
	query := url.Values{"order": {repository.GroupParticipantsOrderAdminsFirst}}
	first := get(chat.ID, query, false, 200)
	if first.Order == nil || *first.Order != repository.GroupParticipantsOrderAdminsFirst || len(first.Participants) != 50 || first.NextCursor == "" || first.NextCursor == legacy.NextCursor || first.GroupRevision < 1 {
		t.Fatal("new HTTP ordering contract omitted its mode, revision or cursor")
	}
	if first.Participants[0].JID != members[68].JID || first.Participants[1].JID != members[69].JID || first.Participants[2].JID != members[0].JID {
		t.Fatal("admins after the former first page were not promoted ahead of all members")
	}
	query.Set("cursor", first.NextCursor)
	second := get(chat.ID, query, false, 200)
	if len(second.Participants) != 20 || second.NextCursor != "" || second.Participants[0].JID != members[48].JID || second.Participants[19].JID != members[67].JID {
		t.Fatal("second page lost participants at the admin/member boundary")
	}
	search := url.Values{"order": {repository.GroupParticipantsOrderAdminsFirst}, "search": {"Needle"}, "limit": {"1"}}
	for _, index := range []int{68, 69, 1} {
		result := get(chat.ID, search, false, 200)
		if len(result.Participants) != 1 || result.Participants[0].JID != members[index].JID {
			t.Fatal("resolved name search did not retain admin-first page order")
		}
		search.Set("cursor", result.NextCursor)
	}
	if search.Get("cursor") != "" {
		t.Fatal("search pagination did not finish")
	}
	for _, stale := range []url.Values{
		{"order": {repository.GroupParticipantsOrderAdminsFirst}, "cursor": {legacy.NextCursor}},
		{"order": {repository.GroupParticipantsOrderAdminsFirst}, "cursor": {"gp1.invalid"}},
		{"order": {repository.GroupParticipantsOrderAdminsFirst}, "cursor": {first.NextCursor}, "search": {"different"}},
	} {
		if result := get(chat.ID, stale, false, 409); result.Code != "participants_cursor_reset" {
			t.Fatal("new cursor reset lost its actionable error code")
		}
	}
	if result := get(other.ID, query, false, 409); result.Code != "participants_cursor_reset" {
		t.Fatal("cursor crossed devices through a different chat")
	}
	get(chat.ID, query, true, 404)
	if result := get(chat.ID, url.Values{"order": {"unknown"}}, false, 400); result.Code != "participants_order_invalid" {
		t.Fatal("unknown ordering mode accepted")
	}
	members[0].Role, members[68].Role = "admin", "member"
	if err = repos.Chat.SaveGroup(ctx, account, chat.ID, metadata, members); err != nil {
		t.Fatal(err)
	}
	if result := get(chat.ID, query, false, 409); result.Code != "participants_cursor_reset" {
		t.Fatal("role change did not reset the old ordered cursor")
	}
	fresh := get(chat.ID, url.Values{"order": {repository.GroupParticipantsOrderAdminsFirst}}, false, 200)
	if fresh.GroupRevision <= first.GroupRevision || fresh.Participants[0].JID != members[0].JID {
		t.Fatal("fresh role order or revision was not reconciled")
	}
	oldContinuation := get(chat.ID, url.Values{"cursor": {legacy.NextCursor}}, false, 200)
	if oldContinuation.Order != nil || len(oldContinuation.Participants) != 20 || oldContinuation.Participants[0].JID != members[50].JID || oldContinuation.Code != "" {
		t.Fatal("old frontend encountered the new cursor/reset contract")
	}
}
