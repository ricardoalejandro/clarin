package api

import (
	"encoding/json"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func TestNormalizeRolePermissionsRejectsUnknownAndDeduplicates(t *testing.T) {
	t.Parallel()
	permissions, invalid := normalizeRolePermissions([]string{" chats ", "chats", "tasks"})
	if invalid != "" || len(permissions) != 2 || permissions[0] != "chats" || permissions[1] != "tasks" {
		t.Fatalf("unexpected normalized permissions=%#v invalid=%q", permissions, invalid)
	}
	if _, invalid := normalizeRolePermissions([]string{"database.admin"}); invalid != "database.admin" {
		t.Fatalf("unknown permission = %q", invalid)
	}
}

func TestWriteAdminRoleMutationErrorIsStableAndSafe(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{name: "name conflict", err: repository.ErrRoleNameTaken, status: fiber.StatusConflict, code: "role_name_taken"},
		{name: "missing or protected role", err: repository.ErrRoleNotFound, status: fiber.StatusNotFound, code: "role_save_failed"},
		{name: "unexpected", err: errors.New("raw database detail"), status: fiber.StatusInternalServerError, code: "role_save_failed"},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error { return writeAdminRoleMutationError(c, test.err) })
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var body map[string]any
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != test.status || body["code"] != test.code || body["error"] == test.err.Error() {
				t.Fatalf("status=%d body=%#v", response.StatusCode, body)
			}
		})
	}
}
