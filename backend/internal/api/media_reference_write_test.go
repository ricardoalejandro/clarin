package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func TestMediaReferenceWritersDenyUnreadableInputBeforeMutation(t *testing.T) {
	accountID := uuid.New()
	key := accountID.String() + "/chats/known-unreadable.pdf"
	server := &Server{} // No repository: an unsafe input must stop before any write.
	for _, tc := range []struct {
		name    string
		handler fiber.Handler
		body    any
	}{
		{"campaign direct", server.handleCreateCampaign, map[string]any{"name": "Example", "device_id": uuid.NewString(), "message_template": "text", "media_url": mediaProxyURLFromObjectKey(key)}},
		{"campaign attachment", server.handleCreateCampaign, map[string]any{"name": "Example", "device_id": uuid.NewString(), "attachments": []any{map[string]any{"media_url": mediaProxyURLFromObjectKey(key)}}}},
		{"campaign settings graft", server.handleCreateCampaign, map[string]any{"settings": map[string]any{"nested": []string{key}}}},
		{"document canvas", server.handleCreateDocumentTemplate, map[string]any{"name": "Example", "canvas_json": map[string]any{"objects": []any{map[string]any{"src": mediaProxyURLFromObjectKey(key)}}}}},
		{"document import raw key", server.handleImportDocumentTemplate, map[string]any{"name": "Example", "canvas_json": map[string]any{"objects": []any{map[string]any{"src": key}}}}},
		{"quick reply attachment", server.handleCreateQuickReply, map[string]any{"shortcut": "hello", "attachments": []any{map[string]any{"media_url": mediaProxyURLFromObjectKey(key), "media_asset_id": uuid.NewString()}}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Post("/", func(c *fiber.Ctx) error {
				c.Locals("account_id", accountID)
				c.Locals("user_id", uuid.New())
				c.Locals("claims", &service.JWTClaims{AccountID: accountID, UserID: uuid.New(), Role: "member", Permissions: []string{domain.PermBroadcasts, domain.PermDocuments}})
				return tc.handler(c)
			})
			encoded, _ := json.Marshal(tc.body)
			req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(encoded))
			req.Header.Set("Content-Type", "application/json")
			response, err := app.Test(req)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != http.StatusForbidden {
				t.Fatalf("unsafe media reached writer: HTTP %d", response.StatusCode)
			}
		})
	}
}

func TestMediaReferencePayloadPreservesExternalAndPlainText(t *testing.T) {
	accountID := uuid.New()
	server := &Server{}
	app := fiber.New()
	app.Post("/", func(c *fiber.Ctx) error {
		c.Locals("claims", &service.JWTClaims{AccountID: accountID})
		if err := server.authorizeMediaReferencePayload(c, map[string]any{"image": "https://external.example/clarin-media/" + accountID.String() + "/photo.png", "label": "A regular document", "canvas": map[string]any{"height": 1200}}); err != nil {
			t.Fatal(err)
		}
		return c.SendStatus(http.StatusNoContent)
	})
	response, err := app.Test(httptest.NewRequest(http.MethodPost, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatal(response.StatusCode)
	}
}
