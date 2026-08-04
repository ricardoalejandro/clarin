package api

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func TestSurveyApplicationCursorAndLimitContract(t *testing.T) {
	cursor := &repository.SurveyApplicationCursor{
		CreatedAt: time.Date(2026, 8, 3, 1, 2, 3, 0, time.UTC),
		ID:        uuid.MustParse("20000000-0000-0000-0000-000000000001"),
	}
	decoded, err := decodeSurveyApplicationCursor(encodeSurveyApplicationCursor(cursor))
	if err != nil || decoded.ID != cursor.ID || !decoded.CreatedAt.Equal(cursor.CreatedAt) {
		t.Fatalf("unexpected cursor=%#v err=%v", decoded, err)
	}
	if _, err := decodeSurveyApplicationCursor("broken"); !errors.Is(err, errInvalidSurveyApplicationPage) {
		t.Fatalf("invalid cursor should fail, got %v", err)
	}
	for _, raw := range []string{"0", "201", "nope"} {
		if _, err := parseSurveyApplicationLimit(raw); !errors.Is(err, errInvalidSurveyApplicationPage) {
			t.Fatalf("limit %q should fail, got %v", raw, err)
		}
	}
}
