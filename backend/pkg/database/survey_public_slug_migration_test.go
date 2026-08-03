package database

import (
	"strings"
	"testing"
)

func TestSurveyPublicSlugReservationMigrationIsPermanentAndIdempotent(t *testing.T) {
	t.Parallel()
	joined := strings.Join(surveyPublicSlugReservationMigrations(), "\n")
	for _, invariant := range []string{
		"CREATE TABLE IF NOT EXISTS survey_public_slug_reservations",
		"slug TEXT PRIMARY KEY",
		"owner_account_id UUID NOT NULL",
		"survey_id UUID NOT NULL",
		"uq_survey_public_slug_active_survey",
		"WHERE retired_at IS NULL",
		"ON CONFLICT (slug) DO NOTHING",
		"survey public slug reservation backfill mismatch",
	} {
		if !strings.Contains(joined, invariant) {
			t.Fatalf("slug reservation migration is missing %q", invariant)
		}
	}
	if strings.Contains(joined, "owner_account_id UUID NOT NULL REFERENCES") || strings.Contains(joined, "survey_id UUID NOT NULL REFERENCES") {
		t.Fatal("historical slug ownership must not cascade away with surveys or accounts")
	}
}
