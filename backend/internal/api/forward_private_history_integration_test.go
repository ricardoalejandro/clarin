package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

// Exercise the real HTTP handler and durable reservation against PostgreSQL;
// only the external WhatsApp transport is synthetic, so this sends no messages.
func TestForwardPrivateHistoricalCopyHTTPIntegrity(t *testing.T) {
	pool := forwardingAPIPool(t)
	ctx := context.Background()
	repos := repository.NewRepositories(pool)
	account, foreign, user := uuid.New(), uuid.New(), uuid.New()
	currentDevice, retiredDevice, otherDevice := uuid.New(), uuid.New(), uuid.New()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO accounts(id,name) VALUES($1,'Synthetic private history'),($2,'Synthetic foreign history')`, account, foreign)
	t.Cleanup(func() { exec(`DELETE FROM accounts WHERE id=ANY($1::uuid[])`, []uuid.UUID{account, foreign}) })
	exec(`INSERT INTO users(id,account_id,username,email,password_hash,display_name) VALUES($1,$2,$3,$4,'test-only','Synthetic operator')`, user, account, "private-copy-"+user.String(), user.String()+"@test.invalid")
	exec(`INSERT INTO devices(id,account_id,name,status,provider) VALUES($1,$4,'Synthetic current','connected','whatsapp_web'),($2,$4,'Synthetic retired','disconnected','whatsapp_web'),($3,$4,'Synthetic other','connected','whatsapp_web')`, currentDevice, retiredDevice, otherDevice, account)
	makeChat := func(phone string) *domain.Chat {
		t.Helper()
		chat, err := repos.Chat.GetOrCreate(ctx, account, currentDevice, phone+"@s.whatsapp.net", "Synthetic private")
		if err != nil {
			t.Fatal(err)
		}
		return chat
	}
	sourceChat, destination, anotherChat := makeChat("51900001111"), makeChat("51900002222"), makeChat("51900003333")
	fake := &forwardingFakeTransport{repos: repos, account: account, device: currentDevice, failures: map[string]bool{}}
	server := &Server{repos: repos, services: service.NewServices(repos, nil, nil), forwardTransport: fake}
	nativeEnabled := false
	server.forwardCapabilityCheck = func(uuid.UUID) bool { return nativeEnabled }
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
	actorAccount := account
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account_id", actorAccount)
		c.Locals("user_id", user)
		return c.Next()
	})
	app.Post("/batch", server.handleForwardBatch)
	send := func(request forwardBatchRequest) (int, map[string]any) {
		t.Helper()
		raw, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest("POST", "/batch", strings.NewReader(string(raw)))
		req.Header.Set("Content-Type", "application/json")
		response, err := app.Test(req, 30000)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result map[string]any
		if err = json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, result
	}
	assertNotReserved := func(id uuid.UUID) {
		t.Helper()
		var count int
		if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM message_forward_operations WHERE account_id=$1 AND id=$2`, account, id).Scan(&count); err != nil || count != 0 {
			t.Fatalf("rejected source created reservation: count=%d err=%v", count, err)
		}
	}
	for _, item := range []struct {
		name   string
		device *uuid.UUID
	}{{"null source device", nil}, {"retired source device", &retiredDevice}} {
		t.Run(item.name, func(t *testing.T) {
			body, kind, status, mediaURL := "Synthetic historic video", "video", "sent", "https://test.invalid/synthetic-private.mp4"
			source := &domain.Message{AccountID: account, ChatID: sourceChat.ID, DeviceID: item.device, MessageID: uuid.NewString(), Body: &body, MessageType: &kind, MediaURL: &mediaURL, Status: &status, Timestamp: time.Now().UTC(), IsFromMe: true, Forwarding: domain.MessageForwarding{State: domain.ForwardingNotForwarded}}
			if err := repos.Message.Create(ctx, source); err != nil {
				t.Fatal(err)
			}
			before, err := repos.Message.GetByReference(ctx, account, sourceChat.ID, source.ID.String())
			if err != nil {
				t.Fatal(err)
			}
			fingerprint := domain.MessageForwardFingerprint(before)
			request := forwardBatchRequest{Mode: domain.MessageSharingCopy, SourceChatID: sourceChat.ID, SourceMessageID: source.ID, DeviceID: currentDevice, DestinationChatIDs: []uuid.UUID{destination.ID}, ClientOperationID: uuid.New()}
			callsBefore := fake.calls
			code, result := send(request)
			if code != 200 || result["success"] != true || result["mode"] != domain.MessageSharingCopy || fake.calls != callsBefore+1 {
				t.Fatalf("historical copy rejected: status=%d code=%v calls=%d", code, result["code"], fake.calls-callsBefore)
			}
			results, ok := result["results"].([]any)
			if !ok || len(results) != 1 || results[0].(map[string]any)["state"] != "sent" {
				t.Fatal("historical copy did not confirm exactly one destination")
			}
			operation, err := repos.Message.GetForwardOperation(ctx, account, user, request.ClientOperationID)
			if err != nil || operation.DeviceID != currentDevice || operation.SourceChatID != sourceChat.ID || operation.SourceMessageID != source.ID || operation.SourceFingerprint != fingerprint {
				t.Fatalf("reservation did not preserve source identity: %v", err)
			}
			if code, _ = send(request); code != 200 || fake.calls != callsBefore+1 {
				t.Fatal("same historical copy operation was sent twice")
			}
			after, err := repos.Message.GetByReference(ctx, account, sourceChat.ID, source.ID.String())
			if err != nil || after.ChatID != before.ChatID || domain.MessageForwardFingerprint(after) != fingerprint || (after.DeviceID == nil) != (before.DeviceID == nil) || (after.DeviceID != nil && *after.DeviceID != *before.DeviceID) {
				t.Fatalf("copy rewrote immutable source: %v", err)
			}
			nativeEnabled = true
			strict := request
			strict.Mode, strict.ClientOperationID = domain.MessageSharingNative, uuid.New()
			if code, result = send(strict); code != 409 || result["code"] != "forward_source_changed" || fake.calls != callsBefore+1 {
				t.Fatalf("native reused historical source-device exception: status=%d code=%v", code, result["code"])
			}
			assertNotReserved(strict.ClientOperationID)
			nativeEnabled = false
			for _, invalid := range []struct {
				name           string
				request        forwardBatchRequest
				foreignAccount bool
			}{
				{name: "another physical source chat", request: forwardBatchRequest{Mode: domain.MessageSharingCopy, SourceChatID: anotherChat.ID, SourceMessageID: source.ID, DeviceID: currentDevice, DestinationChatIDs: []uuid.UUID{destination.ID}, ClientOperationID: uuid.New()}},
				{name: "another current device", request: forwardBatchRequest{Mode: domain.MessageSharingCopy, SourceChatID: sourceChat.ID, SourceMessageID: source.ID, DeviceID: otherDevice, DestinationChatIDs: []uuid.UUID{destination.ID}, ClientOperationID: uuid.New()}},
				{name: "another account", request: forwardBatchRequest{Mode: domain.MessageSharingCopy, SourceChatID: sourceChat.ID, SourceMessageID: source.ID, DeviceID: currentDevice, DestinationChatIDs: []uuid.UUID{destination.ID}, ClientOperationID: uuid.New()}, foreignAccount: true},
			} {
				t.Run(invalid.name, func(t *testing.T) {
					if invalid.foreignAccount {
						actorAccount = foreign
					}
					code, _ := send(invalid.request)
					actorAccount = account
					if code != 404 || fake.calls != callsBefore+1 {
						t.Fatalf("invalid private copy reached transport: status=%d calls=%d", code, fake.calls-callsBefore)
					}
					assertNotReserved(invalid.request.ClientOperationID)
				})
			}
		})
	}
}
