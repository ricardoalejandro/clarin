package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/repository"
)

func TestSurveyApplicationMutationErrorContract(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{name: "not found", err: pgx.ErrNoRows, wantStatus: fiber.StatusNotFound, wantCode: "survey_instance_not_found"},
		{name: "legacy", err: repository.ErrSurveyDeleteLegacy, wantStatus: fiber.StatusConflict, wantCode: "survey_application_has_history"},
		{name: "responses", err: repository.ErrSurveyDeleteHasResponses, wantStatus: fiber.StatusConflict, wantCode: "survey_application_has_history"},
		{name: "activity", err: repository.ErrSurveyDeleteHasActivity, wantStatus: fiber.StatusConflict, wantCode: "survey_application_has_history"},
		{name: "uploads", err: repository.ErrSurveyDeleteHasUploads, wantStatus: fiber.StatusConflict, wantCode: "survey_application_has_history"},
	} {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error { return surveyApplicationMutationError(c, test.err) })
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != test.wantStatus {
				t.Fatalf("status=%d, want %d", response.StatusCode, test.wantStatus)
			}
			var payload map[string]any
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatal(err)
			}
			if payload["code"] != test.wantCode {
				t.Fatalf("code=%v, want %q", payload["code"], test.wantCode)
			}
		})
	}
}

func TestSurveyArchivedGoneContract(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/", surveyArchivedGone)
	response, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusGone {
		t.Fatalf("status=%d, want %d", response.StatusCode, fiber.StatusGone)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != "survey_archived" {
		t.Fatalf("code=%v, want survey_archived", payload["code"])
	}
}

func TestSurveyRetiredLinkGoneContract(t *testing.T) {
	t.Parallel()
	app := fiber.New()
	app.Get("/", surveyLinkRetiredGone)
	response, err := app.Test(httptest.NewRequest("GET", "/", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != fiber.StatusGone {
		t.Fatalf("status=%d, want %d", response.StatusCode, fiber.StatusGone)
	}
	var payload map[string]any
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != "survey_link_retired" {
		t.Fatalf("code=%v, want survey_link_retired", payload["code"])
	}
}
