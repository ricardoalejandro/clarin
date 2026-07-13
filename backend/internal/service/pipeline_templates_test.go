package service

import (
	"testing"

	"github.com/naperu/clarin/internal/domain"
)

func TestPipelineTemplatesAreUniqueAndValid(t *testing.T) {
	templates := PipelineTemplates()
	if len(templates) != 3 {
		t.Fatalf("expected 3 pipeline templates, got %d", len(templates))
	}

	seen := make(map[string]struct{}, len(templates))
	for _, template := range templates {
		if template.ID == "" || template.Name == "" || template.Description == "" {
			t.Fatalf("template metadata must be complete: %#v", template)
		}
		if _, duplicate := seen[template.ID]; duplicate {
			t.Fatalf("duplicate template id %q", template.ID)
		}
		seen[template.ID] = struct{}{}
		if err := ValidatePipelineStageDesign(template.Stages); err != nil {
			t.Fatalf("template %q is invalid: %v", template.ID, err)
		}
	}
}

func TestPipelineTemplatesReturnsDefensiveCopy(t *testing.T) {
	first := PipelineTemplates()
	first[0].Name = "mutated"
	first[0].Stages[0].Name = "mutated stage"

	second := PipelineTemplates()
	if second[0].Name == "mutated" || second[0].Stages[0].Name == "mutated stage" {
		t.Fatal("PipelineTemplates leaked mutable catalog state")
	}
}

func TestValidatePipelineStageDesign(t *testing.T) {
	valid := []domain.PipelineTemplateStage{
		{Name: "Nueva", StageType: domain.PipelineStageTypeActive},
		{Name: "Seguimiento", StageType: domain.PipelineStageTypeActive},
		{Name: "Ganada", StageType: domain.PipelineStageTypeWon},
		{Name: "Perdida", StageType: domain.PipelineStageTypeLost},
	}

	tests := []struct {
		name    string
		stages  []domain.PipelineTemplateStage
		wantErr bool
	}{
		{name: "empty pipeline remains configurable", stages: nil, wantErr: false},
		{name: "valid lifecycle", stages: valid, wantErr: false},
		{name: "missing active", stages: valid[2:], wantErr: true},
		{name: "missing won", stages: append([]domain.PipelineTemplateStage{}, valid[0], valid[1], valid[3]), wantErr: true},
		{name: "missing lost", stages: valid[:3], wantErr: true},
		{name: "active after terminal", stages: []domain.PipelineTemplateStage{
			{Name: "Nueva", StageType: domain.PipelineStageTypeActive},
			{Name: "Ganada", StageType: domain.PipelineStageTypeWon},
			{Name: "Seguimiento", StageType: domain.PipelineStageTypeActive},
			{Name: "Perdida", StageType: domain.PipelineStageTypeLost},
		}, wantErr: true},
		{name: "duplicate normalized name", stages: []domain.PipelineTemplateStage{
			{Name: " Nueva oportunidad ", StageType: domain.PipelineStageTypeActive},
			{Name: "nueva   OPORTUNIDAD", StageType: domain.PipelineStageTypeActive},
			{Name: "Ganada", StageType: domain.PipelineStageTypeWon},
			{Name: "Perdida", StageType: domain.PipelineStageTypeLost},
		}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePipelineStageDesign(tt.stages)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidatePipelineStageDesign() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
