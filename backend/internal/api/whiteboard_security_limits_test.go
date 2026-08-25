package api

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestWhiteboardJSONGuardsRejectCompressedBodiesBeforeHandler(t *testing.T) {
	t.Parallel()
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(`{"body":"`)); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(strings.Repeat("x", 64*1024))); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if compressed.Len() >= 1024 {
		t.Fatalf("gzip fixture is not small: %d bytes", compressed.Len())
	}

	server := &Server{abuseLimiter: newInMemoryAbuseLimiter()}
	for _, test := range []struct {
		name, method, path string
		guard              fiber.Handler
	}{
		{"guest session", fiber.MethodPost, "/api/public/whiteboard-links/" + uuid.NewString() + "/session", server.guardWhiteboardGuestSessionExchange},
		{"guest snapshot", fiber.MethodPatch, "/api/whiteboard-guest/scene", server.guardWhiteboardGuestSnapshotWrite},
		{"library callback or complete", fiber.MethodPost, "/api/whiteboards/library-import", server.guardWhiteboardLibraryImportMutation},
		{"comment mutation", fiber.MethodPost, "/api/whiteboards/" + uuid.NewString() + "/comment-threads", server.guardWhiteboardCommentMutation},
	} {
		t.Run(test.name, func(t *testing.T) {
			called := false
			observedEncoding := ""
			app := fiber.New()
			app.Add(test.method, test.path, func(c *fiber.Ctx) error {
				observedEncoding = c.Get(fiber.HeaderContentEncoding)
				return c.Next()
			}, test.guard, func(c *fiber.Ctx) error {
				called = true
				return c.SendStatus(fiber.StatusNoContent)
			})
			request := httptest.NewRequest(test.method, test.path, bytes.NewReader(compressed.Bytes()))
			request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
			request.Header.Set(fiber.HeaderContentEncoding, "gzip")
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			_ = response.Body.Close()
			if response.StatusCode != fiber.StatusUnsupportedMediaType || called || !bytes.Contains(body, []byte(`"code":"whiteboard_content_encoding_unsupported"`)) {
				t.Fatalf("encoded request was not rejected before handler: status=%d called=%v encoding=%q body=%s", response.StatusCode, called, observedEncoding, body)
			}
		})
	}
}

func TestWhiteboardGuestSessionGuardRejectsOversizeBeforeHandler(t *testing.T) {
	t.Parallel()
	server := &Server{abuseLimiter: newInMemoryAbuseLimiter()}
	called := false
	app := fiber.New()
	app.Post("/api/public/whiteboard-links/:id/session", server.guardWhiteboardGuestSessionExchange, func(c *fiber.Ctx) error {
		called = true
		var payload map[string]any
		if err := c.BodyParser(&payload); err != nil {
			return err
		}
		return c.SendStatus(fiber.StatusNoContent)
	})
	body := bytes.Repeat([]byte("x"), whiteboardGuestSessionMaxRequestBytes+1)
	request := httptest.NewRequest(fiber.MethodPost, "/api/public/whiteboard-links/"+uuid.NewString()+"/session", bytes.NewReader(body))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusRequestEntityTooLarge || called {
		t.Fatalf("oversized public exchange reached parser/handler: status=%d called=%v", response.StatusCode, called)
	}
}

func TestWhiteboardGuestSessionGuardRatesInvalidBodiesBeforeParser(t *testing.T) {
	server := &Server{abuseLimiter: newInMemoryAbuseLimiter()}
	parsed := 0
	app := fiber.New()
	linkID := uuid.NewString()
	app.Post("/api/public/whiteboard-links/:id/session", server.guardWhiteboardGuestSessionExchange, func(c *fiber.Ctx) error {
		parsed++
		var payload map[string]any
		if err := c.BodyParser(&payload); err != nil {
			return c.SendStatus(fiber.StatusBadRequest)
		}
		return c.SendStatus(fiber.StatusNoContent)
	})
	for attempt := 0; attempt < 13; attempt++ {
		request := httptest.NewRequest(fiber.MethodPost, "/api/public/whiteboard-links/"+linkID+"/session", bytes.NewBufferString("{"))
		request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		response, err := app.Test(request)
		if err != nil {
			t.Fatal(err)
		}
		if attempt < 12 && response.StatusCode != fiber.StatusBadRequest {
			t.Fatalf("attempt %d status=%d, want invalid JSON", attempt+1, response.StatusCode)
		}
		if attempt == 12 && response.StatusCode != fiber.StatusTooManyRequests {
			t.Fatalf("rate limit ran after parser or was not enforced: status=%d", response.StatusCode)
		}
	}
	if parsed != 12 {
		t.Fatalf("rate-limited request reached BodyParser: parsed=%d", parsed)
	}
}

func TestWhiteboardGuestSnapshotRequestBudgetKeepsValidSceneEnvelope(t *testing.T) {
	if whiteboardGuestSnapshotMaxRequestBytes <= 16*1024*1024 {
		t.Fatalf("snapshot envelope has no overhead budget: %d", whiteboardGuestSnapshotMaxRequestBytes)
	}
	if whiteboardGuestSnapshotMaxRequestBytes >= 17*1024*1024 {
		t.Fatalf("snapshot request budget is unexpectedly broad: %d", whiteboardGuestSnapshotMaxRequestBytes)
	}
}

func TestWhiteboardGuestPatchGuardRatesBeforeParser(t *testing.T) {
	server := &Server{abuseLimiter: newInMemoryAbuseLimiter()}
	parsed := 0
	app := fiber.New()
	linkID := uuid.New()
	app.Patch("/api/whiteboard-guest/scene", server.guardWhiteboardGuestSnapshotWrite, func(c *fiber.Ctx) error {
		parsed++
		var payload map[string]any
		if err := c.BodyParser(&payload); err != nil {
			return c.SendStatus(fiber.StatusBadRequest)
		}
		return c.SendStatus(fiber.StatusNoContent)
	})
	for attempt := 0; attempt < 61; attempt++ {
		request := httptest.NewRequest(fiber.MethodPatch, "/api/whiteboard-guest/scene?link_id="+linkID.String(), bytes.NewBufferString("{"))
		request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
		request.Header.Set("Cookie", whiteboardGuestCookieName(linkID)+"=bounded-guest-session")
		response, err := app.Test(request)
		if err != nil {
			t.Fatal(err)
		}
		if attempt < 60 && response.StatusCode != fiber.StatusBadRequest {
			t.Fatalf("patch attempt %d status=%d, want invalid JSON", attempt+1, response.StatusCode)
		}
		if attempt == 60 && response.StatusCode != fiber.StatusTooManyRequests {
			t.Fatalf("guest PATCH rate limit ran after parser: status=%d", response.StatusCode)
		}
	}
	if parsed != 60 {
		t.Fatalf("rate-limited guest PATCH reached BodyParser: parsed=%d", parsed)
	}
}

func TestWhiteboardGuestPatchBudgetTightensWithPayloadSize(t *testing.T) {
	t.Parallel()
	small := whiteboardGuestSceneWriteRateBudget(fiber.MethodPatch, 32*1024)
	medium := whiteboardGuestSceneWriteRateBudget(fiber.MethodPatch, 2*1024*1024)
	large := whiteboardGuestSceneWriteRateBudget(fiber.MethodPatch, 8*1024*1024)
	if small.SessionPerMinute != 60 || medium.SessionPerMinute != 20 || large.SessionPerMinute != 6 {
		t.Fatalf("unexpected size-weighted patch budgets: small=%#v medium=%#v large=%#v", small, medium, large)
	}
	put := whiteboardGuestSceneWriteRateBudget(fiber.MethodPut, 1)
	if put.SessionPerMinute != 6 {
		t.Fatalf("full snapshot budget became permissive: %#v", put)
	}
}
