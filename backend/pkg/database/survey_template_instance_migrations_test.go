package database

import (
	"strings"
	"testing"
)

func TestSurveyRecipientIdentityForeignKeysCascadeContactMergeUpdates(t *testing.T) {
	t.Parallel()

	joined := strings.Join(surveyTemplateInstanceMigrations(), "\n")
	for _, constraint := range []string{
		"survey_instance_recipients_program_participant_fkey",
		"survey_instance_recipients_program_contact_fkey",
		"survey_instance_recipients_program_identity_fkey",
	} {
		marker := "ADD CONSTRAINT " + constraint
		position := strings.LastIndex(joined, marker)
		if position < 0 {
			t.Fatalf("migration does not define %s", constraint)
		}
		definition := joined[position:]
		if next := strings.Index(definition, ";"); next >= 0 {
			definition = definition[:next]
		}
		if !strings.Contains(definition, "ON UPDATE CASCADE") {
			t.Fatalf("%s does not preserve recipient identity when a participant/contact is merged", constraint)
		}
	}
}

func TestSurveyRecipientMergeAliasesPreserveInvitationTokens(t *testing.T) {
	t.Parallel()

	joined := strings.Join(surveyTemplateInstanceMigrations(), "\n")
	for _, invariant := range []string{
		"ADD COLUMN IF NOT EXISTS merged_into_recipient_id UUID",
		"survey_instance_recipients_merged_into_fkey",
		"merged_into_recipient_id<>id",
		"idx_survey_instance_recipients_merged_into",
	} {
		if !strings.Contains(joined, invariant) {
			t.Fatalf("survey recipient alias migration is missing %q", invariant)
		}
	}
}

func TestSurveyAnalyticsSessionsAndMeasurementSnapshotsAreAccountScoped(t *testing.T) {
	t.Parallel()
	joined := strings.Join(surveyTemplateInstanceMigrations(), "\n")
	for _, invariant := range []string{
		"analytics_tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
		"measurement_config JSONB NOT NULL",
		"measurement_signature TEXT NOT NULL",
		"CREATE TABLE IF NOT EXISTS survey_response_sessions",
		"FOREIGN KEY (account_id,survey_id) REFERENCES surveys(account_id,id)",
		"CREATE TABLE IF NOT EXISTS survey_response_session_questions",
		"uq_survey_response_sessions_recipient",
		"idx_survey_response_sessions_funnel",
	} {
		if !strings.Contains(joined, invariant) {
			t.Fatalf("survey measurement migration is missing %q", invariant)
		}
	}
}

func TestSurveyBrandingMediaReferencesAreAccountScoped(t *testing.T) {
	t.Parallel()
	joined := strings.Join(surveyTemplateInstanceMigrations(), "\n")
	for _, invariant := range []string{
		"CREATE TABLE IF NOT EXISTS survey_branding_asset_refs",
		"FOREIGN KEY (account_id,template_id) REFERENCES survey_templates(account_id,id)",
		"FOREIGN KEY (account_id,survey_id) REFERENCES surveys(account_id,id)",
		"FOREIGN KEY (account_id,media_asset_id) REFERENCES media_assets(account_id,id)",
		"slot IN ('logo','background')",
	} {
		if !strings.Contains(joined, invariant) {
			t.Fatalf("survey branding reference migration is missing %q", invariant)
		}
	}
}
