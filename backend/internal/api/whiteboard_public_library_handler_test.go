package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
	whiteboardcore "github.com/naperu/clarin/internal/whiteboard"
	"github.com/naperu/clarin/pkg/config"
)

func TestWhiteboardLibraryStartRouteRequiresExactOriginAndDedicatedHeader(t *testing.T) {
	t.Parallel()
	server := &Server{cfg: &config.Config{PublicURL: "https://clarin.example", CORSOrigins: []string{"https://workspace.clarin.example:8443"}}}
	for _, testCase := range []struct {
		name        string
		origin      string
		startHeader string
		want        int
	}{
		{name: "exact public origin and header", origin: "https://clarin.example", startHeader: "1", want: fiber.StatusNoContent},
		{name: "normalized default port", origin: "https://CLARIN.example:443", startHeader: "1", want: fiber.StatusNoContent},
		{name: "exact cors origin and port", origin: "https://workspace.clarin.example:8443", startHeader: "1", want: fiber.StatusNoContent},
		{name: "missing proof", want: fiber.StatusForbidden},
		{name: "origin without dedicated header", origin: "https://clarin.example", want: fiber.StatusForbidden},
		{name: "dedicated header without origin", startHeader: "1", want: fiber.StatusForbidden},
		{name: "wrong dedicated header", startHeader: "0", want: fiber.StatusForbidden},
		{name: "cross site cannot bypass with header", origin: "https://attacker.example", startHeader: "1", want: fiber.StatusForbidden},
		{name: "opaque origin cannot bypass with header", origin: "null", startHeader: "1", want: fiber.StatusForbidden},
		{name: "scheme divergence", origin: "http://clarin.example", startHeader: "1", want: fiber.StatusForbidden},
		{name: "port divergence", origin: "https://clarin.example:8443", startHeader: "1", want: fiber.StatusForbidden},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			app := fiber.New()
			app.Use(server.validateBrowserOrigin)
			app.Post("/api/whiteboards/:id/public-library-import/start", server.guardWhiteboardLibraryImportMutation, server.guardWhiteboardPublicLibraryStart, func(c *fiber.Ctx) error {
				return c.SendStatus(fiber.StatusNoContent)
			})
			request := httptest.NewRequest(http.MethodPost, "https://clarin.example/api/whiteboards/"+uuid.NewString()+"/public-library-import/start", strings.NewReader(`{}`))
			request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
			if testCase.origin != "" {
				request.Header.Set(fiber.HeaderOrigin, testCase.origin)
			}
			if testCase.startHeader != "" {
				request.Header.Set(whiteboardLibraryStartHeader, testCase.startHeader)
			}
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != testCase.want {
				t.Fatalf("status=%d, want %d", response.StatusCode, testCase.want)
			}
		})
	}
}

func TestWhiteboardLibraryNavigationMetadataRejectsOnlyUnequivocalCrossSite(t *testing.T) {
	t.Parallel()
	for _, testCase := range []struct {
		name string
		site string
		mode string
		dest string
		want int
	}{
		{name: "metadata omitted", want: fiber.StatusNoContent},
		{name: "exact metadata", site: "same-origin", mode: "navigate", dest: "document", want: fiber.StatusNoContent},
		{name: "cross-site contradiction", site: "cross-site", want: fiber.StatusForbidden},
		{name: "proxy normalized site", site: "none", mode: "navigate", dest: "document", want: fiber.StatusNoContent},
		{name: "same-site remains cookie authorized", site: "same-site", mode: "navigate", dest: "document", want: fiber.StatusNoContent},
		{name: "noncanonical mode remains cookie authorized", site: "same-origin", mode: "cors", dest: "empty", want: fiber.StatusNoContent},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			app := fiber.New()
			server := &Server{}
			app.Get("/navigate", server.guardWhiteboardPublicLibraryNavigation, func(c *fiber.Ctx) error {
				return c.SendStatus(fiber.StatusNoContent)
			})
			request := httptest.NewRequest(http.MethodGet, "/navigate", nil)
			if testCase.site != "" {
				request.Header.Set("Sec-Fetch-Site", testCase.site)
			}
			if testCase.mode != "" {
				request.Header.Set("Sec-Fetch-Mode", testCase.mode)
			}
			if testCase.dest != "" {
				request.Header.Set("Sec-Fetch-Dest", testCase.dest)
			}
			response, err := app.Test(request)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != testCase.want {
				t.Fatalf("status=%d, want %d", response.StatusCode, testCase.want)
			}
			if response.Header.Get(fiber.HeaderCacheControl) != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" {
				t.Fatalf("navigation guard omitted privacy headers: cache=%q referrer=%q",
					response.Header.Get(fiber.HeaderCacheControl), response.Header.Get("Referrer-Policy"))
			}
		})
	}
}

func TestWhiteboardPublicLibraryDirectoryRedirectUsesGenericSelfCallback(t *testing.T) {
	t.Parallel()
	callback := "https://clarin.example/whiteboards/library-import"
	token := "opaque-one-time-token"
	location, err := whiteboardPublicLibraryDirectoryURL(callback, token)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(location)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Scheme != "https" || parsed.Host != "libraries.excalidraw.com" || parsed.Query().Get("target") != "_self" ||
		parsed.Query().Get("referrer") != callback || parsed.Query().Get("token") != token || parsed.Query().Get("useHash") != "true" {
		t.Fatalf("unexpected directory redirect: %s", location)
	}
	if strings.Contains(location, "board-") || strings.Contains(parsed.Query().Get("referrer"), "library_import=") {
		t.Fatalf("board/import identity leaked to the directory: %s", location)
	}
}

func TestWhiteboardPublicLibraryNavigationPathIsRelativeAndActorHandoffBound(t *testing.T) {
	t.Parallel()
	boardID := uuid.New()
	importID := uuid.New()
	path, err := whiteboardPublicLibraryNavigationPath(boardID, importID)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(path)
	if err != nil {
		t.Fatal(err)
	}
	wantPath := "/api/whiteboards/" + boardID.String() + "/public-library-imports/" + importID.String() + "/navigate"
	if parsed.IsAbs() || parsed.Host != "" || parsed.Path != wantPath || parsed.RawQuery != "" || parsed.Fragment != "" {
		t.Fatalf("unexpected same-origin navigation path: %s", path)
	}
}

func TestWhiteboardPublicLibraryNavigationPathRejectsInvalidScope(t *testing.T) {
	t.Parallel()
	validID := uuid.New()
	for name, testCase := range map[string]struct {
		boardID  uuid.UUID
		importID uuid.UUID
	}{
		"board":  {boardID: uuid.Nil, importID: validID},
		"import": {boardID: validID, importID: uuid.Nil},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := whiteboardPublicLibraryNavigationPath(testCase.boardID, testCase.importID); !errors.Is(err, repository.ErrWhiteboardInvalid) {
				t.Fatalf("invalid handoff was accepted: %v", err)
			}
		})
	}
}

func TestWhiteboardLibraryHandoffCookieIsHostOnlyHttpOnlyStrictAndPathBound(t *testing.T) {
	t.Parallel()
	path := "/api/whiteboards/" + uuid.NewString() + "/public-library-imports/" + uuid.NewString() + "/navigate"
	now := time.Now().UTC().Truncate(time.Second)
	importExpiresAt := now.Add(15 * time.Minute)
	secret := strings.Repeat("a", 43)
	cookie := whiteboardLibraryHandoffCookie(path, secret, importExpiresAt, now, true)
	if cookie.Name != whiteboardLibraryHandoffCookieName || cookie.Value != secret || cookie.Path != path || cookie.Domain != "" ||
		!cookie.HTTPOnly || !cookie.Secure || cookie.SameSite != fiber.CookieSameSiteStrictMode ||
		cookie.MaxAge != int(whiteboardLibraryNavigationCookieLifetime/time.Second) || !cookie.Expires.Equal(now.Add(whiteboardLibraryNavigationCookieLifetime)) {
		t.Fatalf("unsafe public-library handoff cookie: %#v", cookie)
	}
	if developmentCookie := whiteboardLibraryHandoffCookie(path, secret, importExpiresAt, now, false); developmentCookie.Secure {
		t.Fatal("development handoff cookie was unexpectedly marked Secure")
	}
	shortImportExpiry := now.Add(45 * time.Second)
	shortCookie := whiteboardLibraryHandoffCookie(path, secret, shortImportExpiry, now, true)
	if shortCookie.MaxAge != 45 || !shortCookie.Expires.Equal(shortImportExpiry) {
		t.Fatalf("handoff cookie outlived import: %#v", shortCookie)
	}
}

func TestWhiteboardLibraryHandoffCookieClearPreservesExactSecurityScope(t *testing.T) {
	t.Parallel()
	path := "/api/whiteboards/" + uuid.NewString() + "/public-library-imports/" + uuid.NewString() + "/navigate"
	cookie := clearWhiteboardLibraryHandoffCookie(path, true)
	if cookie.Name != whiteboardLibraryHandoffCookieName || cookie.Value != "" || cookie.Path != path || cookie.Domain != "" ||
		cookie.MaxAge != -1 || !cookie.HTTPOnly || !cookie.Secure || cookie.SameSite != fiber.CookieSameSiteStrictMode || !cookie.Expires.Before(time.Now()) {
		t.Fatalf("unsafe public-library handoff cookie clear: %#v", cookie)
	}
}

func TestWhiteboardLibraryCallbackURLIsPublicAndGeneric(t *testing.T) {
	t.Parallel()
	server := &Server{cfg: &config.Config{PublicURL: "https://clarin.example"}}
	callback, err := server.whiteboardLibraryCallbackURL()
	if err != nil {
		t.Fatal(err)
	}
	if callback != "https://clarin.example/whiteboards/library-import" {
		t.Fatalf("unexpected callback URL: %s", callback)
	}
}

func TestWhiteboardLibraryImportNotPersistedMapsToUnprocessableEntity(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return whiteboardError(c, repository.ErrWhiteboardLibraryImportNotPersisted)
	})
	response, err := app.Test(httptest.NewRequest(http.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusUnprocessableEntity {
		t.Fatalf("unpersisted library ACK status=%d, want %d", response.StatusCode, fiber.StatusUnprocessableEntity)
	}
}

func TestWhiteboardCommentGuardRejectsOversizedBodyBeforeHandler(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	server := &Server{}
	called := false
	app.Post("/comments", server.guardWhiteboardCommentMutation, func(c *fiber.Ctx) error {
		called = true
		return c.SendStatus(fiber.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodPost, "/comments",
		strings.NewReader(strings.Repeat("x", whiteboardCommentMutationMaxRequestBytes+1)))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusRequestEntityTooLarge || called {
		t.Fatalf("oversized comment reached handler: status=%d called=%v", response.StatusCode, called)
	}
}

func TestWhiteboardLibraryImportGuardRejectsOversizedBodyBeforeHandler(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	server := &Server{}
	called := false
	app.Post("/complete", server.guardWhiteboardLibraryImportMutation, func(c *fiber.Ctx) error {
		called = true
		return c.SendStatus(fiber.StatusNoContent)
	})
	request := httptest.NewRequest(http.MethodPost, "/complete",
		strings.NewReader(strings.Repeat("x", whiteboardLibraryImportCallbackMaxBytes+1)))
	request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusRequestEntityTooLarge || called {
		t.Fatalf("oversized library import mutation reached handler: status=%d called=%v", response.StatusCode, called)
	}
}

func TestBroadcastWhiteboardMessageRoutesCommentsToMembersOnly(t *testing.T) {
	t.Parallel()
	accountID, boardID, userID := uuid.New(), uuid.New(), uuid.New()
	server := &Server{whiteboardRooms: whiteboardcore.NewRoomHub()}
	member := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: userID, UserID: &userID}, Send: make(chan []byte, 1),
	}
	guestID := uuid.New()
	guest := &whiteboardcore.RealtimeClient{
		ID: uuid.New(), AccountID: accountID, BoardID: boardID,
		Actor: whiteboardcore.RealtimeActor{ID: guestID, GuestID: &guestID}, Send: make(chan []byte, 1),
	}
	if err := server.whiteboardRooms.Register(member); err != nil {
		t.Fatal(err)
	}
	if err := server.whiteboardRooms.Register(guest); err != nil {
		t.Fatal(err)
	}

	server.broadcastWhiteboardMessage(accountID, boardID, whiteboardcore.OutgoingMessage{
		Event: whiteboardcore.EventCommentChanged,
		Data:  map[string]any{"action": "created", "body": "solo miembros"},
	}, uuid.Nil)
	select {
	case <-member.Send:
	default:
		t.Fatal("authenticated member did not receive comment event")
	}
	select {
	case payload := <-guest.Send:
		t.Fatalf("comment event reached guest through generic broadcaster: %s", payload)
	default:
	}
}
