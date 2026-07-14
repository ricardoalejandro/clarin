package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5/pgconn"
)

func adminUserErrorResponse(t *testing.T, err error) (int, map[string]any) {
	t.Helper()
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error { return writeAdminUserMutationError(c, err) })
	response, requestErr := app.Test(httptest.NewRequest("GET", "/", nil))
	if requestErr != nil {
		t.Fatalf("request failed: %v", requestErr)
	}
	defer response.Body.Close()
	var body map[string]any
	if decodeErr := json.NewDecoder(response.Body).Decode(&body); decodeErr != nil {
		t.Fatalf("decode response: %v", decodeErr)
	}
	return response.StatusCode, body
}

func TestWriteAdminUserMutationErrorUsernameConflict(t *testing.T) {
	err := fmt.Errorf("wrapped: %w", &pgconn.PgError{
		Code:           "23505",
		ConstraintName: "users_username_normalized_key",
		Message:        "duplicate key value violates unique constraint",
	})
	status, body := adminUserErrorResponse(t, err)
	if status != fiber.StatusConflict {
		t.Fatalf("status = %d, want %d", status, fiber.StatusConflict)
	}
	if body["code"] != "username_taken" || body["field"] != "username" {
		t.Fatalf("unexpected body: %#v", body)
	}
	if body["error"] != "Este nombre de usuario ya está en uso." {
		t.Fatalf("unexpected safe message: %#v", body["error"])
	}
}

func TestWriteAdminUserMutationErrorEmailConflict(t *testing.T) {
	status, body := adminUserErrorResponse(t, &pgconn.PgError{
		Code:           "23505",
		ConstraintName: "users_email_normalized_key",
	})
	if status != fiber.StatusConflict || body["code"] != "email_taken" || body["field"] != "email" {
		t.Fatalf("unexpected response: status=%d body=%#v", status, body)
	}
}

func TestWriteAdminUserMutationErrorHidesUnexpectedDetails(t *testing.T) {
	status, body := adminUserErrorResponse(t, errors.New("raw database detail"))
	if status != fiber.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", status, fiber.StatusInternalServerError)
	}
	if body["code"] != "user_save_failed" || body["error"] == "raw database detail" {
		t.Fatalf("unexpected response: %#v", body)
	}
}
