package api

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/logger"
)

func TestClarinAccessLogOmitsQueryCredentials(t *testing.T) {
	t.Parallel()

	var output bytes.Buffer
	app := fiber.New()
	app.Use(logger.New(logger.Config{
		Format: clarinAccessLogFormat,
		Output: &output,
	}))
	app.Get("/ws/whiteboards/:id", func(c *fiber.Ctx) error {
		return c.SendStatus(fiber.StatusNoContent)
	})

	const secret = "collaboration-ticket-secret"
	request := httptest.NewRequest(http.MethodGet, "/ws/whiteboards/board-one?ticket="+secret, nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNoContent {
		t.Fatalf("unexpected response status: %d", response.StatusCode)
	}

	logged := output.String()
	if !strings.Contains(logged, "/ws/whiteboards/board-one") {
		t.Fatalf("access log omitted request path: %q", logged)
	}
	for _, forbidden := range []string{"ticket", secret, "?"} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("access log exposed query credential %q: %q", forbidden, logged)
		}
	}
}
