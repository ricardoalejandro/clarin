package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/service"
)

func TestClassifyAuthFailurePreservesSessionDuringTransientOutage(t *testing.T) {
	transient := classifyAuthFailure(errors.Join(service.ErrAuthSessionUnavailable, errors.New("redis unavailable")))
	if transient.Status != fiber.StatusServiceUnavailable || transient.Code != "authorization_unavailable" || transient.ClearCookies {
		t.Fatalf("unexpected transient disposition: %+v", transient)
	}

	terminal := classifyAuthFailure(service.ErrAuthSessionExpired)
	if terminal.Status != fiber.StatusUnauthorized || terminal.Code != "" || !terminal.ClearCookies {
		t.Fatalf("unexpected terminal disposition: %+v", terminal)
	}
}

func TestWhiteboardJWTFallbackNeverMasksRedisUnavailability(t *testing.T) {
	if !shouldFallbackToWhiteboardSessionCredential(service.ErrAuthSessionExpired) {
		t.Fatal("terminal access JWT failure did not allow the scoped whiteboard credential")
	}
	redisFailure := errors.Join(service.ErrAuthSessionUnavailable, errors.New("redis unavailable"))
	if shouldFallbackToWhiteboardSessionCredential(redisFailure) {
		t.Fatal("Redis failure incorrectly fell back to a second credential path")
	}
	disposition := classifyAuthFailure(redisFailure)
	if disposition.Status != fiber.StatusServiceUnavailable || disposition.Code != "authorization_unavailable" {
		t.Fatalf("Redis failure did not remain a retryable 503: %+v", disposition)
	}
}

func TestWhiteboardReconnectCookieIsPathLimitedAndRotatesWithAuthCookies(t *testing.T) {
	now := time.Date(2026, 8, 24, 12, 0, 0, 0, time.UTC)
	refreshToken := "current-refresh-token"
	authCookie := authTokenCookie("access-token", now, true)
	refreshCookie := refreshTokenCookie(refreshToken, now, true)
	whiteboardCookie := whiteboardSessionCookie(refreshToken, now, true)

	if authCookie.Expires.Sub(now) != time.Hour {
		t.Fatalf("access JWT cookie lifetime changed: %s", authCookie.Expires.Sub(now))
	}
	if refreshCookie.Expires.Sub(now) != service.AuthSessionAbsoluteLifetime || whiteboardCookie.Expires.Sub(now) != service.AuthSessionAbsoluteLifetime {
		t.Fatalf("session cookie lifetimes differ: refresh=%s whiteboard=%s", refreshCookie.Expires.Sub(now), whiteboardCookie.Expires.Sub(now))
	}
	if whiteboardCookie.Name != whiteboardSessionCookieName || whiteboardCookie.Value != refreshToken ||
		whiteboardCookie.Path != "/api/whiteboards" || !whiteboardCookie.HTTPOnly || !whiteboardCookie.Secure ||
		whiteboardCookie.SameSite != fiber.CookieSameSiteStrictMode {
		t.Fatalf("unsafe whiteboard reconnect cookie: %#v", whiteboardCookie)
	}
	if refreshCookie.Value != whiteboardCookie.Value {
		t.Fatal("whiteboard reconnect cookie did not rotate with the canonical refresh credential")
	}
}

func TestClearWhiteboardReconnectCookiePreservesSecurityScope(t *testing.T) {
	now := time.Now().UTC()
	cookie := clearWhiteboardSessionCookie(now, true)
	if cookie.Name != whiteboardSessionCookieName || cookie.Value != "" || cookie.MaxAge != -1 ||
		cookie.Path != "/api/whiteboards" || !cookie.HTTPOnly || !cookie.Secure ||
		cookie.SameSite != fiber.CookieSameSiteStrictMode || !cookie.Expires.Before(now) {
		t.Fatalf("whiteboard reconnect cookie was not cleared in its exact scope: %#v", cookie)
	}
}

func TestBootstrapWhiteboardSessionSetsOnlyScopedCookie(t *testing.T) {
	refreshToken := "current-refresh-token"
	validated := false
	app := fiber.New()
	app.Post("/api/auth/whiteboard-session", func(c *fiber.Ctx) error {
		return bootstrapWhiteboardSessionCookie(c, true, func(_ context.Context, token string) (*service.AuthSessionIdentity, error) {
			validated = true
			if token != refreshToken {
				t.Fatalf("validator token = %q, want current refresh credential", token)
			}
			return &service.AuthSessionIdentity{}, nil
		})
	})
	request := httptest.NewRequest(http.MethodPost, "/api/auth/whiteboard-session", nil)
	request.AddCookie(&http.Cookie{Name: "refresh-token", Value: refreshToken, Path: "/api/auth"})
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNoContent || !validated {
		t.Fatalf("status=%d validated=%v", response.StatusCode, validated)
	}
	cookies := response.Cookies()
	if len(cookies) != 1 {
		t.Fatalf("Set-Cookie count = %d, want exactly scoped whiteboard cookie", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != whiteboardSessionCookieName || cookie.Value != refreshToken || cookie.Path != "/api/whiteboards" ||
		!cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected bootstrap cookie: %#v", cookie)
	}
}

func TestBootstrapWhiteboardSessionClassifiesTerminalAndUnavailableStates(t *testing.T) {
	tests := []struct {
		name       string
		withCookie bool
		identity   *service.AuthSessionIdentity
		err        error
		status     int
		code       string
		called     bool
	}{
		{name: "missing credential", status: fiber.StatusUnauthorized, code: "session_expired"},
		{name: "missing canonical session", withCookie: true, err: service.ErrAuthSessionExpired, status: fiber.StatusUnauthorized, code: "session_expired", called: true},
		{name: "nil identity", withCookie: true, status: fiber.StatusUnauthorized, code: "session_expired", called: true},
		{name: "redis unavailable", withCookie: true, err: errors.Join(service.ErrAuthSessionUnavailable, errors.New("redis unavailable")), status: fiber.StatusServiceUnavailable, code: "authorization_unavailable", called: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			called := false
			app := fiber.New()
			app.Post("/api/auth/whiteboard-session", func(c *fiber.Ctx) error {
				return bootstrapWhiteboardSessionCookie(c, false, func(context.Context, string) (*service.AuthSessionIdentity, error) {
					called = true
					return testCase.identity, testCase.err
				})
			})
			request := httptest.NewRequest(http.MethodPost, "/api/auth/whiteboard-session", nil)
			if testCase.withCookie {
				request.AddCookie(&http.Cookie{Name: "refresh-token", Value: "credential", Path: "/api/auth"})
			}
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != testCase.status || called != testCase.called {
				t.Fatalf("status=%d called=%v, want status=%d called=%v", response.StatusCode, called, testCase.status, testCase.called)
			}
			var body struct {
				Code string `json:"code"`
			}
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body.Code != testCase.code {
				t.Fatalf("code=%q, want %q", body.Code, testCase.code)
			}
			if len(response.Cookies()) != 0 {
				t.Fatal("failed bootstrap unexpectedly replaced a cookie")
			}
		})
	}
}
