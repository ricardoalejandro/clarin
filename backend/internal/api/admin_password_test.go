package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestValidateAdminPasswordInputReturnsStableCodes(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name         string
		password     string
		confirmation string
		code         string
	}{
		{name: "password required", code: "password_required"},
		{name: "confirmation required", password: "Abcdefgh1!", code: "password_mismatch"},
		{name: "confirmation differs", password: "Abcdefgh1!", confirmation: "Abcdefgh2!", code: "password_mismatch"},
		{name: "policy", password: "abcdefghij", confirmation: "abcdefghij", code: "password_policy"},
		{name: "valid", password: "Abcdefgh1!", confirmation: "Abcdefgh1!"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := validateAdminPasswordInput(test.password, test.confirmation)
			if test.code == "" {
				if got != nil {
					t.Fatalf("validateAdminPasswordInput() = %#v, want nil", got)
				}
				return
			}
			if got == nil || got.Code != test.code || got.Message == "" {
				t.Fatalf("validateAdminPasswordInput() = %#v, want code %q", got, test.code)
			}
		})
	}
}

func TestPasswordPolicyErrorRetainsSafeMessageAndSentinel(t *testing.T) {
	t.Parallel()
	err := service.ValidateStrongPassword("short")
	if !errors.Is(err, service.ErrPasswordPolicy) {
		t.Fatalf("error = %v, want ErrPasswordPolicy", err)
	}
	if err == nil || err.Error() == service.ErrPasswordPolicy.Error() {
		t.Fatalf("policy error did not retain its actionable message: %v", err)
	}
}

func TestWriteAdminResetPasswordErrorReportsMissingUserSafely(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error { return writeAdminResetPasswordError(c, repository.ErrUserNotFound) })
	response, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNotFound || body["code"] != "user_not_found" || body["field"] != "password" {
		t.Fatalf("status=%d body=%#v", response.StatusCode, body)
	}
}
