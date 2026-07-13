package service

import (
	"fmt"
	"strings"

	"github.com/naperu/clarin/internal/domain"
)

var pipelineTemplateCatalog = []domain.PipelineTemplate{
	{
		ID:          "simple",
		Name:        "Pipeline simple",
		Description: "Una ruta breve para equipos que quieren empezar rápido.",
		Stages: []domain.PipelineTemplateStage{
			{Name: "Nuevo", Color: "#6366F1", StageType: domain.PipelineStageTypeActive},
			{Name: "En seguimiento", Color: "#F59E0B", StageType: domain.PipelineStageTypeActive},
			{Name: "Ganado", Color: "#10B981", StageType: domain.PipelineStageTypeWon},
			{Name: "Perdido", Color: "#EF4444", StageType: domain.PipelineStageTypeLost},
		},
	},
	{
		ID:          "standard-sales",
		Name:        "Ventas estándar",
		Description: "Calificación, propuesta y negociación para un proceso comercial completo.",
		Stages: []domain.PipelineTemplateStage{
			{Name: "Leads entrantes", Color: "#6366F1", StageType: domain.PipelineStageTypeActive},
			{Name: "Contactado", Color: "#0EA5E9", StageType: domain.PipelineStageTypeActive},
			{Name: "Calificado", Color: "#8B5CF6", StageType: domain.PipelineStageTypeActive},
			{Name: "Propuesta enviada", Color: "#F59E0B", StageType: domain.PipelineStageTypeActive},
			{Name: "Negociación", Color: "#F97316", StageType: domain.PipelineStageTypeActive},
			{Name: "Ganado", Color: "#10B981", StageType: domain.PipelineStageTypeWon},
			{Name: "Perdido", Color: "#EF4444", StageType: domain.PipelineStageTypeLost},
		},
	},
	{
		ID:          "enrollment-services",
		Name:        "Inscripciones y servicios",
		Description: "Pensada para cursos, eventos, programas y servicios con pago o matrícula.",
		Stages: []domain.PipelineTemplateStage{
			{Name: "Nuevo interesado", Color: "#6366F1", StageType: domain.PipelineStageTypeActive},
			{Name: "Contactado", Color: "#0EA5E9", StageType: domain.PipelineStageTypeActive},
			{Name: "Interesado calificado", Color: "#8B5CF6", StageType: domain.PipelineStageTypeActive},
			{Name: "Preinscripción", Color: "#F59E0B", StageType: domain.PipelineStageTypeActive},
			{Name: "Pendiente de pago", Color: "#F97316", StageType: domain.PipelineStageTypeActive},
			{Name: "Inscrito", Color: "#10B981", StageType: domain.PipelineStageTypeWon},
			{Name: "No continúa", Color: "#EF4444", StageType: domain.PipelineStageTypeLost},
		},
	},
}

// PipelineTemplates returns a defensive copy so request code cannot mutate the
// process-wide catalog.
func PipelineTemplates() []domain.PipelineTemplate {
	result := make([]domain.PipelineTemplate, len(pipelineTemplateCatalog))
	for i, template := range pipelineTemplateCatalog {
		result[i] = template
		result[i].Stages = append([]domain.PipelineTemplateStage(nil), template.Stages...)
	}
	return result
}

func FindPipelineTemplate(id string) (*domain.PipelineTemplate, bool) {
	id = strings.TrimSpace(id)
	for _, template := range pipelineTemplateCatalog {
		if template.ID == id {
			copy := template
			copy.Stages = append([]domain.PipelineTemplateStage(nil), template.Stages...)
			return &copy, true
		}
	}
	return nil, false
}

// ValidatePipelineStageDesign protects the lifecycle invariants shared by
// templates, manual creation and the full layout editor.
func ValidatePipelineStageDesign(stages []domain.PipelineTemplateStage) error {
	if len(stages) == 0 {
		return nil // An unconfigured pipeline is allowed until the wizard is completed.
	}
	active, won, lost := 0, 0, 0
	seenNames := make(map[string]struct{}, len(stages))
	phase := 0 // active -> won -> lost
	for i, stage := range stages {
		name := normalizePipelineStageName(stage.Name)
		if name == "" {
			return fmt.Errorf("la etapa %d necesita un nombre", i+1)
		}
		if _, exists := seenNames[name]; exists {
			return fmt.Errorf("el nombre de etapa %q está repetido", strings.TrimSpace(stage.Name))
		}
		seenNames[name] = struct{}{}
		switch stage.StageType {
		case domain.PipelineStageTypeActive:
			if phase != 0 {
				return fmt.Errorf("las etapas activas deben estar antes de Ganado y Perdido")
			}
			active++
		case domain.PipelineStageTypeWon:
			if phase > 1 {
				return fmt.Errorf("Ganado debe estar antes de Perdido")
			}
			phase = 1
			won++
		case domain.PipelineStageTypeLost:
			phase = 2
			lost++
		default:
			return fmt.Errorf("tipo de etapa inválido: %q", stage.StageType)
		}
	}
	if active == 0 || won != 1 || lost != 1 {
		return fmt.Errorf("el pipeline necesita al menos una etapa activa, una Ganado y una Perdido")
	}
	return nil
}

func normalizePipelineStageName(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}
