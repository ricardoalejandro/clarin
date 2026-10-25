package api

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/database"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

var forwardingAPIMigrationOnce sync.Once
var forwardingAPIMigrationError error

func forwardingAPIPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	raw := os.Getenv("INTEGRITY_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("INTEGRITY_TEST_DATABASE_URL requires isolated PostgreSQL")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Path != "/program_survey_integrity_test" {
		t.Fatal("requires exact disposable program_survey_integrity_test database")
	}
	pool, err := pgxpool.New(context.Background(), raw)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	forwardingAPIMigrationOnce.Do(func() { forwardingAPIMigrationError = database.Migrate(pool) })
	if forwardingAPIMigrationError != nil {
		t.Fatal(forwardingAPIMigrationError)
	}
	return pool
}

type forwardingFakeTransport struct {
	repos           *repository.Repositories
	account, device uuid.UUID
	mu              sync.Mutex
	calls           int
	failures        map[string]bool
}

func (f *forwardingFakeTransport) NewWhatsAppMessageID(uuid.UUID) (string, error) {
	return "QA" + strings.ReplaceAll(uuid.NewString(), "-", ""), nil
}
func (f *forwardingFakeTransport) ForwardMessageWithID(ctx context.Context, device uuid.UUID, to string, source *domain.Message, id string) (*domain.Message, error) {
	f.mu.Lock()
	f.calls++
	unknown, failed := f.failures[to]
	f.mu.Unlock()
	if failed {
		return nil, &domain.ForwardSendError{Code: "synthetic_failure", OutcomeUnknown: unknown, Err: errors.New("synthetic transport result")}
	}
	chat, err := f.repos.Chat.FindByDeviceJID(ctx, f.account, device, to)
	if err != nil || chat == nil {
		return nil, errors.New("synthetic missing target")
	}
	next, err := domain.NextForwarding(*source)
	if err != nil {
		return nil, err
	}
	status := "sent"
	message := &domain.Message{AccountID: f.account, ChatID: chat.ID, DeviceID: &device, MessageID: id, Body: source.Body, MessageType: source.MessageType, IsFromMe: true, Status: &status, Timestamp: time.Now().UTC(), Forwarding: next, ForwardingSource: "clarin"}
	if err = f.repos.Message.Create(ctx, message); err != nil {
		return nil, err
	}
	return message, nil
}
func TestForwardBatchHTTPIntegrity(t *testing.T) {
	pool := forwardingAPIPool(t)
	ctx := context.Background()
	repos := repository.NewRepositories(pool)
	account, foreign, user, device := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic forward API'),($2,'Synthetic other')`, account, foreign)
	originalAccount := account
	t.Cleanup(func() { exec(`DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{originalAccount, foreign}) })
	exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name) VALUES($1,$2,$3,$4,'test-only','Synthetic operator')`, user, account, "fwd-"+user.String(), user.String()+"@test.invalid")
	exec(`INSERT INTO devices(id,account_id,name,status,provider) VALUES($1,$2,'Synthetic forwarding','connected','whatsapp_web')`, device, account)
	chats := make([]*domain.Chat, 3)
	for i, phone := range []string{"51900000111", "51900000222", "51900000333"} {
		chat, err := repos.Chat.GetOrCreate(ctx, account, device, phone+"@s.whatsapp.net", "Synthetic")
		if err != nil {
			t.Fatal(err)
		}
		chats[i] = chat
	}
	body, kind, status := "QA synthetic forward", "text", "received"
	source := &domain.Message{AccountID: account, ChatID: chats[0].ID, DeviceID: &device, MessageID: uuid.NewString(), Body: &body, MessageType: &kind, Status: &status, Timestamp: time.Now().UTC(), Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}}
	if err := repos.Message.Create(ctx, source); err != nil {
		t.Fatal(err)
	}
	fake := &forwardingFakeTransport{repos: repos, account: account, device: device, failures: map[string]bool{}}
	server := &Server{repos: repos, services: service.NewServices(repos, nil, nil), forwardTransport: fake}
	enabled := false
	server.forwardCapabilityCheck = func(uuid.UUID) bool { return enabled }
	server.forwardDeviceCheck = func(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.Device, error) {
		candidate, err := repos.Device.GetByID(ctx, deviceID)
		if err != nil {
			return nil, err
		}
		if candidate == nil || candidate.AccountID != accountID {
			return nil, fiber.ErrNotFound
		}
		if !deviceCanSendManual(candidate) {
			return nil, fiber.ErrConflict
		}
		return candidate, nil
	}

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error { c.Locals("account_id", account); c.Locals("user_id", user); return c.Next() })
	app.Post("/batch", server.handleForwardBatch)
	app.Post("/legacy", server.handleForwardMessage)
	app.Get("/batch/:id", server.handleGetForwardBatch)
	// A stale client without an idempotency key must fail before looking up
	// content or calling a provider, rather than manufacturing another send key.
	legacyRaw, _ := json.Marshal(map[string]any{"device_id": device, "to": chats[1].JID, "chat_id": chats[0].ID, "message_id": source.MessageID})
	legacyRequest := httptest.NewRequest("POST", "/legacy", strings.NewReader(string(legacyRaw)))
	legacyRequest.Header.Set("Content-Type", "application/json")
	legacyResponse, legacyErr := app.Test(legacyRequest, 30000)
	if legacyErr != nil || legacyResponse.StatusCode != 409 || fake.calls != 0 {
		t.Fatal("legacy forwarding without a key was accepted", legacyErr)
	}
	var legacyResult map[string]any
	if err := json.NewDecoder(legacyResponse.Body).Decode(&legacyResult); err != nil || legacyResult["code"] != "forward_batch_required" {
		t.Fatal("missing-key upgrade response absent", err)
	}
	legacyResponse.Body.Close()
	request := forwardBatchRequest{SourceChatID: chats[0].ID, SourceMessageID: source.ID, DeviceID: device, DestinationChatIDs: []uuid.UUID{chats[1].ID}, ClientOperationID: uuid.New()}
	send := func(req forwardBatchRequest) (int, map[string]any) {
		t.Helper()
		raw, _ := json.Marshal(req)
		r := httptest.NewRequest("POST", "/batch", strings.NewReader(string(raw)))
		r.Header.Set("Content-Type", "application/json")
		response, err := app.Test(r, 30000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		payload, _ := io.ReadAll(response.Body)
		var data map[string]any
		if err = json.Unmarshal(payload, &data); err != nil {
			t.Fatalf("decode response: %s", payload)
		}
		return response.StatusCode, data
	}
	code, receipt := send(request)
	if code != 503 || receipt["code"] != "forward_capability_unverified" || fake.calls != 0 {
		t.Fatalf("unverified capability sent: %d %+v", code, receipt)
	}
	enabled = true
	code, receipt = send(request)
	if code != 200 || receipt["success"] != true || fake.calls != 1 {
		t.Fatalf("initial result %d %+v calls=%d", code, receipt, fake.calls)
	}
	enabled = false
	code, _ = send(request)
	if code != 200 || fake.calls != 1 {
		t.Fatal("lost-response replay unavailable or called transport while capability disabled")
	}
	statusResponse, statusErr := app.Test(httptest.NewRequest("GET", "/batch/"+request.ClientOperationID.String(), nil))
	if statusErr != nil || statusResponse.StatusCode != 200 {
		t.Fatal("disabled capability hid prior receipt", statusErr)
	}
	statusResponse.Body.Close()
	newRequest := request
	newRequest.ClientOperationID = uuid.New()
	code, receipt = send(newRequest)
	if code != 503 || receipt["code"] != "forward_capability_unverified" || fake.calls != 1 {
		t.Fatal("disabled capability prepared a new send")
	}
	enabled = true
	request.DestinationChatIDs = []uuid.UUID{chats[2].ID}
	code, receipt = send(request)
	if code != 409 || receipt["code"] != "forward_operation_conflict" || fake.calls != 1 {
		t.Fatal("changed operation accepted", code, receipt)
	}
	// Reject an entire batch before any recipient is sent.
	request.ClientOperationID = uuid.New()
	request.DestinationChatIDs = []uuid.UUID{chats[1].ID, uuid.New()}
	code, _ = send(request)
	if code != 404 || fake.calls != 1 {
		t.Fatal("partial send during prevalidation")
	}
	request.ClientOperationID = uuid.New()
	request.DestinationChatIDs = []uuid.UUID{chats[1].ID, chats[2].ID}
	fake.failures[chats[2].JID] = true
	code, receipt = send(request)
	if code != 200 || fake.calls != 3 {
		t.Fatalf("partial receipt %d %+v", code, receipt)
	}
	results := receipt["results"].([]any)
	uncertain := 0
	sent := 0
	for _, item := range results {
		row := item.(map[string]any)
		if row["state"] == "uncertain" {
			uncertain++
			if row["can_retry"] != false {
				t.Fatal("unsafe retry offered")
			}
		}
		if row["state"] == "sent" {
			sent++
		}
	}
	if sent != 1 || uncertain != 1 {
		t.Fatal("partial outcomes not represented", receipt)
	}
	code, _ = send(request)
	if code != 200 || fake.calls != 3 {
		t.Fatal("uncertain replay resent messages")
	}
	response, err := app.Test(httptest.NewRequest("GET", "/batch/"+request.ClientOperationID.String(), nil))
	if err != nil || response.StatusCode != 200 {
		t.Fatal("receipt status unavailable", err)
	}
	response.Body.Close()
	// Change the exact destination after the operation/target snapshot is
	// inserted but before the first fresh preflight. A same-UUID retry must
	// never silently address the replacement JID selected by this race.
	changingTarget, createErr := repos.Chat.GetOrCreate(ctx, originalAccount, device, "51900000444@s.whatsapp.net", "Synthetic changing target")
	if createErr != nil {
		t.Fatal(createErr)
	}
	triggerName := "qa_forward_destination_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	exec(`CREATE FUNCTION ` + triggerName + `() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.account_id='` + originalAccount.String() + `'::uuid AND NEW.chat_id='` + changingTarget.ID.String() + `'::uuid THEN
       UPDATE chats SET jid='51900000555@s.whatsapp.net' WHERE account_id=NEW.account_id AND id=NEW.chat_id;
      END IF;RETURN NEW;END $$`)
	exec(`CREATE TRIGGER ` + triggerName + ` AFTER INSERT ON message_forward_targets FOR EACH ROW EXECUTE FUNCTION ` + triggerName + `()`)
	dropRaceTrigger := func() {
		exec(`DROP TRIGGER IF EXISTS ` + triggerName + ` ON message_forward_targets`)
		exec(`DROP FUNCTION IF EXISTS ` + triggerName + `() `)
	}
	t.Cleanup(dropRaceTrigger)
	request.ClientOperationID = uuid.New()
	request.DestinationChatIDs = []uuid.UUID{changingTarget.ID}
	callsBeforeRace := fake.calls
	code, receipt = send(request)
	if code != 200 || fake.calls != callsBeforeRace {
		t.Fatal("changed recipient reached transport", code, receipt)
	}
	raceResults := receipt["results"].([]any)
	if len(raceResults) != 1 {
		t.Fatal("missing changed destination receipt")
	}
	raceResult := raceResults[0].(map[string]any)
	if raceResult["state"] != "failed" || raceResult["code"] != "forward_destination_changed" || raceResult["can_retry"] != false {
		t.Fatal("changed destination offered blind retry", raceResult)
	}
	code, _ = send(request)
	if code != 200 || fake.calls != callsBeforeRace {
		t.Fatal("changed recipient replay reached transport")
	}
	dropRaceTrigger()
	// Another account cannot observe an operation even with the same actor UUID.
	account = foreign
	response, err = app.Test(httptest.NewRequest("GET", "/batch/"+request.ClientOperationID.String(), nil))
	if err != nil || response.StatusCode != 404 {
		t.Fatal("foreign receipt visible", err)
	}
	response.Body.Close()
}
