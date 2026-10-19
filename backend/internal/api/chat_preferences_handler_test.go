package api

import (
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestChatCursorRoundTripAndScope(t *testing.T) {
	a, u := uuid.New(), uuid.New()
	scope := chatCursorScope(a, u, "kind=all&pagination=cursor&limit=50")
	if scope != chatCursorScope(a, u, "pagination=cursor&kind=all&cursor=old&limit=100&offset=10") {
		t.Fatal("pagination controls must not change the view scope")
	}
	for _, q := range []string{"kind=group&pagination=cursor", "kind=all&pagination=cursor&search=hello"} {
		if scope == chatCursorScope(a, u, q) {
			t.Fatal("filter must bind cursor")
		}
	}
	if scope == chatCursorScope(a, uuid.New(), "kind=all&pagination=cursor") {
		t.Fatal("actor must bind cursor")
	}
	at := time.Now().UTC().Truncate(time.Microsecond)
	for _, chat := range []*domain.Chat{{ID: uuid.New()}, {ID: uuid.New(), LastMessageAt: &at}, {ID: uuid.New(), IsPinned: true, PinnedAt: &at}} {
		raw := encodeChatListCursor(chat, scope)
		got, err := decodeChatListCursor(raw, scope)
		if err != nil || got.ID != chat.ID || got.Pinned != chat.IsPinned {
			t.Fatalf("cursor roundtrip: %+v %v", got, err)
		}
		if _, err = decodeChatListCursor(raw, "other"); err == nil {
			t.Fatal("different view accepted cursor")
		}
	}
	for _, raw := range []string{"?", strings.Repeat("a", 2049), "e30"} {
		if _, err := decodeChatListCursor(raw, scope); err == nil {
			t.Fatal("invalid cursor accepted")
		}
	}
}

func TestChatPinRejectsMissingIntentBeforeRepository(t *testing.T) {
	s := &Server{}
	for _, body := range []string{`{}`, `{"pinned":null}`, `{"pinned":"yes"}`, `not-json`} {
		app := fiber.New()
		app.Put("/chats/:id/pin", func(c *fiber.Ctx) error {
			c.Locals("account_id", uuid.New())
			c.Locals("user_id", uuid.New())
			return c.Next()
		}, s.handleSetChatPin)
		req := httptest.NewRequest("PUT", "/chats/"+uuid.NewString()+"/pin", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := app.Test(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 400 {
			t.Fatalf("body %s: status %d", body, resp.StatusCode)
		}
	}
}
