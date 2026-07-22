package repository

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestMigratedProgramEventTargetQueryIsAccountScoped(t *testing.T) {
	for _, fragment := range []string{
		"retirement.account_id = p.account_id",
		"retirement.program_id = p.id",
		"p.account_id = $1",
		"p.id = $2",
		"retirement.status = 'migrated'",
	} {
		if !strings.Contains(getMigratedProgramEventTargetQuery, fragment) {
			t.Fatalf("mutation guard query is missing %q", fragment)
		}
	}
}

func TestLegacyProgramEventPipelineValidationIsAccountScopedAtReadTime(t *testing.T) {
	for _, fragment := range []string{"event_pipelines", "account_id = $1", "id = $2"} {
		if !strings.Contains(legacyProgramEventPipelineAccountQuery, fragment) {
			t.Fatalf("legacy pipeline validation query is missing %q", fragment)
		}
	}
}

func TestCoursePersistenceClearsEveryLegacyEventField(t *testing.T) {
	pipelineID := uuid.New()
	now := time.Now()
	location := "Auditorio"
	program := &domain.Program{
		Type:           "course",
		PipelineID:     &pipelineID,
		TagFormula:     "tag:vip",
		TagFormulaMode: "AND",
		TagFormulaType: "advanced",
		EventDate:      &now,
		EventEnd:       &now,
		Location:       &location,
	}
	clearProgramEventFields(program)
	if program.PipelineID != nil || program.TagFormula != "" || program.TagFormulaMode != "" ||
		program.TagFormulaType != "" || program.EventDate != nil || program.EventEnd != nil || program.Location != nil {
		t.Fatalf("course retained event fields: %#v", program)
	}
}
