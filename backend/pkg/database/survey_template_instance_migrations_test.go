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
