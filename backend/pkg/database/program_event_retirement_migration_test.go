package database

import (
	"slices"
	"testing"
)

func TestLegacyProgramEventBlockReasonsAreConservative(t *testing.T) {
	reasons := legacyProgramEventBlockReasons(legacyProgramEventSource{
		Status:         "active",
		TagFormula:     "tag:vip",
		TagFormulaType: "advanced",
		HasFolder:      true,
		HasSchedule:    true,
	}, legacyProgramEventActivity{
		Sessions:          1,
		Transfers:         1,
		InvalidContacts:   1,
		InvalidStageLinks: 1,
	})
	for _, want := range []string{"program_folder", "program_schedule", "advanced_tag_formula", "sessions", "participant_transfers", "invalid_participant_contacts", "participant_stage_mismatch"} {
		if !slices.Contains(reasons, want) {
			t.Fatalf("expected reason %q in %#v", want, reasons)
		}
	}
}

func TestLegacyProgramEventStatusMapping(t *testing.T) {
	tests := map[string]string{
		"active":    "active",
		"completed": "completed",
		"archived":  "cancelled",
	}
	for source, want := range tests {
		if got := legacyProgramEventStatus(source); got != want {
			t.Fatalf("legacyProgramEventStatus(%q) = %q, want %q", source, got, want)
		}
	}
}
