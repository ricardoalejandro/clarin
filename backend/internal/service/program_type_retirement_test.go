package service

import (
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func stringPointer(value string) *string { return &value }

func TestCreateProgramRejectsRetiredEventSubtypeBeforePersistence(t *testing.T) {
	service := &ProgramService{}
	pipelineID := uuid.New()
	err := service.CreateProgram(t.Context(), &domain.Program{
		Name:       "Evento legado",
		Type:       "event",
		PipelineID: &pipelineID,
	})
	if !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected retired event subtype to be an input error, got %v", err)
	}
}

func TestCreateProgramRejectsUnknownSubtypeBeforePersistence(t *testing.T) {
	service := &ProgramService{}
	err := service.CreateProgram(t.Context(), &domain.Program{Name: "Taller", Type: "workshop"})
	if !errors.Is(err, ErrProgramInput) {
		t.Fatalf("expected unknown subtype to be an input error, got %v", err)
	}
}

func TestCourseProgramRejectsLegacyEventFieldsBeforePersistence(t *testing.T) {
	pipelineID := uuid.New()
	now := time.Now()
	tests := []struct {
		name   string
		mutate func(*domain.Program)
	}{
		{name: "pipeline", mutate: func(program *domain.Program) { program.PipelineID = &pipelineID }},
		{name: "formula", mutate: func(program *domain.Program) { program.TagFormula = "tag:vip" }},
		{name: "formula mode", mutate: func(program *domain.Program) { program.TagFormulaMode = "AND" }},
		{name: "formula type", mutate: func(program *domain.Program) { program.TagFormulaType = "advanced" }},
		{name: "event date", mutate: func(program *domain.Program) { program.EventDate = &now }},
		{name: "event end", mutate: func(program *domain.Program) { program.EventEnd = &now }},
		{name: "location", mutate: func(program *domain.Program) { program.Location = stringPointer("Auditorio") }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			program := &domain.Program{Name: "Grupo de clases", Type: "course"}
			test.mutate(program)
			service := &ProgramService{}
			if err := service.CreateProgram(t.Context(), program); !errors.Is(err, ErrProgramInput) {
				t.Fatalf("expected legacy event field to be rejected, got %v", err)
			}
		})
	}
}

func TestCourseProgramNormalizesHarmlessHistoricalFormulaDefaults(t *testing.T) {
	program := &domain.Program{
		Name:           "Grupo de clases",
		Type:           "course",
		TagFormulaMode: "OR",
		TagFormulaType: "simple",
		Location:       stringPointer("  "),
	}
	if err := normalizeCourseProgramEventFields(program); err != nil {
		t.Fatalf("historical defaults should be normalized: %v", err)
	}
	if program.TagFormulaMode != "" || program.TagFormulaType != "" || program.Location != nil {
		t.Fatalf("legacy fields were not cleared: %#v", program)
	}
}
