package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
)

func TestUtilityBrowserPreflightAndVersionExposure(t *testing.T) {
	app := fiber.New()
	app.Use(cors.New(browserCORSConfig("https://clarin.test")))
	app.Put("/content", func(c *fiber.Ctx) error { c.Set("X-Content-Version", "7"); return c.SendString("saved") })
	preflight := httptest.NewRequest(http.MethodOptions, "/content", nil)
	preflight.Header.Set("Origin", "https://clarin.test")
	preflight.Header.Set("Access-Control-Request-Method", "PUT")
	preflight.Header.Set("Access-Control-Request-Headers", "Content-Type,If-Match,X-Operation-Id")
	response, err := app.Test(preflight)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 || response.Header.Get("Access-Control-Allow-Origin") != "https://clarin.test" {
		t.Fatal("authorized utility preflight rejected")
	}
	for _, header := range []string{"if-match", "x-operation-id"} {
		if !strings.Contains(strings.ToLower(response.Header.Get("Access-Control-Allow-Headers")), header) {
			t.Fatalf("missing %s", header)
		}
	}
	for _, origin := range []string{"https://clarin.test", "https://untrusted.test"} {
		request := httptest.NewRequest(http.MethodPut, "/content", strings.NewReader("saved"))
		request.Header.Set("Origin", origin)
		response, err = app.Test(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if origin == "https://clarin.test" {
			if !strings.Contains(strings.ToLower(response.Header.Get("Access-Control-Expose-Headers")), "x-content-version") || response.Header.Get("X-Content-Version") != "7" {
				t.Fatal("content version not exposed")
			}
		} else if response.Header.Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("untrusted origin admitted")
		}
	}
}
