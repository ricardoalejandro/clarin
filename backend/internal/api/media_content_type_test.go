package api

import (
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestStorageContentType(t *testing.T) {
	tests := []struct {
		name      string
		objectKey string
		explicit  string
		stored    string
		want      string
	}{
		{name: "explicit validated type wins", objectKey: "file.pdf", explicit: "application/custom", stored: "application/pdf", want: "application/custom"},
		{name: "pdf extension beats a bad stored type", objectKey: "account/media/pdf/file.PDF", stored: "text/plain; charset=utf-8", want: "application/pdf"},
		{name: "image extension", objectKey: "account/media/png/file.png", want: "image/png"},
		{name: "safe stored type supports an extensionless object", objectKey: "account/media/document/file", stored: "application/pdf", want: "application/pdf"},
		{name: "safe stored type is normalized", objectKey: "account/media/document/file.bin", stored: "TEXT/PLAIN; charset=iso-8859-1", want: "text/plain; charset=utf-8"},
		{name: "unsafe stored type is never served inline", objectKey: "account/media/document/file.bin", stored: "text/html", want: "application/octet-stream"},
		{name: "unknown type falls back to binary", objectKey: "account/media/document/file.unknown", want: "application/octet-stream"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := storageContentType(test.objectKey, test.explicit, test.stored); got != test.want {
				t.Fatalf("storageContentType()=%q, want %q", got, test.want)
			}
		})
	}
}

func TestStorageHeadersMatchBetweenFullAndPartialResponses(t *testing.T) {
	app := fiber.New()
	app.Get("/media", func(c *fiber.Ctx) error {
		setStorageResponseHeaders(
			c,
			storageContentType("account/media/file.pdf", "", "text/plain; charset=utf-8"),
			"public, max-age=31536000",
			`"fixture-etag"`,
			"Fri, 04 Sep 2026 12:00:00 GMT",
			"file.pdf",
		)
		if c.Get(fiber.HeaderRange) != "" {
			c.Set(fiber.HeaderContentRange, "bytes 0-0/4")
			return c.Status(fiber.StatusPartialContent).Send([]byte("%"))
		}
		return c.Send([]byte("%PDF"))
	})

	full, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/media", nil))
	if err != nil {
		t.Fatalf("full response: %v", err)
	}
	defer full.Body.Close()

	partialRequest := httptest.NewRequest(fiber.MethodGet, "/media", nil)
	partialRequest.Header.Set(fiber.HeaderRange, "bytes=0-0")
	partial, err := app.Test(partialRequest)
	if err != nil {
		t.Fatalf("partial response: %v", err)
	}
	defer partial.Body.Close()

	if full.StatusCode != fiber.StatusOK || partial.StatusCode != fiber.StatusPartialContent {
		t.Fatalf("unexpected statuses: full=%d partial=%d", full.StatusCode, partial.StatusCode)
	}
	for _, header := range []string{
		fiber.HeaderContentType,
		fiber.HeaderAcceptRanges,
		fiber.HeaderCacheControl,
		fiber.HeaderContentDisposition,
		fiber.HeaderETag,
		fiber.HeaderLastModified,
	} {
		if full.Header.Get(header) != partial.Header.Get(header) {
			t.Errorf("%s differs: full=%q partial=%q", header, full.Header.Get(header), partial.Header.Get(header))
		}
	}
	if got := full.Header.Get(fiber.HeaderContentType); got != "application/pdf" {
		t.Fatalf("Content-Type=%q, want application/pdf", got)
	}
}
