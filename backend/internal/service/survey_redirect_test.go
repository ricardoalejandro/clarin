package service

import (
	"errors"
	"testing"
)

func TestNormalizeSurveyRedirectURL(t *testing.T) {
	t.Parallel()

	valid := map[string]string{
		"":                                 "",
		"  https://naperu.cloud/gracias  ": "https://naperu.cloud/gracias",
		"HTTP://example.com/fin?q=1#ok":    "http://example.com/fin?q=1#ok",
	}
	for input, expected := range valid {
		input, expected := input, expected
		t.Run("valid_"+expected, func(t *testing.T) {
			t.Parallel()
			actual, err := NormalizeSurveyRedirectURL(input)
			if err != nil {
				t.Fatalf("valid redirect rejected: %v", err)
			}
			if actual != expected {
				t.Fatalf("redirect=%q, want %q", actual, expected)
			}
		})
	}

	invalid := []string{
		"javascript:alert(document.domain)",
		"data:text/html,<script>alert(1)</script>",
		"//attacker.invalid/path",
		"/ruta-relativa",
		"https://usuario:clave@example.com/fin",
		"mailto:persona@example.com",
		"https:///sin-host",
	}
	for _, input := range invalid {
		input := input
		t.Run("invalid", func(t *testing.T) {
			t.Parallel()
			if value, err := NormalizeSurveyRedirectURL(input); !errors.Is(err, ErrSurveyRedirectURLInvalid) || value != "" {
				t.Fatalf("redirect %q returned value=%q error=%v", input, value, err)
			}
			if value := SafeSurveyRedirectURL(input); value != "" {
				t.Fatalf("historical unsafe redirect leaked as %q", value)
			}
		})
	}
}
