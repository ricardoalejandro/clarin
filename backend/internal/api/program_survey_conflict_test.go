package api

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/naperu/clarin/internal/repository"
	"github.com/naperu/clarin/internal/service"
)

func TestProgramSurveyConflictContracts(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		survey bool
		code   string
	}{
		{"program history", repository.ErrProgramHasDependencies, false, "PROGRAM_HAS_DEPENDENCIES"},
		{"repository legacy", repository.ErrProgramLegacyProtected, false, "LEGACY_EVENT_PROGRAM_PROTECTED"},
		{"service legacy", service.ErrProgramInput, false, "LEGACY_EVENT_PROGRAM_PROTECTED"},
		{"template revision", repository.ErrSurveyTemplateRevisionConflict, true, "survey_template_revision_conflict"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			app.Get("/", func(c *fiber.Ctx) error {
				wrapped := fmt.Errorf("operation: %w", test.err)
				if test.survey {
					return surveyTemplateError(c, wrapped)
				}
				return programDeletionError(c, wrapped)
			})
			response, err := app.Test(httptest.NewRequest("GET", "/", nil))
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			var data map[string]any
			if err := json.NewDecoder(response.Body).Decode(&data); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 409 || data["code"] != test.code || data["error"] == "" {
				t.Fatalf("status=%d body=%v", response.StatusCode, data)
			}
		})
	}
}
