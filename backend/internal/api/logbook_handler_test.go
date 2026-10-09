package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/repository"
)

func TestLogbookErrorsExposeSafeActionableResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
		text   string
	}{
		{"hidden hierarchy", fmt.Errorf("capture lookup: %w", pgx.ErrNoRows), 404, "", "no encontrada"},
		{"closed event", repository.ErrEventMembershipFrozen, 409, "EVENT_MEMBERSHIP_FROZEN", ""},
		{"retained notes conflict", repository.ErrLogbookNotesOutsideSnapshot, 409, "LOGBOOK_NOTES_OUTSIDE_SNAPSHOT", "No se aplicó la recaptura"},
		{"invalid date or status", repository.ErrLogbookInvalid, 422, "", "no es válido"},
		{"date collision", fmt.Errorf("update: %w", &pgconn.PgError{Code: "23505", Detail: "private database detail"}), 409, "", "Ya existe"},
		{"database unavailable", errors.New("private database detail"), 500, "", "No se pudo guardar"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			app := fiber.New()
			app.Post("/logbook", func(c *fiber.Ctx) error { return writeLogbookError(c, tc.err) })
			response, err := app.Test(httptest.NewRequest("POST", "/logbook", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				t.Fatal(err)
			}
			var data struct {
				Code  string `json:"code"`
				Error string `json:"error"`
			}
			if err := json.Unmarshal(body, &data); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status || data.Code != tc.code || !strings.Contains(data.Error, tc.text) || strings.Contains(string(body), "private database detail") {
				t.Fatalf("unexpected safe error contract: HTTP %d %s", response.StatusCode, body)
			}
		})
	}
}
