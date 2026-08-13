package repository

import (
	"strings"
	"testing"
)

func TestInteractionReadsKeepAccountScopeAndCanonicalAuthorFallback(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "repository.go")
	authorFallback := "COALESCE(NULLIF(BTRIM(u.display_name), ''), NULLIF(BTRIM(u.username), ''), NULLIF(BTRIM(u.email), ''))"

	if got := strings.Count(source, authorFallback); got < 5 {
		t.Fatalf("interaction repository author fallback appears %d times, want at least 5", got)
	}
	for _, predicate := range []string{
		"WHERE i.account_id = $1 AND i.participant_id = $2",
		"WHERE i.account_id = $1 AND i.contact_id = $2",
		"WHERE i.account_id = $1 AND i.event_id = $2",
		"WHERE i.account_id = $1 AND i.lead_id = $2",
	} {
		if !strings.Contains(source, predicate) {
			t.Fatalf("interaction read lost account scope %q", predicate)
		}
	}
	if strings.Count(source, "COALESCE(i.source_label, '')") < 4 {
		t.Fatal("interaction reads must preserve source_label for every CRM scope")
	}
}

func TestContactProfileAuthorUsesCreatorIdentityAcrossAccountMemberships(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "contact_profile_repository.go")

	if strings.Contains(source, "u.id=i.created_by AND u.account_id=i.account_id") {
		t.Fatal("created_by lookup must not depend on the user's primary account")
	}
	for _, invariant := range []string{
		"LEFT JOIN users u ON u.id=i.created_by",
		"NULLIF(BTRIM(u.display_name),'')",
		"NULLIF(BTRIM(u.username),'')",
		"NULLIF(BTRIM(u.email),'')",
		"WHERE i.account_id=$1",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("contact history author contract lost %q", invariant)
		}
	}
}
