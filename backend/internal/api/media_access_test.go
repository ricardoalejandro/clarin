package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
	"github.com/naperu/clarin/pkg/config"
)

func TestMediaCapabilityExactScopeAndLifetime(t *testing.T) {
	now := time.Now().Truncate(time.Second)
	accountID := uuid.New()
	key := accountID.String() + "/uploads/photo.jpg"
	grant := mediaAccessGrant{Purpose: "survey-branding", AccountID: accountID, ObjectKey: key, ResourceID: uuid.New(), Expires: now.Add(mediaGrantLifetime).Unix()}
	token := signMediaAccessGrant("test-secret", grant)
	if _, err := verifyMediaAccessGrant("test-secret", token, key, now); err != nil {
		t.Fatal("valid grant rejected", err)
	}
	for _, tc := range []struct {
		name, secret, token, key string
		now                      time.Time
	}{
		{"another key", "test-secret", token, accountID.String() + "/uploads/other.jpg", now},
		{"another account", "test-secret", token, uuid.NewString() + "/uploads/photo.jpg", now},
		{"tampered", "test-secret", token + "x", key, now},
		{"wrong secret", "different", token, key, now},
		{"expired", "test-secret", token, key, now.Add(mediaGrantLifetime)},
		{"future lifetime", "test-secret", token, key, now.Add(-time.Second)},
		{"private", "test-secret", token, accountID.String() + "/_private/tasks/photo.jpg", now},
		{"empty secret", "", token, key, now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := verifyMediaAccessGrant(tc.secret, tc.token, tc.key, tc.now); err == nil {
				t.Fatal("unsafe capability accepted")
			}
		})
	}
	grant.Purpose = "download-anything"
	if _, err := verifyMediaAccessGrant("test-secret", signMediaAccessGrant("test-secret", grant), key, now); err == nil {
		t.Fatal("unknown purpose accepted")
	}
	grant.Purpose = "survey-branding"
	grant.AccountID = uuid.New()
	if _, err := verifyMediaAccessGrant("test-secret", signMediaAccessGrant("test-secret", grant), key, now); err == nil {
		t.Fatal("cross-account issuer accepted")
	}
}

func TestDraftMediaRequiresSameLiveAccountUserAndSession(t *testing.T) {
	accountID, userID := uuid.New(), uuid.New()
	claims := &service.JWTClaims{AccountID: accountID, UserID: userID, SessionID: uuid.NewString()}
	grant := &mediaAccessGrant{Purpose: "upload-preview", AccountID: accountID, UserID: userID, SessionID: claims.SessionID}
	if !privateMediaPreviewAllowed(grant, claims) {
		t.Fatal("own draft denied")
	}
	for _, other := range []*service.JWTClaims{nil, {AccountID: uuid.New(), UserID: userID, SessionID: claims.SessionID}, {AccountID: accountID, UserID: uuid.New(), SessionID: claims.SessionID}, {AccountID: accountID, UserID: userID, SessionID: uuid.NewString()}} {
		if privateMediaPreviewAllowed(grant, other) {
			t.Fatal("draft escaped its account/user/session")
		}
	}
	grant.Purpose = "survey-branding"
	if privateMediaPreviewAllowed(grant, claims) {
		t.Fatal("purpose confusion")
	}
}

func TestPublicBrandingSignsOnlySameAccountOrdinaryResources(t *testing.T) {
	accountID := uuid.New()
	server := &Server{cfg: &config.Config{JWTSecret: "test-secret"}}
	survey := &domain.Survey{ID: uuid.New(), AccountID: accountID, Branding: domain.SurveyBranding{LogoURL: "/api/media/file/" + accountID.String() + "/surveys/logo.png", BgImageURL: "https://external.example/background.png"}}
	branding := server.publishSurveyBranding(survey)
	if !strings.Contains(branding.LogoURL, "?media_access=") {
		t.Fatal("branding missing bounded capability")
	}
	if branding.BgImageURL != survey.Branding.BgImageURL {
		t.Fatal("external image changed")
	}
	if strings.Contains(survey.Branding.LogoURL, "?") {
		t.Fatal("signer mutated persisted model")
	}
	key := accountID.String() + "/surveys/logo.png"
	token := strings.Split(branding.LogoURL, "media_access=")[1]
	grant, err := verifyMediaAccessGrant("test-secret", token, key, time.Now())
	if err != nil || grant.ResourceID != survey.ID || grant.Purpose != "survey-branding" {
		t.Fatal("wrong publication scope")
	}
	for _, bad := range []string{uuid.NewString() + "/uploads/private.png", accountID.String() + "/_private/tasks/photo.png", accountID.String() + "/tasks/attachments/document.pdf", accountID.String() + "/../other/file.png"} {
		survey.Branding.LogoURL = "/api/media/file/" + bad
		if server.publishSurveyBranding(survey).LogoURL != "" {
			t.Fatal("unsafe branding publication accepted")
		}
	}
}

func TestMediaDraftURLUsesHttpOnlySessionCookieCompatibility(t *testing.T) {
	server := &Server{cfg: &config.Config{JWTSecret: "test-secret"}}
	accountID := uuid.New()
	key := accountID.String() + "/uploads/new.png"
	app := fiber.New()
	app.Get("/preview", func(c *fiber.Ctx) error {
		if authTokenFromRequest(c) != "browser-session" {
			t.Fatal("same-origin media cookie unavailable")
		}
		c.Locals("claims", &service.JWTClaims{AccountID: accountID, UserID: uuid.New(), SessionID: uuid.NewString()})
		signed := server.uploadPreviewURL(c, key)
		if !strings.Contains(signed, "?media_preview=") {
			t.Fatal("draft preview missing")
		}
		return c.SendStatus(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodGet, "/preview", nil)
	req.AddCookie(&http.Cookie{Name: "auth-token", Value: "browser-session"})
	res, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Fatal(res.StatusCode)
	}
}

func TestOrdinaryMediaRejectsNoncanonicalAndProtectedKeys(t *testing.T) {
	id := uuid.NewString()
	for _, key := range []string{"", id, id + "/", id + "/../other/file", id + "//file", id + "/a/./file", id + "/a\\file", id + "/a\x00file", id + "/_private/avatar/file", id + "/statuses/file", id + "/tasks/attachments/file"} {
		if _, ok := ordinaryMediaKeyAccount(key); ok {
			t.Fatalf("accepted unsafe key %q", key)
		}
	}
	if _, ok := ordinaryMediaKeyAccount(id + "/chats/file.pdf"); !ok {
		t.Fatal("ordinary file denied")
	}
}

func TestMediaObjectIdentityIgnoresCapabilities(t *testing.T) {
	key := uuid.NewString() + "/uploads/photo one.webp"
	for _, raw := range []string{"/api/media/file/" + strings.ReplaceAll(key, " ", "%20") + "?media_preview=grant", "https://media.example/clarin-media/" + strings.ReplaceAll(key, " ", "%20") + "?media_access=grant"} {
		if got := objectKeyFromMediaURL(raw); got != key {
			t.Fatalf("capability affected object identity: %q", got)
		}
	}
}
