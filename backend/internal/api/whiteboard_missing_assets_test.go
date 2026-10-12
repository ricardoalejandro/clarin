package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
)

func TestWhiteboardMissingAssetsRejectionIsExplicit(t *testing.T) {
	err := &repository.WhiteboardMissingAssetsError{FileIDs: []string{"new-image"}}
	app := fiber.New()
	app.Get("/", func(c *fiber.Ctx) error { return whiteboardError(c, err) })
	response, testErr := app.Test(httptest.NewRequest("GET", "/", nil))
	if testErr != nil {
		t.Fatal(testErr)
	}
	defer response.Body.Close()
	var body struct {
		Code    string   `json:"code"`
		FileIDs []string `json:"missing_file_ids"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != fiber.StatusUnprocessableEntity || body.Code != "whiteboard_assets_missing" || len(body.FileIDs) != 1 || body.FileIDs[0] != "new-image" {
		t.Fatalf("unexpected rejection: status=%d body=%+v", response.StatusCode, body)
	}
	if whiteboardWriteFailureCode(err) != body.Code {
		t.Fatal("the operational error code must identify the recoverable asset rejection")
	}
}
