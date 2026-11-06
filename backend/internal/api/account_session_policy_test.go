package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

func TestAccountSessionPolicyRejectsLocalAuthorityAndInvalidInput(t *testing.T) {
	for _, tc := range []struct {
		name   string
		claims service.JWTClaims
		body   string
		status int
	}{
		{name: "account super admin", claims: service.JWTClaims{IsAdmin: true, Role: domain.RoleSuperAdmin}, body: `{"session_idle_timeout_minutes":60}`, status: http.StatusForbidden},
		{name: "wildcard", claims: service.JWTClaims{Permissions: []string{domain.PermAll}}, body: `{"session_idle_timeout_minutes":60}`, status: http.StatusForbidden},
		{name: "decimal", claims: service.JWTClaims{IsSuperAdmin: true}, body: `{"session_idle_timeout_minutes":30.5}`, status: http.StatusBadRequest},
		{name: "missing", claims: service.JWTClaims{IsSuperAdmin: true}, body: `{}`, status: http.StatusBadRequest},
		{name: "below minimum", claims: service.JWTClaims{IsSuperAdmin: true}, body: `{"session_idle_timeout_minutes":4}`, status: http.StatusBadRequest},
		{name: "above maximum", claims: service.JWTClaims{IsSuperAdmin: true}, body: `{"session_idle_timeout_minutes":1441}`, status: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Put("/accounts/:id/session-policy", func(c *fiber.Ctx) error {
				c.Locals("claims", &tc.claims)
				return c.Next()
			}, (&Server{}).handleAdminUpdateAccountSessionPolicy)
			request := httptest.NewRequest(http.MethodPut, "/accounts/"+uuid.NewString()+"/session-policy", strings.NewReader(tc.body))
			request.Header.Set("Content-Type", "application/json")
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tc.status {
				t.Fatalf("HTTP %d, want %d", response.StatusCode, tc.status)
			}
		})
	}
}

func TestLegacyEmptyHeartbeatReturnsSnapshotWithoutRecordingActivity(t *testing.T) {
	app := fiber.New()
	app.Post("/activity", func(c *fiber.Ctx) error {
		c.Locals("claims", &service.JWTClaims{UserID: uuid.New(), AccountID: uuid.New()})
		c.Locals("auth_session", service.AuthSessionSnapshot{Scope: "example", IdleTimeoutMinutes: 120})
		return c.Next()
	}, (&Server{}).handleAuthActivity)
	request := httptest.NewRequest(http.MethodPost, "/activity", nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", response.StatusCode)
	}
}
