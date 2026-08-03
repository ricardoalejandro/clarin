package mcp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestLeadAnalysisTaskScopeIsActorScopedAndFailClosed(t *testing.T) {
	t.Parallel()
	join, predicate := leadAnalysisTaskScopeSQL("candidate", "candidate_list", "$7", true)
	for _, invariant := range []string{
		"JOIN task_lists candidate_list",
		"candidate.deleted_at IS NULL",
		"task_access_grants",
		"task_environment_grants",
		"active_environment.archived_at IS NULL",
	} {
		if !strings.Contains(join+predicate, invariant) {
			t.Fatalf("authorized task scope lost %q: join=%s predicate=%s", invariant, join, predicate)
		}
	}
	deniedJoin, deniedPredicate := leadAnalysisTaskScopeSQL("candidate", "candidate_list", "", false)
	if deniedJoin != "" || !strings.Contains(deniedPredicate, "candidate.deleted_at IS NULL") || !strings.Contains(deniedPredicate, "AND FALSE") {
		t.Fatalf("task scope without an actor was not fail-closed: join=%s predicate=%s", deniedJoin, deniedPredicate)
	}
}

func TestEveryLegacyLeadAnalysisTaskSignalUsesCanonicalScope(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve lead-analysis source")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(currentFile), "lead_analysis_tools.go"))
	if err != nil {
		t.Fatalf("read lead-analysis source: %v", err)
	}
	source := string(raw)
	// Definition plus overview, report base and export callers.
	if strings.Count(source, "leadAnalysisTaskScopeSQL(") < 4 {
		t.Fatal("one or more legacy lead-analysis task surfaces bypass the canonical Work scope")
	}
	if strings.Count(source, `"task_data_included"`) < 3 {
		t.Fatal("lead-analysis responses do not disclose when task signals are permission-filtered")
	}
}
