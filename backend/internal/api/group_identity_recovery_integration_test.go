package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/internal/whatsapp"
	"github.com/naperu/clarin/pkg/config"
)

// Exercise real HTTP serialization and account-scoped SQL without a WhatsApp
// connection. All identities are synthetic and no outbound route is registered.
func TestIdentityRecoveryHTTPPostgresProjectionAndExport(t *testing.T) {
	ctx := context.Background()
	db := forwardingAPIPool(t)
	raw := db.Config().ConnString()
	repos := repository.NewRepositories(db)
	account, foreign, device, contact := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := db.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic identity HTTP'),($2,'Synthetic foreign HTTP')`, account, foreign)
	defer func() {
		_, _ = db.Exec(ctx, `DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, foreign})
	}()
	exec(`INSERT INTO devices(id,account_id,name,status) VALUES($1,$2,'Synthetic device','connected')`, device, account)
	exec(`INSERT INTO contacts(id,account_id,device_id,jid,phone,name,is_group) VALUES($1,$2,$3,'51900000666@s.whatsapp.net','51900000666','Canonical synthetic name',FALSE)`, contact, account, device)
	group, err := repos.Chat.GetOrCreateGroup(ctx, account, device, "1200666@g.us", "Synthetic group")
	if err != nil {
		t.Fatal(err)
	}
	members := []domain.GroupParticipant{{JID: "70666@lid", LID: "70666@lid", Name: "Nombre no disponible", NameSource: "unavailable", Role: "member"}}
	if err = repos.Chat.SaveGroup(ctx, account, group.ID, &domain.ChatGroup{Subject: "Synthetic group", MembershipStatus: "member", Kind: "group"}, members); err != nil {
		t.Fatal(err)
	}
	at := time.Now().UTC()
	if _, err = repos.Chat.ObserveWhatsAppPeers(ctx, account, device, []domain.WhatsAppPeerObservation{{JID: "70666@lid", PN: "51900000666@s.whatsapp.net", LID: "70666@lid", Source: "user_info", ObservedAt: &at, Fields: map[string]string{"full_name": "Synthetic agenda name", "username": "synthetic.user"}}}); err != nil {
		t.Fatal(err)
	}
	var before int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM contacts WHERE account_id=$1`, account).Scan(&before); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{DatabaseURL: raw, JWTSecret: "synthetic-http-only", WhatsAppGroupChatsEnabled: true}
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
		permissions := []string{domain.PermChats, domain.PermContacts, domain.PermReports}
		if c.Get("X-Test-Only-Reports") == "1" {
			permissions = []string{domain.PermReports}
		}
		if c.Get("X-Test-Only-Contacts") == "1" {
			permissions = []string{domain.PermContacts}
		}
		c.Locals("account_id", active)
		c.Locals("claims", &service.JWTClaims{AccountID: active, Role: domain.RoleAgent, Permissions: permissions})
		return c.Next()
	})
	app.Get("/api/devices/:id/group-identities/recovery", server.handleGetGroupIdentityRecovery)
	app.Get("/api/chats/:id/group/participants", server.requirePermission(domain.PermChats), server.handleGetGroupParticipants)
	app.Get("/api/chats/:id/group/participants/:participantJID", server.requirePermission(domain.PermChats), server.handleGetGroupParticipantProfile)
	app.Post("/api/reports/whatsapp-group-coverage/validate", server.requirePermission(domain.PermReports), server.handleValidateWhatsAppCoverageSnapshot)
	request := func(method, path string, body any, header string, want int) map[string]json.RawMessage {
		t.Helper()
		var data []byte
		if body != nil {
			data, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(data))
		req.Header.Set("Content-Type", "application/json")
		if header != "" {
			req.Header.Set(header, "1")
		}
		response, err := app.Test(req, 20000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]json.RawMessage
		_ = json.NewDecoder(response.Body).Decode(&result)
		if response.StatusCode != want {
			t.Fatalf("%s status=%d want=%d body=%s", path, response.StatusCode, want, data)
		}
		return result
	}
	list := request("GET", "/api/chats/"+group.ID.String()+"/group/participants", nil, "", 200)
	if list["identity_revision"] == nil || list["group_revision"] == nil {
		t.Fatal("real HTTP response omitted revisions")
	}
	var projected []domain.GroupParticipant
	if err = json.Unmarshal(list["participants"], &projected); err != nil || len(projected) != 1 {
		t.Fatal(err)
	}
	if projected[0].Name != "Canonical synthetic name" || projected[0].Phone != "51900000666" || projected[0].Username != "synthetic.user" {
		t.Fatalf("identity projection did not resolve: %+v", projected)
	}
	profileJSON := request("GET", "/api/chats/"+group.ID.String()+"/group/participants/70666%40lid", nil, "", 200)
	var profile domain.GroupParticipantProfile
	if err = json.Unmarshal(profileJSON["profile"], &profile); err != nil {
		t.Fatal(err)
	}
	if profile.ContactContext == nil || profile.ContactContext.ContactID != contact {
		t.Fatal("canonical Contact context was not reused")
	}
	// This test has no connected WhatsApp client. The resolved destination must
	// remain visible while its action honestly reflects the runtime connection.
	if profile.Capabilities.CanMessage || profile.Capabilities.MessageDisabledReason != "El dispositivo de este grupo no está conectado" {
		t.Fatal("synthetic disconnected device advertised a send capability")
	}
	var after int
	_ = db.QueryRow(ctx, `SELECT count(*) FROM contacts WHERE account_id=$1`, account).Scan(&after)
	if before != after {
		t.Fatal("reading member created Contact records")
	}
	request("GET", "/api/devices/"+device.String()+"/group-identities/recovery", nil, "X-Test-Only-Reports", 200)
	request("GET", "/api/devices/"+device.String()+"/group-identities/recovery", nil, "X-Test-Only-Contacts", 403)
	request("GET", "/api/devices/"+device.String()+"/group-identities/recovery", nil, "X-Test-Foreign", 404)
	request("GET", "/api/chats/"+group.ID.String()+"/group/participants", nil, "X-Test-Foreign", 404)
	identity, groupVersion, err := repos.Chat.SnapshotVersionByGroupJID(ctx, account, device, group.JID)
	if err != nil {
		t.Fatal(err)
	}
	crm, err := repos.Chat.CRMRevision(ctx, account)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := repos.Account.GetLeadPolicy(ctx, account)
	if err != nil {
		t.Fatal(err)
	}
	check := map[string]any{"device_id": device, "group_id": group.JID, "identity_revision": identity, "group_revision": groupVersion, "crm_identity_revision": crm, "leads_policy_version": policy.Version, "leads_enabled": policy.LeadsEnabled}
	request("POST", "/api/reports/whatsapp-group-coverage/validate", check, "", 200)
	request("POST", "/api/reports/whatsapp-group-coverage/validate", check, "X-Test-Foreign", 404)
	exec(`UPDATE contacts SET name='Changed canonical synthetic' WHERE account_id=$1 AND id=$2`, account, contact)
	conflict := request("POST", "/api/reports/whatsapp-group-coverage/validate", check, "", 409)
	var code string
	_ = json.Unmarshal(conflict["code"], &code)
	if code != "report_snapshot_changed" {
		t.Fatal("stale export cause lost")
	}
}
