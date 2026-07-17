package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/storage"
)

func TestSanitizeUploadFolder(t *testing.T) {
	for _, test := range []struct {
		raw      string
		fallback string
		want     string
	}{
		{raw: "", fallback: "uploads", want: "uploads"},
		{raw: "chat/attachments", fallback: "uploads", want: "chat/attachments"},
		{raw: " campañas / julio ", fallback: "uploads", want: "campañas/julio"},
	} {
		got, err := sanitizeUploadFolder(test.raw, test.fallback)
		if err != nil || got != test.want {
			t.Fatalf("sanitizeUploadFolder(%q): got=%q err=%v", test.raw, got, err)
		}
	}

	for _, raw := range []string{
		"../another-account/uploads",
		"uploads/../another-account",
		"/absolute",
		"uploads/",
		"uploads//nested",
		"uploads\\nested",
		"_private/statuses",
		"uploads/_private/statuses",
		"statuses",
		"uploads/statuses",
	} {
		if got, err := sanitizeUploadFolder(raw, "uploads"); err == nil {
			t.Fatalf("unsafe folder %q was accepted as %q", raw, got)
		}
	}
}

func TestSanitizeUploadFilename(t *testing.T) {
	for _, filename := range []string{"photo.jpg", "informe final.pdf", "área.webp"} {
		if got, err := sanitizeUploadFilename(filename); err != nil || got != filename {
			t.Fatalf("safe filename %q: got=%q err=%v", filename, got, err)
		}
	}
	for _, filename := range []string{
		"", ".", "..", "../victim.jpg", "x/../../../victim/_private/statuses/pwn",
		"folder/file.jpg", "folder\\file.jpg", "bad\x00name.jpg",
	} {
		if got, err := sanitizeUploadFilename(filename); err == nil {
			t.Fatalf("unsafe filename %q was accepted as %q", filename, got)
		}
	}
}

func TestPresignedUploadEndpointFailsClosed(t *testing.T) {
	app := fiber.New()
	server := &Server{storage: &storage.Storage{}}
	app.Get("/api/media/upload-url", server.handleGetUploadURL)
	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/api/media/upload-url?filename=x&size=0", nil))
	if err != nil {
		t.Fatalf("request disabled presigned upload: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusGone {
		t.Fatalf("presigned upload returned %d, want %d", response.StatusCode, fiber.StatusGone)
	}
}
