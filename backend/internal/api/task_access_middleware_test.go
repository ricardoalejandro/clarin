package api

import (
	"io"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestHistoricalTaskReadsRequireExplicitLifecycle(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/task", func(c *fiber.Ctx) error {
		if taskHistoricalReadRequested(c) {
			return c.SendString("historical")
		}
		return c.SendString("active")
	})
	for _, test := range []struct {
		query string
		want  string
	}{
		{query: "", want: "active"},
		{query: "?lifecycle=active", want: "active"},
		{query: "?lifecycle=archive", want: "historical"},
		{query: "?lifecycle=ARCHIVED", want: "historical"},
	} {
		response, err := app.Test(httptest.NewRequest("GET", "/task"+test.query, nil))
		if err != nil {
			t.Fatalf("request %q failed: %v", test.query, err)
		}
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || string(body) != test.want {
			t.Fatalf("request %q returned %q, err=%v; want %q", test.query, string(body), err, test.want)
		}
	}
}
