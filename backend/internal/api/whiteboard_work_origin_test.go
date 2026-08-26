package api

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func TestWhiteboardHubResponsePublishesDynamicWorkCapability(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve handler source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_handler.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	for _, invariant := range []string{
		"workWhiteboardViewsEnabled := s.workWhiteboardViewsEnabled()",
		"IncludeWork: workWhiteboardViewsEnabled",
		`"work_whiteboard_views_enabled": workWhiteboardViewsEnabled`,
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("whiteboard Hub response lost dynamic Work capability %q", invariant)
		}
	}
}

func TestGenericWhiteboardWorkMutationReturnsExplicitStructuralError(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Patch("/", func(c *fiber.Ctx) error {
		return whiteboardError(c, repository.ErrWhiteboardInheritsWorkAccess)
	})
	response, err := app.Test(httptest.NewRequest(fiber.MethodPatch, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusConflict {
		t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusConflict)
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Code != "whiteboard_inherits_work_access" || whiteboardWriteFailureCode(repository.ErrWhiteboardInheritsWorkAccess) != body.Code {
		t.Fatalf("generic Work mutation code = %q", body.Code)
	}
}

func TestGenericWhiteboardKillSwitchAuthorizesBeforeOriginAndUsesGenericNotFound(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	directory := filepath.Dir(currentFile)
	raw, err := os.ReadFile(filepath.Join(directory, "task_location_view_handler.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) requireWorkWhiteboardOriginEnabled(")
	end := strings.Index(source, "func (s *Server) revokeTaskLocationWhiteboardSockets(")
	if start < 0 || end <= start {
		t.Fatal("generic Work kill-switch middleware source bounds changed")
	}
	body := source[start:end]
	access := strings.Index(body, "s.repos.Whiteboard.RequireAccess(")
	origin := strings.Index(body, "s.repos.Whiteboard.IsWorkOrigin(")
	notFound := strings.Index(body, "whiteboardError(c, repository.ErrWhiteboardNotFound)")
	next := strings.LastIndex(body, "return c.Next()")
	if access < 0 || origin <= access || notFound <= origin || next <= notFound {
		t.Fatal("flag-off generic middleware lost Ver -> origin -> generic 404 -> standalone order")
	}
	if strings.Contains(body, "work_whiteboard_views_disabled") {
		t.Fatal("generic whiteboard middleware exposes the contextual rollout code")
	}

	raw, err = os.ReadFile(filepath.Join(directory, "server.go"))
	if err != nil {
		t.Fatal(err)
	}
	serverSource := string(raw)
	route := `api.Post("/whiteboards/:id/collab-ticket", s.whiteboardCollabAuthMiddleware, s.handleCreateWhiteboardCollabTicket)`
	if !strings.Contains(serverSource, route) {
		t.Fatal("collab-ticket still performs origin discovery before its effective-account authorization")
	}
}

func TestDisabledGenericWorkBoardUsesCanonicalNotFoundEnvelope(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return whiteboardError(c, repository.ErrWhiteboardNotFound)
	})
	response, err := app.Test(httptest.NewRequest(fiber.MethodGet, "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body struct {
		Success bool   `json:"success"`
		Code    string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusNotFound || body.Success || body.Code != "whiteboard_not_found" {
		t.Fatalf("disabled generic envelope = status %d body %#v", response.StatusCode, body)
	}
}

func TestPublicLibraryCallbackReauthorizesBeforeEveryOriginCheck(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve API source directory")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "whiteboard_public_library_handler.go"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(raw)
	start := strings.Index(source, "func (s *Server) handleWhiteboardPublicLibraryCallback(")
	end := strings.Index(source, "func (s *Server) handleGetWhiteboardPublicLibraryImport(")
	if start < 0 || end <= start {
		t.Fatal("public-library callback source bounds changed")
	}
	body := source[start:end]
	firstAccess := strings.Index(body, "s.repos.Whiteboard.RequireActiveAccess(")
	firstOrigin := strings.Index(body, "s.repos.Whiteboard.IsWorkOrigin(")
	firstNotFound := strings.Index(body, "whiteboardError(c, repository.ErrWhiteboardNotFound)")
	lastAccess := strings.LastIndex(body, "s.repos.Whiteboard.RequireActiveAccess(")
	lastOrigin := strings.LastIndex(body, "s.repos.Whiteboard.IsWorkOrigin(")
	lastNotFound := strings.LastIndex(body, "whiteboardError(c, repository.ErrWhiteboardNotFound)")
	if firstAccess < 0 || firstOrigin <= firstAccess || firstNotFound <= firstOrigin ||
		lastAccess <= firstNotFound || lastOrigin <= lastAccess || lastNotFound <= lastOrigin {
		t.Fatal("library callback lost canonical Ver -> origin -> generic 404 on initial and post-fetch gates")
	}
}
