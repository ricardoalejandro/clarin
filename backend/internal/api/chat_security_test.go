package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/pkg/config"
)

func TestAccountOwnershipPredicates(t *testing.T) {
	accountID := uuid.New()
	otherAccountID := uuid.New()
	chatID := uuid.New()

	if chatBelongsToAccount(nil, accountID) {
		t.Fatal("nil chat must not belong to an account")
	}
	if chatBelongsToAccount(&domain.Chat{AccountID: otherAccountID}, accountID) {
		t.Fatal("cross-account chat must be rejected")
	}
	if !chatBelongsToAccount(&domain.Chat{AccountID: accountID}, accountID) {
		t.Fatal("same-account chat must be accepted")
	}

	if deviceBelongsToAccount(nil, accountID) {
		t.Fatal("nil device must not belong to an account")
	}
	if deviceBelongsToAccount(&domain.Device{AccountID: otherAccountID}, accountID) {
		t.Fatal("cross-account device must be rejected")
	}
	if !deviceBelongsToAccount(&domain.Device{AccountID: accountID}, accountID) {
		t.Fatal("same-account device must be accepted")
	}

	if messageBelongsToChatAccount(nil, chatID, accountID) {
		t.Fatal("nil message must be rejected")
	}
	if messageBelongsToChatAccount(&domain.Message{ChatID: chatID, AccountID: otherAccountID}, chatID, accountID) {
		t.Fatal("cross-account message must be rejected")
	}
	if messageBelongsToChatAccount(&domain.Message{ChatID: uuid.New(), AccountID: accountID}, chatID, accountID) {
		t.Fatal("message from another chat must be rejected")
	}
	if !messageBelongsToChatAccount(&domain.Message{ChatID: chatID, AccountID: accountID}, chatID, accountID) {
		t.Fatal("same-account message from the source chat must be accepted")
	}
}

func TestValidWhatsAppCloudSignature(t *testing.T) {
	const secret = "test-app-secret"
	payload := []byte(`{"object":"whatsapp_business_account","entry":[]}`)
	validHeader := testWhatsAppCloudSignature(secret, payload)

	if !validWhatsAppCloudSignature(secret, validHeader, payload) {
		t.Fatal("valid signature was rejected")
	}
	for name, header := range map[string]string{
		"missing":        "",
		"wrong prefix":   "sha1=" + strings.TrimPrefix(validHeader, "sha256="),
		"invalid hex":    "sha256=not-hex",
		"wrong digest":   "sha256=" + strings.Repeat("00", sha256.Size),
		"extra material": validHeader + "00",
	} {
		t.Run(name, func(t *testing.T) {
			if validWhatsAppCloudSignature(secret, header, payload) {
				t.Fatalf("invalid signature %q was accepted", name)
			}
		})
	}
	if validWhatsAppCloudSignature(secret, validHeader, append(payload, ' ')) {
		t.Fatal("signature must cover the exact raw request body")
	}
}

func TestWhatsAppCloudWebhookAuthenticationBoundary(t *testing.T) {
	const secret = "test-app-secret"
	validPayload := []byte(`{"object":"whatsapp_business_account","entry":[]}`)

	tests := []struct {
		name      string
		secret    string
		body      []byte
		signature string
		wantCode  int
	}{
		{
			name:     "missing app secret fails closed",
			body:     validPayload,
			wantCode: fiber.StatusServiceUnavailable,
		},
		{
			name:      "invalid signature is rejected before repositories",
			secret:    secret,
			body:      validPayload,
			signature: "sha256=" + strings.Repeat("00", sha256.Size),
			wantCode:  fiber.StatusUnauthorized,
		},
		{
			name:      "signed malformed JSON is rejected",
			secret:    secret,
			body:      []byte(`{"object":`),
			signature: testWhatsAppCloudSignature(secret, []byte(`{"object":`)),
			wantCode:  fiber.StatusBadRequest,
		},
		{
			name:      "signed unexpected object is rejected",
			secret:    secret,
			body:      []byte(`{"object":"other","entry":[]}`),
			signature: testWhatsAppCloudSignature(secret, []byte(`{"object":"other","entry":[]}`)),
			wantCode:  fiber.StatusBadRequest,
		},
		{
			name:      "valid signed empty batch is accepted",
			secret:    secret,
			body:      validPayload,
			signature: testWhatsAppCloudSignature(secret, validPayload),
			wantCode:  fiber.StatusOK,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := &Server{cfg: &config.Config{WhatsAppCloudAppSecret: tt.secret}}
			app := fiber.New()
			app.Post("/webhook", server.handleWhatsAppCloudWebhook)

			req := httptest.NewRequest("POST", "/webhook", strings.NewReader(string(tt.body)))
			req.Header.Set("Content-Type", "application/json")
			if tt.signature != "" {
				req.Header.Set("X-Hub-Signature-256", tt.signature)
			}
			resp, err := app.Test(req)
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer resp.Body.Close()
			_, _ = io.Copy(io.Discard, resp.Body)
			if resp.StatusCode != tt.wantCode {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tt.wantCode)
			}
		})
	}
}

func TestCloudWebhookEventIDsAreStable(t *testing.T) {
	payload := []byte(`{"messaging_product":"whatsapp"}`)
	first := cloudChangeEventID("entry", "phone", "messages", payload)
	second := cloudChangeEventID("entry", "phone", "messages", payload)
	if first != second {
		t.Fatalf("change event IDs are not stable: %q != %q", first, second)
	}
	if first == cloudChangeEventID("entry", "phone", "messages", append(payload, ' ')) {
		t.Fatal("different change payloads must not share a fallback event ID")
	}

	message := cloudWebhookMessage{ID: "wamid.123", From: "51999999999", Timestamp: "1", Type: "text"}
	if got := cloudMessageEventID("phone", message); got != message.ID {
		t.Fatalf("provider message ID changed: %q", got)
	}
	message.ID = ""
	if cloudMessageEventID("phone", message) != cloudMessageEventID("phone", message) {
		t.Fatal("message fallback event ID is not stable")
	}

	status := cloudWebhookStatus{ID: "wamid.123", Status: "delivered"}
	if got := cloudStatusEventID("phone", status); got != "wamid.123:delivered" {
		t.Fatalf("historical status event ID format changed: %q", got)
	}
}

func testWhatsAppCloudSignature(secret string, payload []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payload)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}
