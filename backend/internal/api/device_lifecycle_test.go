package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func TestDeviceActionsExposeLifecycleConflictsWithoutProviderMaterial(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"pending", fmt.Errorf("wrapped: %w", repository.ErrDeviceDeleting), 409, "device_deleting"},
		{"foreign_or_missing", repository.ErrDeviceNotFound, 404, "device_not_found"},
		{"identity_changed", repository.ErrDeviceSessionConflict, 409, "device_session_identity_conflict"},
		{"provider_failure", errors.New("provider session private-material"), 500, "device_action_failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Post("/device", func(c *fiber.Ctx) error { return deviceActionFailure(c, tc.err) })
			response, err := app.Test(httptest.NewRequest("POST", "/device", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body struct {
				Success bool   `json:"success"`
				Code    string `json:"code"`
				Error   string `json:"error"`
			}
			if err = json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status || body.Code != tc.code || body.Success {
				t.Fatalf("status=%d body=%+v", response.StatusCode, body)
			}
			if strings.Contains(body.Error, "private-material") {
				t.Fatal("provider error was exposed")
			}
		})
	}
}
