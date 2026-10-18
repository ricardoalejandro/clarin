package api

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"net/http/httptest"
	"testing"
)

func TestProgramAvatarRevisionIsExplicitAndBounded(t *testing.T) {
	for _, value := range []string{"", " ", "-1", "1.2", "9223372036854775808", "no"} {
		if _, err := parseProgramAvatarRevision(value); err == nil {
			t.Fatalf("accepted invalid revision %q", value)
		}
	}
	for _, value := range []string{"0", "1", "9223372036854775807"} {
		if _, err := parseProgramAvatarRevision(value); err != nil {
			t.Fatalf("rejected revision %q: %v", value, err)
		}
	}
}

func TestProgramInactiveReturnsActionableConflict(t *testing.T) {
	app := fiber.New()
	app.Post("/", programInactiveAPIError)
	response, err := app.Test(httptest.NewRequest("POST", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(response.Body).Decode(&body)
	if response.StatusCode != 409 || body["code"] != "PROGRAM_NOT_ACTIVE" {
		t.Fatalf("unexpected response %d %#v", response.StatusCode, body)
	}
}
