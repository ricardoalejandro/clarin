package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestContactFailureReturnsSafeRetryReference(t *testing.T) {
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return contactFailure(c, "avatar_save", "No se pudo guardar la foto", errors.New("private SQL or credentials"))
	})
	response, err := app.Test(httptest.NewRequest("GET", "/", nil), 5000)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	if json.NewDecoder(response.Body).Decode(&body) != nil {
		t.Fatal("invalid response")
	}
	requestID, _ := body["request_id"].(string)
	if _, err := uuid.Parse(requestID); err != nil {
		t.Fatal("missing safe request reference")
	}
	if response.StatusCode != 500 || response.Header.Get("X-Request-ID") != requestID || body["retryable"] != true || strings.Contains(body["error"].(string), "private") {
		t.Fatalf("unsafe response: %#v", body)
	}
}
