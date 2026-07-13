package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestNormalizeStageDraftsProducesCanonicalLayout(t *testing.T) {
	drafts := []PipelineStageDraft{
		{ClientID: "lost", Name: " Perdida ", Color: "#ef4444", StageType: domain.PipelineStageTypeLost, Position: 30},
		{ClientID: "active", Name: " Nueva ", Color: "", StageType: domain.PipelineStageTypeActive, Position: 10},
		{ClientID: "won", Name: " Ganada ", Color: "#10b981", StageType: domain.PipelineStageTypeWon, Position: 20},
	}

	got, err := normalizeStageDrafts(drafts)
	if err != nil {
		t.Fatalf("normalizeStageDrafts() unexpected error: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 stages, got %d", len(got))
	}
	for i, stage := range got {
		if stage.Position != i {
			t.Fatalf("stage %d has position %d", i, stage.Position)
		}
	}
	if got[0].Name != "Nueva" || got[0].Color == "" || got[0].StageType != domain.PipelineStageTypeActive {
		t.Fatalf("active stage was not normalized: %#v", got[0])
	}
	if got[1].StageType != domain.PipelineStageTypeWon || got[2].StageType != domain.PipelineStageTypeLost {
		t.Fatalf("terminal order is not canonical: %#v", got)
	}
}

func TestNormalizeStageDraftsRejectsInvalidLayouts(t *testing.T) {
	id := uuid.New()
	validTerminalStages := []PipelineStageDraft{
		{ClientID: "won", Name: "Ganada", StageType: domain.PipelineStageTypeWon, Position: 1},
		{ClientID: "lost", Name: "Perdida", StageType: domain.PipelineStageTypeLost, Position: 2},
	}

	tests := []struct {
		name   string
		drafts []PipelineStageDraft
	}{
		{name: "empty", drafts: nil},
		{name: "duplicate names", drafts: append([]PipelineStageDraft{
			{ClientID: "a", Name: " Contactado ", StageType: domain.PipelineStageTypeActive, Position: 0},
			{ClientID: "b", Name: "contactado", StageType: domain.PipelineStageTypeActive, Position: 1},
		}, validTerminalStages...)},
		{name: "duplicate ids", drafts: []PipelineStageDraft{
			{ID: &id, Name: "Nueva", StageType: domain.PipelineStageTypeActive, Position: 0},
			{ID: &id, Name: "Seguimiento", StageType: domain.PipelineStageTypeActive, Position: 1},
			{ClientID: "won", Name: "Ganada", StageType: domain.PipelineStageTypeWon, Position: 2},
			{ClientID: "lost", Name: "Perdida", StageType: domain.PipelineStageTypeLost, Position: 3},
		}},
		{name: "active after won", drafts: []PipelineStageDraft{
			{ClientID: "a", Name: "Nueva", StageType: domain.PipelineStageTypeActive, Position: 0},
			{ClientID: "won", Name: "Ganada", StageType: domain.PipelineStageTypeWon, Position: 1},
			{ClientID: "b", Name: "Seguimiento", StageType: domain.PipelineStageTypeActive, Position: 2},
			{ClientID: "lost", Name: "Perdida", StageType: domain.PipelineStageTypeLost, Position: 3},
		}},
		{name: "two won", drafts: []PipelineStageDraft{
			{ClientID: "a", Name: "Nueva", StageType: domain.PipelineStageTypeActive, Position: 0},
			{ClientID: "won-a", Name: "Ganada", StageType: domain.PipelineStageTypeWon, Position: 1},
			{ClientID: "won-b", Name: "Cerrada", StageType: domain.PipelineStageTypeWon, Position: 2},
			{ClientID: "lost", Name: "Perdida", StageType: domain.PipelineStageTypeLost, Position: 3},
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := normalizeStageDrafts(tt.drafts); err == nil {
				t.Fatal("normalizeStageDrafts() expected error")
			}
		})
	}
}
