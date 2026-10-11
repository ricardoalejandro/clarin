package api

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/minio/minio-go/v7"
)

func TestStorageReadErrorsDistinguishAbsenceFromUnavailableProvider(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
	}{
		{"missing key", minio.ErrorResponse{Code: "NoSuchKey"}, 404},
		{"missing object", minio.ErrorResponse{Code: "NotFound"}, 404},
		{"provider deadline", context.DeadlineExceeded, 503},
		{"provider credentials", minio.ErrorResponse{Code: "AccessDenied"}, 503},
		{"provider network", errors.New("connection refused"), 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/file", func(c *fiber.Ctx) error { return storageObjectReadError(c, tc.err) })
			res, err := app.Test(httptest.NewRequest("GET", "/file", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			if res.StatusCode != tc.status {
				t.Fatalf("status=%d want=%d", res.StatusCode, tc.status)
			}
		})
	}
}
