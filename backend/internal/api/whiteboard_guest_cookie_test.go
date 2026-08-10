package api

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestWhiteboardGuestSecretUsesOnlyHTTPOnlySessionCookie(t *testing.T) {
	t.Parallel()

	linkID := uuid.New()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		secret, err := whiteboardGuestSecret(c, linkID)
		if err != nil {
			return c.SendStatus(fiber.StatusUnauthorized)
		}
		return c.SendString(secret)
	})

	request := httptest.NewRequest(fiber.MethodGet, "/", nil)
	request.Header.Set("Cookie", whiteboardGuestCookieName(linkID)+"=guest-secret")
	response, err := app.Test(request)
	if err != nil {
		t.Fatalf("cookie request failed: %v", err)
	}
	if response.StatusCode != fiber.StatusOK {
		t.Fatalf("cookie request status = %d, want %d", response.StatusCode, fiber.StatusOK)
	}

	bearerOnly := httptest.NewRequest(fiber.MethodGet, "/", nil)
	bearerOnly.Header.Set(fiber.HeaderAuthorization, "Bearer exposed-to-javascript")
	response, err = app.Test(bearerOnly)
	if err != nil {
		t.Fatalf("bearer-only request failed: %v", err)
	}
	if response.StatusCode != fiber.StatusUnauthorized {
		t.Fatalf("bearer-only status = %d, want %d", response.StatusCode, fiber.StatusUnauthorized)
	}
}
