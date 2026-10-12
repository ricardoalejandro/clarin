package repository

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrEventStageLayoutInvalid = errors.New("invalid event stage layout")
var ErrEventStageLayoutConflict = errors.New("event stages changed")
var eventStageColorPattern = regexp.MustCompile(`^#[0-9A-F]{6}$`)

type EventConfigurationStage struct {
	ID               uuid.UUID `json:"id"`
	Name             string    `json:"name"`
	Color            string    `json:"color"`
	Position         int       `json:"position"`
	ParticipantCount int       `json:"participant_count"`
}
type EventStageLayoutSnapshot struct {
	LogbooksRemapped int                       `json:"-"`
	PipelineID       *uuid.UUID                `json:"pipeline_id"`
	Revision         int64                     `json:"revision"`
	Stages           []EventConfigurationStage `json:"stages"`
	StageIDMap       map[string]string         `json:"stage_id_map,omitempty"`
}
type EventStageDraftInput struct {
	ID       string `json:"id,omitempty"`
	ClientID string `json:"clientId,omitempty"`
	Name     string `json:"name"`
	Color    string `json:"color"`
	Position int    `json:"position"`
}
type EventStageDestination struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type EventStageDeletionInput struct {
	ID     string                `json:"id"`
	MoveTo EventStageDestination `json:"moveTo"`
}
type EventStageLayoutInput struct {
	ActorID          *uuid.UUID                `json:"-"`
	ExpectedRevision *int64                    `json:"expected_revision"`
	Stages           []EventStageDraftInput    `json:"stages"`
	Deletions        []EventStageDeletionInput `json:"deletions"`
}

func normalizeEventStageLayout(input EventStageLayoutInput) (EventStageLayoutInput, error) {
	invalid := func(message string) (EventStageLayoutInput, error) {
		return input, fmt.Errorf("%w: %s", ErrEventStageLayoutInvalid, message)
	}
	if input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		return invalid("Actualiza las etapas antes de guardar.")
	}
	if len(input.Stages) == 0 || len(input.Stages) > 200 {
		return invalid("El evento necesita entre 1 y 200 etapas.")
	}
	input.Stages = append([]EventStageDraftInput(nil), input.Stages...)
	names, ids, clients := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for i := range input.Stages {
		s := &input.Stages[i]
		s.Name = strings.TrimSpace(s.Name)
		s.Color = strings.ToUpper(strings.TrimSpace(s.Color))
		s.Position = i
		if s.Name == "" || utf8.RuneCountInString(s.Name) > 80 {
			return invalid("Cada etapa necesita un nombre de hasta 80 caracteres.")
		}
		name := strings.ToLower(s.Name)
		if names[name] {
			return invalid("Los nombres de las etapas no pueden repetirse.")
		}
		names[name] = true
		if !eventStageColorPattern.MatchString(s.Color) {
			return invalid("El color debe tener el formato #RRGGBB.")
		}
		if s.ID != "" {
			if _, err := uuid.Parse(s.ID); err != nil || ids[s.ID] || s.ClientID != "" {
				return invalid("Identificador de etapa inválido o repetido.")
			}
			ids[s.ID] = true
		} else {
			_, clientIsUUID := uuid.Parse(s.ClientID)
			if strings.TrimSpace(s.ClientID) == "" || len(s.ClientID) > 100 || clients[s.ClientID] || clientIsUUID == nil {
				return invalid("Cada etapa nueva necesita un identificador único.")
			}
			clients[s.ClientID] = true
		}
	}
	deleted := map[string]bool{}
	for _, d := range input.Deletions {
		if _, err := uuid.Parse(d.ID); err != nil || deleted[d.ID] || ids[d.ID] {
			return invalid("La eliminación contiene una etapa inválida o repetida.")
		}
		deleted[d.ID] = true
		if (d.MoveTo.Kind != "stage" && d.MoveTo.Kind != "client") || (d.MoveTo.Kind == "stage" && !ids[d.MoveTo.ID]) || (d.MoveTo.Kind == "client" && !clients[d.MoveTo.ID]) {
			return invalid("Elige una etapa de destino que permanezca en el evento.")
		}
	}
	return input, nil
}

func readEventConfigurationStages(ctx context.Context, tx pgx.Tx, eventID uuid.UUID, pipelineID *uuid.UUID) ([]EventConfigurationStage, error) {
	result := make([]EventConfigurationStage, 0)
	if pipelineID == nil {
		return result, nil
	}
	rows, err := tx.Query(ctx, `SELECT s.id,s.name,s.color,s.position,COUNT(p.id)::int
 FROM event_pipeline_stages s LEFT JOIN event_participants p ON p.stage_id=s.id AND p.event_id=$1
 WHERE s.pipeline_id=$2 GROUP BY s.id ORDER BY s.position,s.id`, eventID, *pipelineID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var s EventConfigurationStage
		if err = rows.Scan(&s.ID, &s.Name, &s.Color, &s.Position, &s.ParticipantCount); err != nil {
			return nil, err
		}
		result = append(result, s)
	}
	return result, rows.Err()
}

func (r *EventPipelineRepository) GetEventStageLayout(ctx context.Context, accountID, eventID uuid.UUID) (*EventStageLayoutSnapshot, error) {
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	result := &EventStageLayoutSnapshot{}
	if err = tx.QueryRow(ctx, `SELECT e.pipeline_id,e.stage_revision FROM events e LEFT JOIN event_pipelines p ON p.id=e.pipeline_id AND p.account_id=e.account_id WHERE e.id=$1 AND e.account_id=$2 AND (e.pipeline_id IS NULL OR p.id IS NOT NULL)`, eventID, accountID).Scan(&result.PipelineID, &result.Revision); err != nil {
		return nil, err
	}
	result.Stages, err = readEventConfigurationStages(ctx, tx, eventID, result.PipelineID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

// SaveEventStageLayout owns validation, copy-on-write, reassignment and revision
// under one event lock. An invalid draft never allocates a dedicated pipeline.
func (r *EventPipelineRepository) SaveEventStageLayout(ctx context.Context, accountID, eventID uuid.UUID, input EventStageLayoutInput) (*EventStageLayoutSnapshot, error) {
	input, err := normalizeEventStageLayout(input)
	if err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var pipelineID *uuid.UUID
	var revision int64
	var status, eventName string
	if err = tx.QueryRow(ctx, `SELECT pipeline_id,stage_revision,status,name FROM events WHERE id=$1 AND account_id=$2 FOR UPDATE`, eventID, accountID).Scan(&pipelineID, &revision, &status, &eventName); err != nil {
		return nil, err
	}
	if status == "completed" || status == "cancelled" {
		return nil, ErrEventMembershipFrozen
	}
	if revision != *input.ExpectedRevision {
		return nil, ErrEventStageLayoutConflict
	}
	var pipelineName string
	var isDefault bool
	if pipelineID != nil {
		if err = tx.QueryRow(ctx, `SELECT name,is_default FROM event_pipelines WHERE id=$1 AND account_id=$2 FOR UPDATE`, *pipelineID, accountID).Scan(&pipelineName, &isDefault); err != nil {
			return nil, err
		}
	}
	current, err := readEventConfigurationStages(ctx, tx, eventID, pipelineID)
	if err != nil {
		return nil, err
	}
	existing := map[string]bool{}
	for _, s := range current {
		existing[s.ID.String()] = true
	}
	mentioned := map[string]bool{}
	for _, s := range input.Stages {
		if s.ID != "" {
			if !existing[s.ID] {
				return nil, fmt.Errorf("%w: Una etapa ya no pertenece al evento.", ErrEventStageLayoutConflict)
			}
			mentioned[s.ID] = true
		}
	}
	for _, d := range input.Deletions {
		if !existing[d.ID] {
			return nil, fmt.Errorf("%w: Una etapa eliminada ya no pertenece al evento.", ErrEventStageLayoutConflict)
		}
		mentioned[d.ID] = true
	}
	if len(mentioned) != len(existing) {
		return nil, fmt.Errorf("%w: La lista de etapas cambió. Recarga antes de guardar.", ErrEventStageLayoutConflict)
	}
	mapping := map[string]string{}
	var usages int
	if pipelineID != nil {
		if err = tx.QueryRow(ctx, `SELECT (SELECT COUNT(*) FROM events WHERE pipeline_id=$1)+(SELECT COUNT(*) FROM programs WHERE pipeline_id=$1)`, *pipelineID).Scan(&usages); err != nil {
			return nil, err
		}
	}
	if pipelineID == nil || isDefault || usages > 1 {
		newID := uuid.New()
		if pipelineName == "" {
			pipelineName = eventName
		}
		if _, err = tx.Exec(ctx, `INSERT INTO event_pipelines(id,account_id,name,is_default) VALUES($1,$2,$3,FALSE)`, newID, accountID, pipelineName+" · "+eventName); err != nil {
			return nil, err
		}
		for _, s := range current {
			newStageID := uuid.New()
			mapping[s.ID.String()] = newStageID.String()
			if _, err = tx.Exec(ctx, `INSERT INTO event_pipeline_stages(id,pipeline_id,name,color,position) VALUES($1,$2,$3,$4,$5)`, newStageID, newID, s.Name, s.Color, s.Position); err != nil {
				return nil, err
			}
		}
		// One statement updates all participant references, retaining historical logbook snapshots.
		if len(mapping) > 0 {
			oldIDs, newIDs := []uuid.UUID{}, []uuid.UUID{}
			for old, newValue := range mapping {
				oldIDs = append(oldIDs, uuid.MustParse(old))
				newIDs = append(newIDs, uuid.MustParse(newValue))
			}
			if _, err = tx.Exec(ctx, `UPDATE event_participants p SET stage_id=m.new_id,updated_at=NOW() FROM unnest($1::uuid[],$2::uuid[]) AS m(old_id,new_id) WHERE p.event_id=$3 AND p.stage_id=m.old_id`, oldIDs, newIDs, eventID); err != nil {
				return nil, err
			}
		}
		pipelineID = &newID
	}
	resolved := func(id string) uuid.UUID {
		if mapped, ok := mapping[id]; ok {
			return uuid.MustParse(mapped)
		}
		return uuid.MustParse(id)
	}
	for _, s := range input.Stages {
		if s.ID == "" {
			id := uuid.New()
			mapping[s.ClientID] = id.String()
			if _, err = tx.Exec(ctx, `INSERT INTO event_pipeline_stages(id,pipeline_id,name,color,position) VALUES($1,$2,$3,$4,$5)`, id, *pipelineID, s.Name, s.Color, s.Position); err != nil {
				return nil, err
			}
		} else {
			if _, err = tx.Exec(ctx, `UPDATE event_pipeline_stages SET name=$1,color=$2,position=$3 WHERE id=$4 AND pipeline_id=$5`, s.Name, s.Color, s.Position, resolved(s.ID), *pipelineID); err != nil {
				return nil, err
			}
		}
	}
	for _, d := range input.Deletions {
		source, target := resolved(d.ID), resolved(d.MoveTo.ID)
		if _, err = tx.Exec(ctx, `UPDATE event_participants SET stage_id=$1,updated_at=NOW() WHERE event_id=$2 AND stage_id=$3`, target, eventID, source); err != nil {
			return nil, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM event_pipeline_stages WHERE id=$1 AND pipeline_id=$2`, source, *pipelineID); err != nil {
			return nil, err
		}
		// Remap deleted selections to their surviving destination as well.
		mapping[d.ID] = target.String()
	}
	if _, err = tx.Exec(ctx, `UPDATE events SET pipeline_id=$1,stage_revision=stage_revision+1,updated_at=NOW() WHERE id=$2 AND account_id=$3`, *pipelineID, eventID, accountID); err != nil {
		return nil, err
	}
	remappedLogbooks, err := remapEventLogbookStageFiltersTx(ctx, tx, accountID, eventID, mapping, input.ActorID)
	if err != nil {
		return nil, err
	}
	result := &EventStageLayoutSnapshot{PipelineID: pipelineID, Revision: revision + 1, StageIDMap: mapping, LogbooksRemapped: remappedLogbooks}
	result.Stages, err = readEventConfigurationStages(ctx, tx, eventID, pipelineID)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}
