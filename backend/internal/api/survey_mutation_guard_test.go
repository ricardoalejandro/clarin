package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func TestRawSurveyMutationEndpointsRequireTemplates(t *testing.T) {
	server := &Server{}
	tests := []struct {
		name string
		path string
		body string
		bind func(*fiber.App)
	}{
		{
			name: "create",
			path: "/api/surveys",
			body: `{"name":"Encuesta cruda"}`,
			bind: func(app *fiber.App) { app.Post("/api/surveys", server.handleCreateSurvey) },
		},
		{
			name: "duplicate",
			path: "/api/surveys/" + uuid.NewString() + "/duplicate",
			body: `{}`,
			bind: func(app *fiber.App) { app.Post("/api/surveys/:id/duplicate", server.handleDuplicateSurvey) },
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			app := fiber.New()
			test.bind(app)
			request := httptest.NewRequest(http.MethodPost, test.path, strings.NewReader(test.body))
			request.Header.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
			response, err := app.Test(request)
			if err != nil {
				t.Fatalf("request failed: %v", err)
			}
			defer response.Body.Close()
			if response.StatusCode != fiber.StatusConflict {
				t.Fatalf("status=%d, want %d", response.StatusCode, fiber.StatusConflict)
			}
			var payload struct {
				Code  string `json:"code"`
				Error string `json:"error"`
			}
			if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if payload.Code != "survey_templates_required" || payload.Error != repository.ErrRawSurveyMutationDisabled.Error() {
				t.Fatalf("unexpected payload: %+v", payload)
			}
		})
	}
}
