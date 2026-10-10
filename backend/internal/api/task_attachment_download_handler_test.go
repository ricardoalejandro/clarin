package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestTaskAttachmentDownloadRejectsMissingAuthentication(t *testing.T) {
	app := fiber.New()
	server := &Server{}
	app.Get("/api/tasks/:id/attachments/:attachmentId/download", server.authMiddleware, func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodGet, "/api/tasks/"+uuid.NewString()+"/attachments/"+uuid.NewString()+"/download", nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("request protected task attachment: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("missing auth returned %d, want 401", response.StatusCode)
	}
}

func TestMediaProxyFailsClosedWithoutAuthentication(t *testing.T) {
	accountID := uuid.NewString()
	tests := []struct {
		name string
		key  string
		want int
	}{
		{name: "legacy original", key: accountID + "/tasks/attachments/file.pdf", want: fiber.StatusNotFound},
		{name: "legacy preview", key: accountID + "/task-previews/" + uuid.NewString() + "/file.pdf", want: fiber.StatusNotFound},
		{name: "private original", key: accountID + "/_private/tasks/attachments/file.pdf", want: fiber.StatusNotFound},
		{name: "private preview", key: accountID + "/_private/tasks/previews/" + uuid.NewString() + "/file.pdf", want: fiber.StatusNotFound},
		// Ordinary media now requires account authorization or an explicit
		// public-resource capability, just as protected modules require theirs.
		{name: "anonymous chat denied", key: accountID + "/chats/attachments/file.pdf", want: fiber.StatusNotFound},
		{name: "anonymous survey upload denied", key: accountID + "/surveys/uploads/file.pdf", want: fiber.StatusNotFound},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			server := &Server{}
			app.Get("/api/media/file/*", server.handleMediaProxy)
			response, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/media/file/"+test.key, nil))
			if err != nil {
				t.Fatalf("request proxy: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.want {
				t.Fatalf("proxy returned %d, want %d", response.StatusCode, test.want)
			}
		})
	}
}
