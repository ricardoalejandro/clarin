package repository

import (
	"strings"
	"testing"
)

func TestContactRelationTaskCountsAreActorScopedAndFailClosed(t *testing.T) {
	t.Parallel()
	source := readRepositorySource(t, "repository.go")
	for _, invariant := range []string{
		"FindDuplicateGroupsForActor",
		"PreviewMergeContactsForActor",
		"MergeContactsForActor",
		"task.deleted_at IS NULL",
		"$3::boolean AND `+taskActorCanViewSQL(\"task\", \"task_list\", \"$4\")+`",
	} {
		if !strings.Contains(source, invariant) {
			t.Fatalf("contact relation counts lost task privacy invariant %q", invariant)
		}
	}
	if strings.Contains(source, "(SELECT COUNT(*) FROM tasks WHERE account_id = $1 AND contact_id = ANY($2))") {
		t.Fatal("contact relation counts still expose account-wide task totals")
	}
}
