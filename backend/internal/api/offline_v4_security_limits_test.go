package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestOfflineV4RequestBudgetsCoverPublicProtectedAndAdminRoutes(t *testing.T) {
	for _, item := range []struct {
		path  string
		limit int
	}{
		{"/api/offline/v4/sync", 2 << 20},
		{"/API/OFFLINE/V4/SYNC///", 2 << 20},
		{"/api/offline/v4/sync/challenge", 4 << 10},
		{"/api/offline/v4/enrollment/challenge", 4 << 10},
		{"/api/offline/v4/enrollment/requests", 16 << 10},
		{"/api/offline/v4/grants/uuid/challenge", 4 << 10},
		{"/api/offline/v4/grants/uuid/keys", 16 << 10},
		{"/api/offline/v4/grants/uuid/selection", 32 << 10},
		{"/api/admin/offline-v4/enrollment-requests/uuid/approve", 32 << 10},
		{"/api/admin/offline-v4/enrollment-requests/uuid/reject", 4 << 10},
		{"/API/ADMIN/OFFLINE-V4/GRANTS/uuid/REVOKE/", 4 << 10},
		{"/api/admin/offline-v4/controls", 4 << 10},
		{"/api/offline/v4", 4 << 10},
		{"/api/admin/offline-v4", 4 << 10},
		{"/api/offline/v3/sync", 0},
		{"/api/offline/v40/sync", 0},
		{"/api/admin/offline-v40/controls", 0},
		{"/api/tasks/attachments", 0},
	} {
		if got := offlineV4RequestLimit(item.path); got != item.limit {
			t.Errorf("%s: limit=%d want=%d", item.path, got, item.limit)
		}
	}
}

func TestOfflineV4GuardRejectsOversizeBeforeHandlerAndPermitsExactBoundary(t *testing.T) {
	for _, path := range []string{
		"/api/offline/v4/sync", "/API/OFFLINE/V4/SYNC/", "/api/offline/v4/sync/challenge",
		"/api/offline/v4/enrollment/challenge", "/api/offline/v4/enrollment/requests", "/api/offline/v4/grants/id/challenge",
		"/api/offline/v4/grants/id/keys", "/api/offline/v4/grants/id/selection",
		"/api/admin/offline-v4/enrollment-requests/id/approve", "/api/admin/offline-v4/enrollment-requests/id/reject",
		"/api/admin/offline-v4/grants/id/revoke", "/API/ADMIN/OFFLINE-V4/CONTROLS/",
	} {
		t.Run(path, func(t *testing.T) {
			limit := offlineV4RequestLimit(path)
			for _, chunked := range []bool{false, true} {
				for _, extra := range []int{0, 1} {
					called := false
					app := fiber.New(fiber.Config{BodyLimit: 52 << 20})
					app.Use(guardOfflineV4Request)
					app.Use(func(c *fiber.Ctx) error { called = true; return c.SendStatus(fiber.StatusNoContent) })
					request := httptest.NewRequest(fiber.MethodPost, path, bytes.NewReader(bytes.Repeat([]byte(" "), limit+extra)))
					request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
					if chunked {
						request.ContentLength = -1
						request.TransferEncoding = []string{"chunked"}
					}
					response, err := app.Test(request)
					if err != nil {
						t.Fatal(err)
					}
					body, err := io.ReadAll(response.Body)
					_ = response.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					if extra == 0 {
						if response.StatusCode != 204 || !called {
							t.Fatalf("boundary rejected: status=%d chunked=%v", response.StatusCode, chunked)
						}
					} else {
						var payload struct {
							Error    string `json:"error"`
							MaxBytes int    `json:"max_bytes"`
						}
						if json.Unmarshal(body, &payload) != nil || payload.Error != "offline_payload_too_large" || payload.MaxBytes != limit || response.StatusCode != 413 || called {
							t.Fatalf("oversize reached handler: status=%d called=%v chunked=%v", response.StatusCode, called, chunked)
						}
						if response.Header.Get("X-Clarin-Response") != "1" || response.Header.Get("X-Clarin-Offline-Protocol") != "4" || !strings.Contains(response.Header.Get("Cache-Control"), "no-store") {
							t.Fatal("untrusted or cacheable guard response")
						}
					}
				}
			}
		})
	}
}

func TestOfflineV4GuardRejectsEncodingBeforeDecompression(t *testing.T) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write(bytes.Repeat([]byte("x"), 2<<20))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if compressed.Len() > 4<<10 {
		t.Fatal("fixture is not compressed")
	}
	for _, path := range []string{"/api/offline/v4/sync/challenge", "/API/OFFLINE/V4/SYNC", "/api/offline/v4/grants/id/keys", "/API/ADMIN/OFFLINE-V4/CONTROLS/"} {
		for _, encoding := range []string{"gzip", "br", "deflate", "gzip, br", "identity"} {
			called := false
			app := fiber.New()
			app.Use(guardOfflineV4Request)
			app.Use(func(c *fiber.Ctx) error { called = true; _ = c.Body(); return c.SendStatus(204) })
			request := httptest.NewRequest(fiber.MethodPost, path, bytes.NewReader(compressed.Bytes()))
			request.Header.Set(fiber.HeaderContentEncoding, encoding)
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			body, _ := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if called || response.StatusCode != 415 || !bytes.Contains(body, []byte("offline_content_encoding_unsupported")) {
				t.Fatalf("encoded body reached handler: path=%s encoding=%s status=%d", path, encoding, response.StatusCode)
			}
		}
	}
}

func TestOfflineV4GuardChecksDeclaredLengthAndLeavesOtherModulesUntouched(t *testing.T) {
	for _, path := range []string{"/api/offline/v4/sync", "/api/tasks/attachments", "/api/offline/v3/sync", "/api/offline/v40/sync"} {
		called := false
		app := fiber.New()
		app.Use(func(c *fiber.Ctx) error { c.Request().Header.SetContentLength(3 << 20); return c.Next() })
		app.Use(guardOfflineV4Request)
		app.Use(func(c *fiber.Ctx) error { called = true; return c.SendStatus(204) })
		response, err := app.Test(httptest.NewRequest(fiber.MethodPost, path, bytes.NewBufferString("{}")))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if path == "/api/offline/v4/sync" {
			if called || response.StatusCode != 413 {
				t.Fatal("declared oversize reached handler")
			}
		} else if !called || response.StatusCode != 204 {
			t.Fatalf("other module was limited: %s", path)
		}
	}
}

func TestOfflineV4GuardRejectsDuplicateEncodingHeaders(t *testing.T) {
	called := false
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Request().Header.Add(fiber.HeaderContentEncoding, "gzip")
		return c.Next()
	})
	app.Use(guardOfflineV4Request)
	app.Use(func(c *fiber.Ctx) error { called = true; return c.SendStatus(204) })
	request := httptest.NewRequest(fiber.MethodPost, "/api/offline/v4/sync/challenge", bytes.NewBufferString("{}"))
	request.Header.Set(fiber.HeaderContentEncoding, " ")
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if called || response.StatusCode != 415 {
		t.Fatal("duplicate encoded header reached JSON handler")
	}
}

func TestOfflineV4GuardIsWiredBeforeAuthenticationAndHandlers(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	guard := strings.Index(text, "app.Use(guardOfflineV4Request)")
	if guard < 0 || guard > strings.Index(text, "app.Use(server.validateBrowserOrigin)") || guard > strings.Index(text, "server.setupRoutes()") {
		t.Fatal("offline body guard must precede authentication and routed handlers")
	}
}

func TestOfflineV5KeyRegistrationHasFocusedRateLimit(t *testing.T) {
	source, err := os.ReadFile("server.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	needle := `offlineV5.Post("/grants/:grantId/keys", limiter.New(limiter.Config{Max: 10, Expiration: time.Minute}), s.handleOfflineV5RegisterKey)`
	if !strings.Contains(text, needle) {
		t.Fatal("offline v5 password confirmation lost its focused 10/min limiter")
	}
}
