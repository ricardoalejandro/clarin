package service

import (
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestNormalizeSurveyTextAnswerLimit(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name      string
		limit     int
		wantLimit int
	}{
		{name: "defaults", wantLimit: 25},
		{name: "caps page", limit: 500, wantLimit: 100},
		{name: "keeps bounded page", limit: 10, wantLimit: 10},
	} {
		t.Run(test.name, func(t *testing.T) {
			if limit := normalizeSurveyTextAnswerLimit(test.limit); limit != test.wantLimit {
				t.Fatalf("limit=%d, want %d", limit, test.wantLimit)
			}
		})
	}
}

func TestSurveyTextAnswerCursorRoundTripAndRejectsTampering(t *testing.T) {
	t.Parallel()
	completedAt := time.Date(2026, 8, 1, 12, 30, 45, 123, time.FixedZone("PET", -5*60*60))
	responseID := uuid.New()
	cursor := encodeSurveyTextAnswerCursor(completedAt, responseID)
	decodedAt, decodedID, err := decodeSurveyTextAnswerCursor(cursor)
	if err != nil || decodedAt == nil || decodedID == nil {
		t.Fatalf("valid cursor rejected: %v", err)
	}
	if !decodedAt.Equal(completedAt) || *decodedID != responseID {
		t.Fatalf("cursor round trip mismatch: %v %v", decodedAt, decodedID)
	}
	if _, _, err := decodeSurveyTextAnswerCursor(cursor + "invalid"); err == nil {
		t.Fatal("tampered cursor was accepted")
	}
}
