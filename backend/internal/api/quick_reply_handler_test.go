package api

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestWriteQuickReplyErrorStatusAndCode(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "validation", err: service.ErrQuickReplyValidation, wantStatus: fiber.StatusUnprocessableEntity, wantCode: "invalid_quick_reply"},
		{name: "invalid media", err: repository.ErrQuickReplyInvalidMedia, wantStatus: fiber.StatusUnprocessableEntity, wantCode: "invalid_quick_reply"},
		{name: "not found", err: repository.ErrQuickReplyNotFound, wantStatus: fiber.StatusNotFound, wantCode: "quick_reply_not_found"},
		{name: "version conflict", err: repository.ErrQuickReplyConflict, wantStatus: fiber.StatusConflict, wantCode: "quick_reply_conflict"},
		{name: "shortcut conflict", err: repository.ErrQuickReplyShortcut, wantStatus: fiber.StatusConflict, wantCode: "quick_reply_shortcut_exists"},
		{name: "internal", err: errors.New("database details"), wantStatus: fiber.StatusInternalServerError, wantCode: "quick_reply_failed"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error { return writeQuickReplyError(c, test.err) })
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			if !containsJSONCode(string(body), test.wantCode) {
				t.Fatalf("body = %s, want code %q", body, test.wantCode)
			}
		})
	}
}

func containsJSONCode(body, code string) bool {
	return strings.Contains(body, "\"code\":\""+code+"\"")
}
