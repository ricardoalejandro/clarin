package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestResolveProgramTypeForUpdateKeepsExistingType(t *testing.T) {
	for _, requested := range []string{"", "course", " course "} {
		got, err := resolveProgramTypeForUpdate("course", requested)
		if err != nil || got != "course" {
			t.Fatalf("requested %q: got %q, %v", requested, got, err)
		}
	}

	got, err := resolveProgramTypeForUpdate("event", "")
	if err != nil || got != "event" {
		t.Fatalf("legacy event update must retain its type: got %q, %v", got, err)
	}
}

func TestResolveProgramTypeForUpdateRejectsConversions(t *testing.T) {
	for _, test := range []struct {
		existing  string
		requested string
	}{
		{existing: "course", requested: "event"},
		{existing: "event", requested: "course"},
	} {
		if _, err := resolveProgramTypeForUpdate(test.existing, test.requested); err == nil {
			t.Fatalf("expected %s -> %s to be rejected", test.existing, test.requested)
		}
	}
}

func TestMigratedProgramMutationGuardBlocksEveryWriteAndKeepsReads(t *testing.T) {
	accountID, programID, eventID := uuid.New(), uuid.New(), uuid.New()
	lookupCalls := 0
	lookup := func(_ context.Context, gotAccountID, gotProgramID uuid.UUID) (*uuid.UUID, bool, error) {
		lookupCalls++
		if gotAccountID != accountID || gotProgramID != programID {
			t.Fatalf("guard used wrong account/program: %s %s", gotAccountID, gotProgramID)
		}
		return &eventID, true, nil
	}

	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account_id", accountID)
		return c.Next()
	})
	app.Use("/:id", guardMigratedProgramMutations(lookup))
	app.All("/:id/children", func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		response, err := app.Test(httptest.NewRequest(method, "/"+programID.String()+"/children", nil))
		if err != nil {
			t.Fatalf("%s request failed: %v", method, err)
		}
		if response.StatusCode != fiber.StatusConflict {
			t.Fatalf("%s status = %d, want 409", method, response.StatusCode)
		}
		var payload struct {
			Code            string    `json:"code"`
			MigratedEventID uuid.UUID `json:"migrated_event_id"`
		}
		if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
			t.Fatalf("decode %s response: %v", method, err)
		}
		_ = response.Body.Close()
		if payload.Code != "PROGRAM_EVENT_MIGRATED" || payload.MigratedEventID != eventID {
			t.Fatalf("unexpected %s payload: %#v", method, payload)
		}
	}

	readResponse, err := app.Test(httptest.NewRequest(http.MethodGet, "/"+programID.String()+"/children", nil))
	if err != nil {
		t.Fatalf("GET request failed: %v", err)
	}
	_ = readResponse.Body.Close()
	if readResponse.StatusCode != fiber.StatusNoContent {
		t.Fatalf("GET status = %d, want 204", readResponse.StatusCode)
	}
	if lookupCalls != 4 {
		t.Fatalf("lookup calls = %d, want exactly the four writes", lookupCalls)
	}
}
