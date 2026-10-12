package repository

import (
	"context"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

var ErrEventStageTemplateInUse = errors.New("Las etapas de este pipeline pertenecen a eventos o programas. Edita las etapas desde la configuración del evento.")

// Template replacement is allowed only before any event/program references the
// template. The pipeline lock also serializes concurrent FK assignments.
func (r *EventPipelineRepository) ReplaceUnusedStageTemplate(ctx context.Context, accountID, pipelineID uuid.UUID, stages []*domain.EventPipelineStage) error {
	revision := int64(0)
	input := EventStageLayoutInput{ExpectedRevision: &revision}
	for i, stage := range stages {
		input.Stages = append(input.Stages, EventStageDraftInput{ClientID: fmt.Sprintf("draft-%d", i), Name: stage.Name, Color: stage.Color})
	}
	normalized, err := normalizeEventStageLayout(input)
	if err != nil {
		return err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var id uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM event_pipelines WHERE id=$1 AND account_id=$2 FOR UPDATE`, pipelineID, accountID).Scan(&id); err != nil {
		return err
	}
	var used bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM events WHERE pipeline_id=$1) OR EXISTS(SELECT 1 FROM programs WHERE pipeline_id=$1)`, pipelineID).Scan(&used); err != nil {
		return err
	}
	if used {
		return ErrEventStageTemplateInUse
	}
	if _, err = tx.Exec(ctx, `DELETE FROM event_pipeline_stages WHERE pipeline_id=$1`, pipelineID); err != nil {
		return err
	}
	for _, stage := range normalized.Stages {
		if _, err = tx.Exec(ctx, `INSERT INTO event_pipeline_stages(id,pipeline_id,name,color,position) VALUES($1,$2,$3,$4,$5)`, uuid.New(), pipelineID, stage.Name, stage.Color, stage.Position); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
