package api

import (
	"bytes"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"log"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDocumentFailureLogsOnlyCategory(t *testing.T) {
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	defer log.SetOutput(previous)
	s := &Server{}
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error {
		return s.documentFailure(c, &pgconn.PgError{Code: "23505", Message: "personal-marker", Detail: "private-value"}, uuid.Nil, uuid.Nil)
	})
	response, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 500 || !strings.Contains(output.String(), "postgres:23505") || strings.Contains(output.String(), "personal-marker") || strings.Contains(output.String(), "private-value") {
		t.Fatal("operational log exposed detail or lost category")
	}
}
func TestDocumentOversizedCursorStopsBeforeRepository(t *testing.T) {
	s := &Server{}
	app := fiber.New(fiber.Config{ReadBufferSize: 8192})
	app.Get("/", func(c *fiber.Ctx) error { c.Locals("account_id", uuid.New()); return s.handleListDocumentTemplates(c) })
	response, err := app.Test(httptest.NewRequest("GET", "/?cursor="+strings.Repeat("a", 4097), nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatalf("cursor status %d", response.StatusCode)
	}
}
