package api

import (
	"errors"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestWriteQuickReplyErrorStatusAndCode(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "validation", err: service.ErrQuickReplyValidation, wantStatus: fiber.StatusUnprocessableEntity, wantCode: "invalid_quick_reply"},
		{name: "invalid media", err: repository.ErrQuickReplyInvalidMedia, wantStatus: fiber.StatusUnprocessableEntity, wantCode: "invalid_quick_reply"},
		{name: "not found", err: repository.ErrQuickReplyNotFound, wantStatus: fiber.StatusNotFound, wantCode: "quick_reply_not_found"},
		{name: "version conflict", err: repository.ErrQuickReplyConflict, wantStatus: fiber.StatusConflict, wantCode: "quick_reply_conflict"},
		{name: "shortcut conflict", err: repository.ErrQuickReplyShortcut, wantStatus: fiber.StatusConflict, wantCode: "quick_reply_shortcut_exists"},
		{name: "internal", err: errors.New("database details"), wantStatus: fiber.StatusInternalServerError, wantCode: "quick_reply_failed"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error { return writeQuickReplyError(c, test.err) })
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.StatusCode, test.wantStatus)
			}
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatalf("read response: %v", err)
			}
			if !containsJSONCode(string(body), test.wantCode) {
				t.Fatalf("body = %s, want code %q", body, test.wantCode)
			}
		})
	}
}

func containsJSONCode(body, code string) bool {
	return strings.Contains(body, "\"code\":\""+code+"\"")
}

func TestQuickReplyCursorRoundTripAndContext(t *testing.T) {
	reply := &domain.QuickReply{ID: uuid.New(), Shortcut: "Bienvenida-Ñ"}
	filter := repository.QuickReplyListFilter{Search: "saludo", Kind: "media", Limit: 50}
	raw := encodeQuickReplyCursor(reply, filter)
	if raw == "" {
		t.Fatal("encodeQuickReplyCursor() returned an empty cursor")
	}

	decoded, err := decodeQuickReplyCursor(raw)
	if err != nil {
		t.Fatalf("decodeQuickReplyCursor() error = %v", err)
	}
	if decoded.ID != reply.ID || decoded.Shortcut != "bienvenida-ñ" || decoded.Query != "saludo" || decoded.Kind != "media" {
		t.Fatalf("decoded cursor = %#v", decoded)
	}
}

func TestParseQuickReplyListFilter(t *testing.T) {
	reply := &domain.QuickReply{ID: uuid.New(), Shortcut: "datos"}
	rawCursor := encodeQuickReplyCursor(reply, repository.QuickReplyListFilter{Search: "registro", Kind: "text"})

	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		filter, err := parseQuickReplyListFilter(c)
		if err != nil {
			return err
		}
		if filter.Search != "registro" || filter.Kind != "text" || filter.Limit != 80 || filter.AfterShortcut != "datos" || filter.AfterID != reply.ID {
			t.Fatalf("filter = %#v", filter)
		}
		return c.SendStatus(fiber.StatusNoContent)
	})

	response, err := app.Test(httptest.NewRequest("GET", "/?query=registro&kind=text&limit=80&cursor="+rawCursor, nil))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusNoContent {
		t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusNoContent)
	}
}

func TestParseQuickReplyListFilterRejectsInvalidValues(t *testing.T) {
	tests := []string{
		"/?kind=unknown",
		"/?limit=0",
		"/?limit=201",
		"/?cursor=not-base64",
	}
	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error {
				if _, err := parseQuickReplyListFilter(c); !errors.Is(err, errInvalidQuickReplyListFilter) {
					t.Fatalf("error = %v, want errInvalidQuickReplyListFilter", err)
				}
				return c.SendStatus(fiber.StatusBadRequest)
			})
			response, err := app.Test(httptest.NewRequest("GET", target, nil))
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != fiber.StatusBadRequest {
				t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusBadRequest)
			}
		})
	}
}

func TestParseQuickReplyListFilterRejectsCursorFromAnotherQuery(t *testing.T) {
	reply := &domain.QuickReply{ID: uuid.New(), Shortcut: "datos"}
	rawCursor := encodeQuickReplyCursor(reply, repository.QuickReplyListFilter{Search: "registro", Kind: "all"})
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		if _, err := parseQuickReplyListFilter(c); !errors.Is(err, errInvalidQuickReplyListFilter) {
			t.Fatalf("error = %v, want errInvalidQuickReplyListFilter", err)
		}
		return c.SendStatus(fiber.StatusBadRequest)
	})
	response, err := app.Test(httptest.NewRequest("GET", "/?query=otro&kind=all&cursor="+rawCursor, nil))
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.StatusCode, fiber.StatusBadRequest)
	}
}
