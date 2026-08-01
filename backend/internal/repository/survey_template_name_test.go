package repository

import (
	"strings"
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestNextSurveyInstanceNameUsesFirstFreeOrdinal(t *testing.T) {
	used := map[string]struct{}{
		domain.SurveyInstanceNameKey("Seguimiento"):     {},
		domain.SurveyInstanceNameKey("Seguimiento · 2"): {},
	}
	if got := nextSurveyInstanceName("Seguimiento", used); got != "Seguimiento · 3" {
		t.Fatalf("unexpected suggestion %q", got)
	}
}

func TestNextSurveyInstanceNameKeepsMaximumLength(t *testing.T) {
	base := strings.Repeat("á", 180)
	used := map[string]struct{}{domain.SurveyInstanceNameKey(base): {}}
	got := nextSurveyInstanceName(base, used)
	if len([]rune(got)) > 180 || !strings.HasSuffix(got, " · 2") {
		t.Fatalf("invalid bounded suggestion %q (%d runes)", got, len([]rune(got)))
	}
}
