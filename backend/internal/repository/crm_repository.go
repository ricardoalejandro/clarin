package repository

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrCRMNotFound        = errors.New("crm resource not found")
	ErrInvalidStageLayout = errors.New("invalid pipeline stage layout")
	ErrLostReasonRequired = errors.New("lost reason is required")
	ErrPossibleDuplicate  = errors.New("possible duplicate opportunity")
	ErrPipelineHasLeads   = errors.New("pipeline has opportunities")
)

type PipelineStageDraft struct {
	ID        *uuid.UUID
	ClientID  string
	Name      string
	Color     string
	StageType string
	Position  int
}

type PipelineStageDeletion struct {
	ID                 uuid.UUID
	ReassignToStageID  *uuid.UUID
	ReassignToClientID string
}

func normalizeOpportunityTitle(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func normalizeStageName(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(value), " "))
}

func normalizeStageDrafts(stages []PipelineStageDraft) ([]PipelineStageDraft, error) {
	if len(stages) == 0 {
		return nil, fmt.Errorf("%w: el pipeline necesita etapas", ErrInvalidStageLayout)
	}
	result := append([]PipelineStageDraft(nil), stages...)
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Position == result[j].Position {
			return i < j
		}
		return result[i].Position < result[j].Position
	})

	seenNames := make(map[string]struct{}, len(result))
	seenIDs := make(map[uuid.UUID]struct{}, len(result))
	seenClientIDs := make(map[string]struct{}, len(result))
	active, won, lost := 0, 0, 0
	phase := 0
	for i := range result {
		result[i].Name = strings.TrimSpace(result[i].Name)
		result[i].Color = strings.TrimSpace(result[i].Color)
		result[i].StageType = strings.TrimSpace(strings.ToLower(result[i].StageType))
		result[i].ClientID = strings.TrimSpace(result[i].ClientID)
		result[i].Position = i
		if result[i].Name == "" || len(result[i].Name) > 255 {
			return nil, fmt.Errorf("%w: nombre de etapa inválido", ErrInvalidStageLayout)
		}
		if result[i].Color == "" {
			result[i].Color = "#6366F1"
		}
		if len(result[i].Color) > 50 {
			return nil, fmt.Errorf("%w: color de etapa inválido", ErrInvalidStageLayout)
		}
		nameKey := normalizeStageName(result[i].Name)
		if _, exists := seenNames[nameKey]; exists {
			return nil, fmt.Errorf("%w: el nombre %q está repetido", ErrInvalidStageLayout, result[i].Name)
		}
		seenNames[nameKey] = struct{}{}
		if result[i].ID != nil {
			if *result[i].ID == uuid.Nil {
				return nil, fmt.Errorf("%w: id de etapa inválido", ErrInvalidStageLayout)
			}
			if _, exists := seenIDs[*result[i].ID]; exists {
				return nil, fmt.Errorf("%w: etapa repetida", ErrInvalidStageLayout)
			}
			seenIDs[*result[i].ID] = struct{}{}
		} else {
			if result[i].ClientID == "" {
				result[i].ClientID = "new-" + uuid.NewString()
			}
			if _, exists := seenClientIDs[result[i].ClientID]; exists {
				return nil, fmt.Errorf("%w: client_id repetido", ErrInvalidStageLayout)
			}
			seenClientIDs[result[i].ClientID] = struct{}{}
		}

		switch result[i].StageType {
		case domain.PipelineStageTypeActive:
			if phase != 0 {
				return nil, fmt.Errorf("%w: las etapas activas deben ir antes de Ganado y Perdido", ErrInvalidStageLayout)
			}
			active++
		case domain.PipelineStageTypeWon:
			if phase > 1 {
				return nil, fmt.Errorf("%w: Ganado debe ir antes de Perdido", ErrInvalidStageLayout)
			}
			phase = 1
			won++
		case domain.PipelineStageTypeLost:
			phase = 2
			lost++
		default:
			return nil, fmt.Errorf("%w: tipo de etapa inválido", ErrInvalidStageLayout)
		}
	}
	if active == 0 || won != 1 || lost != 1 {
		return nil, fmt.Errorf("%w: se requiere al menos una etapa activa, una Ganado y una Perdido", ErrInvalidStageLayout)
	}
	return result, nil
}

func (r *PipelineRepository) GetByIDForAccount(ctx context.Context, accountID, id uuid.UUID) (*domain.Pipeline, error) {
	pipeline := &domain.Pipeline{}
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, is_default, kommo_id, created_at, updated_at
		FROM pipelines WHERE id = $1 AND account_id = $2
	`, id, accountID).Scan(
		&pipeline.ID, &pipeline.AccountID, &pipeline.Name, &pipeline.Description,
		&pipeline.IsDefault, &pipeline.KommoID, &pipeline.CreatedAt, &pipeline.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT ps.id, ps.pipeline_id, ps.name, ps.color, ps.position, ps.stage_type, ps.kommo_id, ps.created_at,
		       COUNT(l.id) FILTER (WHERE l.deleted_at IS NULL)
		FROM pipeline_stages ps
		LEFT JOIN leads l ON l.stage_id = ps.id AND l.account_id = $2
		WHERE ps.pipeline_id = $1
		GROUP BY ps.id
		ORDER BY ps.position
	`, id, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		stage := &domain.PipelineStage{}
		if err := rows.Scan(&stage.ID, &stage.PipelineID, &stage.Name, &stage.Color, &stage.Position, &stage.StageType, &stage.KommoID, &stage.CreatedAt, &stage.LeadCount); err != nil {
			return nil, err
		}
		pipeline.Stages = append(pipeline.Stages, stage)
	}
	return pipeline, rows.Err()
}

func (r *PipelineRepository) CreateWithStages(ctx context.Context, pipeline *domain.Pipeline, stages []PipelineStageDraft) error {
	if pipeline == nil || pipeline.AccountID == uuid.Nil || strings.TrimSpace(pipeline.Name) == "" {
		return fmt.Errorf("pipeline inválido")
	}
	var normalized []PipelineStageDraft
	var err error
	if len(stages) > 0 {
		normalized, err = normalizeStageDrafts(stages)
		if err != nil {
			return err
		}
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	pipeline.ID = uuid.New()
	pipeline.Name = strings.TrimSpace(pipeline.Name)
	now := time.Now()
	pipeline.CreatedAt, pipeline.UpdatedAt = now, now
	tag, err := tx.Exec(ctx, `
		INSERT INTO pipelines (id, account_id, name, description, is_default, created_at, updated_at)
		SELECT $1, a.id, $3, $4, $5, $6, $6 FROM accounts a WHERE a.id = $2
	`, pipeline.ID, pipeline.AccountID, pipeline.Name, pipeline.Description, pipeline.IsDefault, now)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	for i, draft := range normalized {
		stageID := uuid.New()
		if _, err := tx.Exec(ctx, `
			INSERT INTO pipeline_stages (id, pipeline_id, name, color, position, stage_type, created_at)
			VALUES ($1,$2,$3,$4,$5,$6,$7)
		`, stageID, pipeline.ID, draft.Name, draft.Color, i, draft.StageType, now); err != nil {
			return err
		}
		pipeline.Stages = append(pipeline.Stages, &domain.PipelineStage{
			ID: stageID, PipelineID: pipeline.ID, Name: draft.Name, Color: draft.Color,
			Position: i, StageType: draft.StageType, CreatedAt: now,
		})
	}
	return tx.Commit(ctx)
}

func (r *PipelineRepository) UpdateForAccount(ctx context.Context, pipeline *domain.Pipeline) error {
	if pipeline == nil {
		return ErrCRMNotFound
	}
	pipeline.Name = strings.TrimSpace(pipeline.Name)
	if pipeline.Name == "" {
		return fmt.Errorf("el nombre del pipeline es obligatorio")
	}
	tag, err := r.db.Exec(ctx, `
		UPDATE pipelines SET name=$1, description=$2, updated_at=NOW()
		WHERE id=$3 AND account_id=$4
	`, pipeline.Name, pipeline.Description, pipeline.ID, pipeline.AccountID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	pipeline.UpdatedAt = time.Now()
	return nil
}

func (r *PipelineRepository) SaveStageLayout(ctx context.Context, accountID, pipelineID uuid.UUID, stages []PipelineStageDraft, deletions []PipelineStageDeletion, defaultIncomingStageID *uuid.UUID) (*domain.Pipeline, error) {
	normalized, err := normalizeStageDrafts(stages)
	if err != nil {
		return nil, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET CONSTRAINTS ALL DEFERRED`); err != nil {
		return nil, err
	}

	var exists bool
	if err := tx.QueryRow(ctx, `SELECT TRUE FROM pipelines WHERE id=$1 AND account_id=$2 FOR UPDATE`, pipelineID, accountID).Scan(&exists); err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrCRMNotFound
		}
		return nil, err
	}

	rows, err := tx.Query(ctx, `SELECT id, stage_type FROM pipeline_stages WHERE pipeline_id=$1 FOR UPDATE`, pipelineID)
	if err != nil {
		return nil, err
	}
	existing := make(map[uuid.UUID]string)
	for rows.Next() {
		var id uuid.UUID
		var stageType string
		if err := rows.Scan(&id, &stageType); err != nil {
			rows.Close()
			return nil, err
		}
		existing[id] = stageType
	}
	rows.Close()

	deleteByID := make(map[uuid.UUID]PipelineStageDeletion, len(deletions))
	for _, deletion := range deletions {
		if deletion.ID == uuid.Nil {
			return nil, fmt.Errorf("%w: id de eliminación inválido", ErrInvalidStageLayout)
		}
		existingType, ok := existing[deletion.ID]
		if !ok {
			return nil, ErrCRMNotFound
		}
		if existingType != domain.PipelineStageTypeActive {
			return nil, fmt.Errorf("%w: Ganado y Perdido no se pueden eliminar", ErrInvalidStageLayout)
		}
		if _, duplicate := deleteByID[deletion.ID]; duplicate {
			return nil, fmt.Errorf("%w: eliminación repetida", ErrInvalidStageLayout)
		}
		deleteByID[deletion.ID] = deletion
	}

	finalByID := make(map[uuid.UUID]PipelineStageDraft, len(normalized))
	clientIDs := make(map[string]uuid.UUID)
	for i := range normalized {
		if normalized[i].ID == nil {
			id := uuid.New()
			normalized[i].ID = &id
			clientIDs[normalized[i].ClientID] = id
		} else {
			existingType, ok := existing[*normalized[i].ID]
			if !ok {
				return nil, ErrCRMNotFound
			}
			if existingType != normalized[i].StageType {
				return nil, fmt.Errorf("%w: el tipo de una etapa existente no se puede cambiar", ErrInvalidStageLayout)
			}
			if _, deleting := deleteByID[*normalized[i].ID]; deleting {
				return nil, fmt.Errorf("%w: una etapa eliminada no puede permanecer en el layout", ErrInvalidStageLayout)
			}
		}
		finalByID[*normalized[i].ID] = normalized[i]
	}
	for id := range existing {
		if _, kept := finalByID[id]; kept {
			continue
		}
		if _, deleting := deleteByID[id]; !deleting {
			return nil, fmt.Errorf("%w: el layout debe incluir o eliminar cada etapa existente", ErrInvalidStageLayout)
		}
	}

	// Materialize new stage IDs before moving opportunities out of deleted
	// stages. leads.stage_id has an immediate FK, so a new client-side
	// destination must exist before it can be referenced. Temporary values keep
	// all unique-name/position/terminal constraints conflict-free until the
	// final layout is applied below.
	for i, draft := range normalized {
		id := *draft.ID
		if _, wasExisting := existing[id]; wasExisting {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO pipeline_stages (id,pipeline_id,name,color,position,stage_type,created_at)
			VALUES ($1,$2,$3,$4,$5,'active',NOW())
		`, id, pipelineID, "__layout_new_"+id.String(), draft.Color, -200000-i); err != nil {
			return nil, err
		}
	}

	for _, deletion := range deletions {
		var destination *uuid.UUID
		if deletion.ReassignToStageID != nil {
			destination = deletion.ReassignToStageID
		} else if deletion.ReassignToClientID != "" {
			if id, ok := clientIDs[deletion.ReassignToClientID]; ok {
				destination = &id
			}
		}
		var leadCount, visibleLeadCount int
		if err := tx.QueryRow(ctx, `SELECT COUNT(*), COUNT(*) FILTER (WHERE deleted_at IS NULL) FROM leads WHERE account_id=$1 AND stage_id=$2`, accountID, deletion.ID).Scan(&leadCount, &visibleLeadCount); err != nil {
			return nil, err
		}
		if leadCount > 0 {
			if destination == nil && visibleLeadCount == 0 {
				// Trash is intentionally hidden from the editor count, but restored
				// opportunities still need a valid stage after deletion.
				fallback := *normalized[0].ID
				destination = &fallback
			}
			if destination == nil || *destination == deletion.ID {
				return nil, fmt.Errorf("%w: el destino es obligatorio para una etapa con oportunidades", ErrInvalidStageLayout)
			}
			draft, ok := finalByID[*destination]
			if !ok || draft.StageType != domain.PipelineStageTypeActive {
				return nil, fmt.Errorf("%w: las oportunidades de una etapa eliminada deben moverse a una etapa activa", ErrInvalidStageLayout)
			}
			if _, err := tx.Exec(ctx, `
				UPDATE leads SET pipeline_id=$3, stage_id=$2, status='open', closed_at=NULL, closed_by=NULL, close_reason='', updated_at=NOW()
				WHERE account_id=$1 AND stage_id=$4
			`, accountID, *destination, pipelineID, deletion.ID); err != nil {
				return nil, err
			}
		}
	}

	// Temporary unique values make name swaps and terminal replacements safe
	// under the normalized-name and partial terminal indexes.
	for id := range existing {
		if _, deleting := deleteByID[id]; deleting {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE pipeline_stages SET name=$1, stage_type='active', position=$2 WHERE id=$3 AND pipeline_id=$4
		`, "__layout_"+id.String(), -100000-len(finalByID), id, pipelineID); err != nil {
			return nil, err
		}
	}
	for _, deletion := range deletions {
		if _, err := tx.Exec(ctx, `DELETE FROM pipeline_stages WHERE id=$1 AND pipeline_id=$2`, deletion.ID, pipelineID); err != nil {
			return nil, err
		}
	}

	for i, draft := range normalized {
		id := *draft.ID
		result, err := tx.Exec(ctx, `
			UPDATE pipeline_stages SET name=$1, color=$2, position=$3, stage_type=$4
			WHERE id=$5 AND pipeline_id=$6
		`, draft.Name, draft.Color, i, draft.StageType, id, pipelineID)
		if err != nil {
			return nil, err
		}
		if result.RowsAffected() != 1 {
			return nil, ErrCRMNotFound
		}
	}

	firstActiveID := *normalized[0].ID
	selectedIncomingID := firstActiveID
	if defaultIncomingStageID != nil {
		draft, ok := finalByID[*defaultIncomingStageID]
		if !ok || draft.StageType != domain.PipelineStageTypeActive {
			return nil, fmt.Errorf("%w: la etapa de entrada debe ser una etapa activa del pipeline", ErrInvalidStageLayout)
		}
		selectedIncomingID = *defaultIncomingStageID
	} else {
		var currentIncomingID *uuid.UUID
		var currentIncomingPipelineID *uuid.UUID
		var currentIncomingType *string
		if err := tx.QueryRow(ctx, `
			SELECT CASE WHEN owner.account_id=a.id THEN a.default_incoming_stage_id END,
			       CASE WHEN owner.account_id=a.id THEN ps.pipeline_id END,
			       CASE WHEN owner.account_id=a.id THEN ps.stage_type END
			FROM accounts a
			LEFT JOIN pipeline_stages ps ON ps.id=a.default_incoming_stage_id
			LEFT JOIN pipelines owner ON owner.id=ps.pipeline_id
			WHERE a.id=$1
		`, accountID).Scan(&currentIncomingID, &currentIncomingPipelineID, &currentIncomingType); err != nil {
			return nil, err
		}
		if currentIncomingID != nil && currentIncomingType != nil && *currentIncomingType == domain.PipelineStageTypeActive {
			if currentIncomingPipelineID != nil && *currentIncomingPipelineID != pipelineID {
				selectedIncomingID = *currentIncomingID
			} else if draft, ok := finalByID[*currentIncomingID]; ok && draft.StageType == domain.PipelineStageTypeActive {
				selectedIncomingID = *currentIncomingID
			}
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE accounts SET default_incoming_stage_id=$1, updated_at=NOW()
		WHERE id=$2
	`, selectedIncomingID, accountID); err != nil {
		return nil, err
	}

	for _, draft := range normalized {
		id := *draft.ID
		switch draft.StageType {
		case domain.PipelineStageTypeActive:
			_, err = tx.Exec(ctx, `UPDATE leads SET status='open', closed_at=NULL, closed_by=NULL, close_reason='', updated_at=NOW() WHERE account_id=$1 AND stage_id=$2`, accountID, id)
		case domain.PipelineStageTypeWon:
			_, err = tx.Exec(ctx, `UPDATE leads SET status='won', closed_at=COALESCE(closed_at,NOW()), updated_at=NOW() WHERE account_id=$1 AND stage_id=$2`, accountID, id)
		case domain.PipelineStageTypeLost:
			_, err = tx.Exec(ctx, `UPDATE leads SET status='lost', closed_at=COALESCE(closed_at,NOW()), close_reason=COALESCE(NULLIF(close_reason,''),'Cerrado por reconfiguración de etapas'), updated_at=NOW() WHERE account_id=$1 AND stage_id=$2`, accountID, id)
		}
		if err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE pipelines SET updated_at=NOW() WHERE id=$1 AND account_id=$2`, pipelineID, accountID); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetByIDForAccount(ctx, accountID, pipelineID)
}

func (r *LeadRepository) HasOpenDuplicate(ctx context.Context, accountID, contactID uuid.UUID, title string, excludeID *uuid.UUID) ([]*domain.Lead, error) {
	normalized := normalizeOpportunityTitle(title)
	if normalized == "" {
		return nil, nil
	}
	query := `SELECT id FROM leads WHERE account_id=$1 AND contact_id=$2 AND status='open' AND deleted_at IS NULL AND LOWER(REGEXP_REPLACE(BTRIM(title), '\s+', ' ', 'g'))=$3`
	args := []interface{}{accountID, contactID, normalized}
	if excludeID != nil {
		query += ` AND id<>$4`
		args = append(args, *excludeID)
	}
	query += ` ORDER BY updated_at DESC LIMIT 10`
	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []*domain.Lead
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		lead, err := r.GetByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if lead != nil {
			result = append(result, lead)
		}
	}
	return result, rows.Err()
}

func (r *LeadRepository) MoveToStage(ctx context.Context, accountID, leadID, stageID uuid.UUID, closeReason string, closedBy *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var pipelineID uuid.UUID
	var stageType string
	if err := tx.QueryRow(ctx, `
		SELECT ps.pipeline_id, ps.stage_type FROM pipeline_stages ps
		JOIN pipelines p ON p.id=ps.pipeline_id
		WHERE ps.id=$1 AND p.account_id=$2
	`, stageID, accountID).Scan(&pipelineID, &stageType); err != nil {
		if err == pgx.ErrNoRows {
			return ErrCRMNotFound
		}
		return err
	}
	var leadExists bool
	if err := tx.QueryRow(ctx, `SELECT TRUE FROM leads WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL FOR UPDATE`, leadID, accountID).Scan(&leadExists); err != nil {
		if err == pgx.ErrNoRows {
			return ErrCRMNotFound
		}
		return err
	}
	closeReason = strings.TrimSpace(closeReason)
	switch stageType {
	case domain.PipelineStageTypeActive:
		_, err = tx.Exec(ctx, `UPDATE leads SET pipeline_id=$1, stage_id=$2, status='open', closed_at=NULL, closed_by=NULL, close_reason='', updated_at=NOW() WHERE id=$3 AND account_id=$4`, pipelineID, stageID, leadID, accountID)
	case domain.PipelineStageTypeWon:
		_, err = tx.Exec(ctx, `UPDATE leads SET pipeline_id=$1, stage_id=$2, status='won', closed_at=NOW(), closed_by=$3, close_reason=$4, updated_at=NOW() WHERE id=$5 AND account_id=$6`, pipelineID, stageID, closedBy, closeReason, leadID, accountID)
	case domain.PipelineStageTypeLost:
		if closeReason == "" {
			return ErrLostReasonRequired
		}
		_, err = tx.Exec(ctx, `UPDATE leads SET pipeline_id=$1, stage_id=$2, status='lost', closed_at=NOW(), closed_by=$3, close_reason=$4, updated_at=NOW() WHERE id=$5 AND account_id=$6`, pipelineID, stageID, closedBy, closeReason, leadID, accountID)
	default:
		return fmt.Errorf("tipo de etapa inválido")
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *LeadRepository) SoftDelete(ctx context.Context, accountID, id uuid.UUID, deletedBy *uuid.UUID, reason string) error {
	tag, err := r.db.Exec(ctx, `UPDATE leads SET deleted_at=NOW(), deleted_by=$3, delete_reason=$4, updated_at=NOW() WHERE account_id=$1 AND id=$2 AND deleted_at IS NULL`, accountID, id, deletedBy, strings.TrimSpace(reason))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	return nil
}

func (r *LeadRepository) SoftDeleteBatch(ctx context.Context, accountID uuid.UUID, ids []uuid.UUID, deletedBy *uuid.UUID, reason string) (int64, error) {
	tag, err := r.db.Exec(ctx, `UPDATE leads SET deleted_at=NOW(), deleted_by=$3, delete_reason=$4, updated_at=NOW() WHERE account_id=$1 AND id=ANY($2) AND deleted_at IS NULL`, accountID, ids, deletedBy, strings.TrimSpace(reason))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r *LeadRepository) SoftDeleteAll(ctx context.Context, accountID uuid.UUID, deletedBy *uuid.UUID, reason string) (int64, error) {
	tag, err := r.db.Exec(ctx, `UPDATE leads SET deleted_at=NOW(), deleted_by=$2, delete_reason=$3, updated_at=NOW() WHERE account_id=$1 AND deleted_at IS NULL`, accountID, deletedBy, strings.TrimSpace(reason))
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r *LeadRepository) Restore(ctx context.Context, accountID, id uuid.UUID) error {
	tag, err := r.db.Exec(ctx, `UPDATE leads SET deleted_at=NULL, deleted_by=NULL, delete_reason='', updated_at=NOW() WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL`, accountID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	return nil
}

func (r *LeadRepository) Purge(ctx context.Context, accountID, id uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		UPDATE interactions i SET contact_id=l.contact_id
		FROM leads l WHERE l.id=$2 AND l.account_id=$1 AND i.lead_id=l.id AND i.contact_id IS NULL AND l.contact_id IS NOT NULL
	`, accountID, id); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM leads WHERE account_id=$1 AND id=$2 AND deleted_at IS NOT NULL`, accountID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	return tx.Commit(ctx)
}

func (r *LeadRepository) PurgeExpired(ctx context.Context, retention time.Duration) (int64, error) {
	cutoff := time.Now().Add(-retention)
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		UPDATE interactions i SET contact_id=l.contact_id
		FROM leads l WHERE l.deleted_at IS NOT NULL AND l.deleted_at<$1 AND i.lead_id=l.id AND i.contact_id IS NULL AND l.contact_id IS NOT NULL
	`, cutoff); err != nil {
		return 0, err
	}
	tag, err := tx.Exec(ctx, `DELETE FROM leads WHERE deleted_at IS NOT NULL AND deleted_at<$1`, cutoff)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r *ContactRepository) SetDoNotContact(ctx context.Context, accountID, contactID uuid.UUID, blocked bool, reason string, changedBy *uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if blocked {
		reason = strings.TrimSpace(reason)
		if reason == "" {
			return fmt.Errorf("el motivo es obligatorio")
		}
		tag, err := tx.Exec(ctx, `UPDATE contacts SET do_not_contact=TRUE, do_not_contact_at=NOW(), do_not_contact_by=$3, do_not_contact_reason=$4, updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, contactID, changedBy, reason)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return ErrCRMNotFound
		}

		// Snapshot every identity currently associated with the Contact. The
		// suppression row has no ownership dependency on Contact, so it remains
		// effective after a destructive deletion or historical unlink.
		if _, err := tx.Exec(ctx, `
			WITH identities AS (
				SELECT 'jid'::text AS identity_type, LOWER(BTRIM(c.jid)) AS normalized_value
				FROM contacts c WHERE c.id=$2 AND c.account_id=$1 AND NULLIF(BTRIM(c.jid),'') IS NOT NULL
				UNION
				SELECT 'phone', REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g')
				FROM contacts c WHERE c.id=$2 AND c.account_id=$1 AND REGEXP_REPLACE(COALESCE(c.phone,''), '[^0-9]', '', 'g') <> ''
				UNION
				SELECT 'phone', REGEXP_REPLACE(cp.phone, '[^0-9]', '', 'g')
				FROM contact_phones cp JOIN contacts c ON c.id=cp.contact_id
				WHERE c.id=$2 AND c.account_id=$1 AND REGEXP_REPLACE(COALESCE(cp.phone,''), '[^0-9]', '', 'g') <> ''
				UNION
				SELECT CASE WHEN LOWER(ca.alias_type)='jid' OR ca.alias_value LIKE '%@%' THEN 'jid' ELSE 'phone' END,
					CASE WHEN LOWER(ca.alias_type)='jid' OR ca.alias_value LIKE '%@%' THEN LOWER(BTRIM(ca.alias_value)) ELSE REGEXP_REPLACE(ca.alias_value, '[^0-9]', '', 'g') END
				FROM contact_aliases ca JOIN contacts c ON c.id=ca.contact_id
				WHERE c.id=$2 AND c.account_id=$1
				UNION
				SELECT 'jid', LOWER(BTRIM(ch.jid)) FROM chats ch
				WHERE ch.contact_id=$2 AND ch.account_id=$1 AND NULLIF(BTRIM(ch.jid),'') IS NOT NULL
				UNION
				SELECT 'jid', LOWER(BTRIM(l.jid)) FROM leads l
				WHERE l.contact_id=$2 AND l.account_id=$1 AND NULLIF(BTRIM(l.jid),'') IS NOT NULL
			)
			INSERT INTO contact_suppressions (account_id, contact_id, identity_type, normalized_value, reason, created_by)
			SELECT $1, $2, identity_type, normalized_value, $3, $4 FROM identities WHERE NULLIF(BTRIM(normalized_value),'') IS NOT NULL
			ON CONFLICT (account_id, identity_type, normalized_value) DO UPDATE SET
				contact_id=EXCLUDED.contact_id, reason=EXCLUDED.reason, created_by=EXCLUDED.created_by,
				active=TRUE, updated_at=NOW(), released_at=NULL, released_by=NULL
		`, accountID, contactID, reason, changedBy); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	tag, err := tx.Exec(ctx, `UPDATE contacts SET do_not_contact=FALSE, do_not_contact_at=NULL, do_not_contact_by=NULL, do_not_contact_reason='', updated_at=NOW() WHERE account_id=$1 AND id=$2`, accountID, contactID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrCRMNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE contact_suppressions SET active=FALSE, updated_at=NOW(), released_at=NOW(), released_by=$3
		WHERE account_id=$1 AND contact_id=$2 AND active=TRUE
	`, accountID, contactID, changedBy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *ContactRepository) SetDoNotContactBatch(ctx context.Context, accountID uuid.UUID, contactIDs []uuid.UUID, blocked bool, reason string, changedBy *uuid.UUID) (int64, error) {
	if len(contactIDs) == 0 {
		return 0, nil
	}
	reason = strings.TrimSpace(reason)
	if blocked && reason == "" {
		return 0, fmt.Errorf("el motivo es obligatorio")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	var tag pgconn.CommandTag
	if blocked {
		tag, err = tx.Exec(ctx, `UPDATE contacts SET do_not_contact=TRUE, do_not_contact_at=NOW(), do_not_contact_by=$3, do_not_contact_reason=$4, updated_at=NOW() WHERE account_id=$1 AND id=ANY($2)`, accountID, contactIDs, changedBy, reason)
	} else {
		tag, err = tx.Exec(ctx, `UPDATE contacts SET do_not_contact=FALSE, do_not_contact_at=NULL, do_not_contact_by=NULL, do_not_contact_reason='', updated_at=NOW() WHERE account_id=$1 AND id=ANY($2)`, accountID, contactIDs)
	}
	if err != nil {
		return 0, err
	}
	if blocked {
		if _, err := tx.Exec(ctx, `
			WITH identities AS (
				SELECT c.id AS contact_id, 'jid'::text AS identity_type, LOWER(BTRIM(c.jid)) AS normalized_value FROM contacts c WHERE c.account_id=$1 AND c.id=ANY($2) AND NULLIF(BTRIM(c.jid),'') IS NOT NULL
				UNION SELECT c.id, 'phone', REGEXP_REPLACE(c.phone, '[^0-9]', '', 'g') FROM contacts c WHERE c.account_id=$1 AND c.id=ANY($2) AND REGEXP_REPLACE(COALESCE(c.phone,''), '[^0-9]', '', 'g') <> ''
				UNION SELECT c.id, 'phone', REGEXP_REPLACE(cp.phone, '[^0-9]', '', 'g') FROM contacts c JOIN contact_phones cp ON cp.contact_id=c.id WHERE c.account_id=$1 AND c.id=ANY($2) AND REGEXP_REPLACE(COALESCE(cp.phone,''), '[^0-9]', '', 'g') <> ''
				UNION SELECT c.id, CASE WHEN LOWER(ca.alias_type)='jid' OR ca.alias_value LIKE '%@%' THEN 'jid' ELSE 'phone' END, CASE WHEN LOWER(ca.alias_type)='jid' OR ca.alias_value LIKE '%@%' THEN LOWER(BTRIM(ca.alias_value)) ELSE REGEXP_REPLACE(ca.alias_value, '[^0-9]', '', 'g') END FROM contacts c JOIN contact_aliases ca ON ca.contact_id=c.id WHERE c.account_id=$1 AND c.id=ANY($2)
				UNION SELECT c.id, 'jid', LOWER(BTRIM(ch.jid)) FROM contacts c JOIN chats ch ON ch.contact_id=c.id AND ch.account_id=c.account_id WHERE c.account_id=$1 AND c.id=ANY($2) AND NULLIF(BTRIM(ch.jid),'') IS NOT NULL
			)
			INSERT INTO contact_suppressions (account_id, contact_id, identity_type, normalized_value, reason, created_by)
			SELECT $1, contact_id, identity_type, normalized_value, $3, $4 FROM identities WHERE NULLIF(BTRIM(normalized_value),'') IS NOT NULL
			ON CONFLICT (account_id, identity_type, normalized_value) DO UPDATE SET contact_id=EXCLUDED.contact_id, reason=EXCLUDED.reason, created_by=EXCLUDED.created_by, active=TRUE, updated_at=NOW(), released_at=NULL, released_by=NULL
		`, accountID, contactIDs, reason, changedBy); err != nil {
			return 0, err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE contact_suppressions SET active=FALSE, updated_at=NOW(), released_at=NOW(), released_by=$3 WHERE account_id=$1 AND contact_id=ANY($2) AND active=TRUE`, accountID, contactIDs, changedBy); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

func (r *ContactRepository) IsDoNotContactByJID(ctx context.Context, accountID uuid.UUID, jid string) (bool, error) {
	return r.IsOutboundSuppressed(ctx, accountID, []string{jid})
}

// IsOutboundSuppressed resolves raw JIDs, phone numbers, merged aliases and
// historical durable suppressions. Errors are returned to callers so outbound
// delivery can fail closed instead of treating a database outage as consent.
func (r *ContactRepository) IsOutboundSuppressed(ctx context.Context, accountID uuid.UUID, rawIdentities []string) (bool, error) {
	identities := make([]string, 0, len(rawIdentities)*2)
	seen := make(map[string]struct{}, len(rawIdentities)*2)
	for _, raw := range rawIdentities {
		normalized := strings.ToLower(strings.TrimSpace(raw))
		if normalized != "" {
			if _, exists := seen[normalized]; !exists {
				seen[normalized] = struct{}{}
				identities = append(identities, normalized)
			}
		}
		var digits strings.Builder
		for _, char := range raw {
			if char >= '0' && char <= '9' {
				digits.WriteRune(char)
			}
		}
		if phone := digits.String(); phone != "" {
			if _, exists := seen[phone]; !exists {
				seen[phone] = struct{}{}
				identities = append(identities, phone)
			}
		}
	}
	if len(identities) == 0 {
		return false, nil
	}

	var blocked bool
	err := r.db.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM contact_suppressions cs
			WHERE cs.account_id=$1 AND cs.active=TRUE AND cs.normalized_value=ANY($2)
			UNION ALL
			SELECT 1 FROM contacts c
			WHERE c.account_id=$1 AND c.do_not_contact=TRUE AND (
				LOWER(BTRIM(c.jid))=ANY($2) OR REGEXP_REPLACE(COALESCE(c.phone,''), '[^0-9]', '', 'g')=ANY($2)
			)
			UNION ALL
			SELECT 1 FROM contact_phones cp JOIN contacts c ON c.id=cp.contact_id
			WHERE c.account_id=$1 AND c.do_not_contact=TRUE AND REGEXP_REPLACE(COALESCE(cp.phone,''), '[^0-9]', '', 'g')=ANY($2)
			UNION ALL
			SELECT 1 FROM contact_aliases ca JOIN contacts c ON c.id=ca.contact_id
			WHERE c.account_id=$1 AND c.do_not_contact=TRUE AND (
				LOWER(BTRIM(ca.alias_value))=ANY($2) OR ca.normalized_value=ANY($2)
			)
			UNION ALL
			SELECT 1 FROM chats ch JOIN contacts c ON c.id=ch.contact_id AND c.account_id=ch.account_id
			WHERE ch.account_id=$1 AND c.do_not_contact=TRUE AND LOWER(BTRIM(ch.jid))=ANY($2)
		)
	`, accountID, identities).Scan(&blocked)
	return blocked, err
}

func (r *TagRepository) resolveEntityContactForAccount(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, entityType string, entityID uuid.UUID) (*uuid.UUID, error) {
	var contactID uuid.UUID
	var err error
	switch entityType {
	case "contact":
		var id uuid.UUID
		err = tx.QueryRow(ctx, `SELECT id FROM contacts WHERE id=$1 AND account_id=$2`, entityID, accountID).Scan(&id)
		contactID = id
	case "lead":
		err = tx.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id=$1 AND account_id=$2 AND contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	case "chat":
		err = tx.QueryRow(ctx, `SELECT contact_id FROM chats WHERE id=$1 AND account_id=$2 AND contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	case "participant":
		err = tx.QueryRow(ctx, `SELECT ep.contact_id FROM event_participants ep JOIN events e ON e.id=ep.event_id WHERE ep.id=$1 AND e.account_id=$2 AND ep.contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	default:
		return nil, fmt.Errorf("tipo de entidad inválido")
	}
	if err != nil || contactID == uuid.Nil {
		return nil, ErrCRMNotFound
	}
	return &contactID, nil
}

// SetEntityTagForAccount is the canonical account-scoped tag mutation. Since
// contact_tags is the source of truth, every supported entity resolves to its
// same-account contact before writing.
func (r *TagRepository) SetEntityTagForAccount(ctx context.Context, accountID uuid.UUID, entityType string, entityID, tagID uuid.UUID, assign bool) (*uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1::text))`, accountID); err != nil {
		return nil, err
	}
	var tagExists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tags WHERE id=$1 AND account_id=$2)`, tagID, accountID).Scan(&tagExists); err != nil {
		return nil, err
	}
	if !tagExists {
		return nil, ErrCRMNotFound
	}
	contactID, err := r.resolveEntityContactForAccount(ctx, tx, accountID, entityType, entityID)
	if err != nil {
		return nil, err
	}
	if assign {
		_, err = tx.Exec(ctx, `INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, *contactID, tagID)
	} else {
		_, err = tx.Exec(ctx, `DELETE FROM contact_tags WHERE contact_id=$1 AND tag_id=$2`, *contactID, tagID)
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return contactID, nil
}

func (r *TagRepository) GetByEntityForAccount(ctx context.Context, accountID uuid.UUID, entityType string, entityID uuid.UUID) ([]*domain.Tag, error) {
	var contactID uuid.UUID
	var err error
	switch entityType {
	case "contact":
		err = r.db.QueryRow(ctx, `SELECT id FROM contacts WHERE id=$1 AND account_id=$2`, entityID, accountID).Scan(&contactID)
	case "lead":
		err = r.db.QueryRow(ctx, `SELECT contact_id FROM leads WHERE id=$1 AND account_id=$2 AND contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	case "chat":
		err = r.db.QueryRow(ctx, `SELECT contact_id FROM chats WHERE id=$1 AND account_id=$2 AND contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	case "participant":
		err = r.db.QueryRow(ctx, `SELECT ep.contact_id FROM event_participants ep JOIN events e ON e.id=ep.event_id WHERE ep.id=$1 AND e.account_id=$2 AND ep.contact_id IS NOT NULL`, entityID, accountID).Scan(&contactID)
	default:
		return nil, fmt.Errorf("tipo de entidad inválido")
	}
	if err != nil {
		if err == pgx.ErrNoRows {
			return nil, ErrCRMNotFound
		}
		return nil, err
	}
	rows, err := r.db.Query(ctx, `
		SELECT t.id, t.account_id, t.name, t.color, t.created_at
		FROM contact_tags ct JOIN tags t ON t.id=ct.tag_id
		WHERE ct.contact_id=$1 AND t.account_id=$2 ORDER BY t.name
	`, contactID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := make([]*domain.Tag, 0)
	for rows.Next() {
		tag := &domain.Tag{}
		if err := rows.Scan(&tag.ID, &tag.AccountID, &tag.Name, &tag.Color, &tag.CreatedAt); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}
