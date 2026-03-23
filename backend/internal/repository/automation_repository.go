package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

// AutomationRepository handles persistence for automations and executions.
type AutomationRepository struct {
	db *pgxpool.Pool
}

// ─── Automation CRUD ──────────────────────────────────────────────────────────

func (r *AutomationRepository) Create(ctx context.Context, a *domain.Automation) error {
	configJSON, _ := json.Marshal(a.Config)
	triggerConfigJSON, _ := json.Marshal(a.TriggerConfig)
	return r.db.QueryRow(ctx, `
		INSERT INTO automations (account_id, name, description, trigger_type, trigger_config, config, is_active)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, created_at, updated_at
	`, a.AccountID, a.Name, a.Description, a.TriggerType, triggerConfigJSON, configJSON, a.IsActive).
		Scan(&a.ID, &a.CreatedAt, &a.UpdatedAt)
}

func (r *AutomationRepository) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.Automation, error) {
	row := r.db.QueryRow(ctx, `
		SELECT id, account_id, name, description, trigger_type, trigger_config, config,
		       is_active, execution_count, last_triggered_at, created_at, updated_at
		FROM automations WHERE id = $1 AND account_id = $2
	`, id, accountID)
	return scanAutomation(row)
}

func (r *AutomationRepository) List(ctx context.Context, accountID uuid.UUID) ([]*domain.Automation, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, description, trigger_type, trigger_config, config,
		       is_active, execution_count, last_triggered_at, created_at, updated_at
		FROM automations WHERE account_id = $1 ORDER BY created_at DESC
	`, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*domain.Automation
	for rows.Next() {
		a, err := scanAutomation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}

func (r *AutomationRepository) Update(ctx context.Context, a *domain.Automation) error {
	configJSON, _ := json.Marshal(a.Config)
	triggerConfigJSON, _ := json.Marshal(a.TriggerConfig)
	_, err := r.db.Exec(ctx, `
		UPDATE automations
		SET name=$1, description=$2, trigger_type=$3, trigger_config=$4, config=$5, is_active=$6, updated_at=NOW()
		WHERE id=$7 AND account_id=$8
	`, a.Name, a.Description, a.TriggerType, triggerConfigJSON, configJSON, a.IsActive, a.ID, a.AccountID)
	return err
}

func (r *AutomationRepository) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `DELETE FROM automations WHERE id=$1 AND account_id=$2`, id, accountID)
	return err
}

func (r *AutomationRepository) SetActive(ctx context.Context, id, accountID uuid.UUID, active bool) error {
	_, err := r.db.Exec(ctx, `UPDATE automations SET is_active=$1, updated_at=NOW() WHERE id=$2 AND account_id=$3`, active, id, accountID)
	return err
}

// GetByTrigger returns all active automations for an account with the given trigger type.
func (r *AutomationRepository) GetByTrigger(ctx context.Context, accountID uuid.UUID, triggerType string) ([]*domain.Automation, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, account_id, name, description, trigger_type, trigger_config, config,
		       is_active, execution_count, last_triggered_at, created_at, updated_at
		FROM automations WHERE account_id=$1 AND trigger_type=$2 AND is_active=TRUE
	`, accountID, triggerType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*domain.Automation
	for rows.Next() {
		a, err := scanAutomation(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, a)
	}
	return result, rows.Err()
}

// IncrementExecutionCount bumps the count and sets last_triggered_at.
func (r *AutomationRepository) IncrementExecutionCount(ctx context.Context, id uuid.UUID) error {
	_, err := r.db.Exec(ctx, `
		UPDATE automations SET execution_count=execution_count+1, last_triggered_at=NOW() WHERE id=$1
	`, id)
	return err
}

// ─── Deduplication ───────────────────────────────────────────────────────────

// HasActiveExecutionRecent returns true if there is already a pending/running/paused
// execution for this (automationID, leadID) pair created within the last 5 minutes.
func (r *AutomationRepository) HasActiveExecutionRecent(ctx context.Context, automationID uuid.UUID, leadID *uuid.UUID) (bool, error) {
	var count int
	if leadID == nil {
		// Manual / no-lead trigger: no dedup
		return false, nil
	}
	err := r.db.QueryRow(ctx, `
		SELECT COUNT(*) FROM automation_executions
		WHERE automation_id=$1 AND lead_id=$2
		  AND status IN ('pending','running','paused')
		  AND created_at > NOW() - INTERVAL '5 minutes'
	`, automationID, *leadID).Scan(&count)
	return count > 0, err
}

// ─── Execution CRUD ───────────────────────────────────────────────────────────

func (r *AutomationRepository) CreateExecution(ctx context.Context, e *domain.AutomationExecution) error {
	snapshotJSON, _ := json.Marshal(e.ConfigSnapshot)
	ctxJSON, _ := json.Marshal(e.ContextData)
	return r.db.QueryRow(ctx, `
		INSERT INTO automation_executions
		  (automation_id, account_id, lead_id, status, current_node_id, config_snapshot, context_data)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		RETURNING id, created_at, started_at
	`, e.AutomationID, e.AccountID, e.LeadID, e.Status, e.CurrentNodeID, snapshotJSON, ctxJSON).
		Scan(&e.ID, &e.CreatedAt, &e.StartedAt)
}

func (r *AutomationRepository) UpdateExecution(ctx context.Context, e *domain.AutomationExecution) error {
	ctxJSON, _ := json.Marshal(e.ContextData)
	_, err := r.db.Exec(ctx, `
		UPDATE automation_executions
		SET status=$1, current_node_id=$2, next_node_id=$3, resume_at=$4,
		    context_data=$5, error_message=$6, completed_at=$7
		WHERE id=$8
	`, e.Status, e.CurrentNodeID, e.NextNodeID, e.ResumeAt, ctxJSON, e.ErrorMessage, e.CompletedAt, e.ID)
	return err
}

// GetPausedDue returns executions with status='paused' and resume_at <= now (max 100).
func (r *AutomationRepository) GetPausedDue(ctx context.Context) ([]*domain.AutomationExecution, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, automation_id, account_id, lead_id, status, current_node_id, next_node_id,
		       resume_at, config_snapshot, context_data, error_message, started_at, completed_at, created_at
		FROM automation_executions
		WHERE status='paused' AND resume_at <= NOW()
		ORDER BY resume_at ASC
		LIMIT 100
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*domain.AutomationExecution
	for rows.Next() {
		e, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}

// GetExecutionByID loads a single execution by its ID.
func (r *AutomationRepository) GetExecutionByID(ctx context.Context, id uuid.UUID) (*domain.AutomationExecution, error) {
	row := r.db.QueryRow(ctx, `
		SELECT id, automation_id, account_id, lead_id, status, current_node_id, next_node_id,
		       resume_at, config_snapshot, context_data, error_message, started_at, completed_at, created_at
		FROM automation_executions WHERE id=$1
	`, id)
	e, err := scanExecution(row)
	if err != nil {
		return nil, err
	}
	return e, nil
}

// GetRecentExecutions returns recent executions for an automation (for UI history).
func (r *AutomationRepository) GetRecentExecutions(ctx context.Context, automationID, accountID uuid.UUID, limit int) ([]*domain.AutomationExecution, error) {
	rows, err := r.db.Query(ctx, `
		SELECT ae.id, ae.automation_id, ae.account_id, ae.lead_id, ae.status, ae.current_node_id,
		       ae.next_node_id, ae.resume_at, ae.config_snapshot, ae.context_data, ae.error_message,
		       ae.started_at, ae.completed_at, ae.created_at
		FROM automation_executions ae
		WHERE ae.automation_id=$1 AND ae.account_id=$2
		ORDER BY ae.created_at DESC LIMIT $3
	`, automationID, accountID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*domain.AutomationExecution
	for rows.Next() {
		e, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}

// GetExecutionLogs returns all node logs for an execution.
func (r *AutomationRepository) GetExecutionLogs(ctx context.Context, executionID uuid.UUID) ([]*domain.AutomationExecutionLog, error) {
	rows, err := r.db.Query(ctx, `
		SELECT id, execution_id, node_id, node_type, status, duration_ms, error, created_at
		FROM automation_execution_logs WHERE execution_id=$1 ORDER BY created_at ASC
	`, executionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var result []*domain.AutomationExecutionLog
	for rows.Next() {
		l := &domain.AutomationExecutionLog{}
		if err := rows.Scan(&l.ID, &l.ExecutionID, &l.NodeID, &l.NodeType, &l.Status, &l.DurationMs, &l.Error, &l.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, l)
	}
	return result, rows.Err()
}

// AppendLog inserts a node execution log entry.
func (r *AutomationRepository) AppendLog(ctx context.Context, l *domain.AutomationExecutionLog) error {
	return r.db.QueryRow(ctx, `
		INSERT INTO automation_execution_logs (execution_id, node_id, node_type, status, duration_ms, error)
		VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at
	`, l.ExecutionID, l.NodeID, l.NodeType, l.Status, l.DurationMs, l.Error).
		Scan(&l.ID, &l.CreatedAt)
}

// GetStats returns execution statistics for an automation.
func (r *AutomationRepository) GetStats(ctx context.Context, automationID uuid.UUID) (*domain.AutomationStats, error) {
	stats := &domain.AutomationStats{}
	err := r.db.QueryRow(ctx, `
		SELECT
			COUNT(*) AS total,
			COUNT(*) FILTER (WHERE status='completed') AS completed,
			COUNT(*) FILTER (WHERE status='failed') AS failed,
			COUNT(*) FILTER (WHERE status IN ('pending','running','paused')) AS active
		FROM automation_executions WHERE automation_id=$1
	`, automationID).Scan(&stats.TotalExecutions, &stats.CompletedExecutions, &stats.FailedExecutions, &stats.ActiveExecutions)
	return stats, err
}

// PurgeOldLogs deletes execution logs older than retentionDays days.
func (r *AutomationRepository) PurgeOldLogs(ctx context.Context, retentionDays int) error {
	cutoff := time.Now().AddDate(0, 0, -retentionDays)
	_, err := r.db.Exec(ctx, `
		DELETE FROM automation_execution_logs
		WHERE execution_id IN (
			SELECT id FROM automation_executions WHERE created_at < $1
		)
	`, cutoff)
	return err
}

// ─── Scan helpers ─────────────────────────────────────────────────────────────

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAutomation(row rowScanner) (*domain.Automation, error) {
	a := &domain.Automation{}
	var configJSON, triggerConfigJSON []byte
	err := row.Scan(
		&a.ID, &a.AccountID, &a.Name, &a.Description, &a.TriggerType,
		&triggerConfigJSON, &configJSON, &a.IsActive, &a.ExecutionCount,
		&a.LastTriggeredAt, &a.CreatedAt, &a.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(configJSON, &a.Config)
	_ = json.Unmarshal(triggerConfigJSON, &a.TriggerConfig)
	return a, nil
}

func scanExecution(row rowScanner) (*domain.AutomationExecution, error) {
	e := &domain.AutomationExecution{}
	var snapshotJSON, ctxJSON []byte
	err := row.Scan(
		&e.ID, &e.AutomationID, &e.AccountID, &e.LeadID, &e.Status,
		&e.CurrentNodeID, &e.NextNodeID, &e.ResumeAt, &snapshotJSON, &ctxJSON,
		&e.ErrorMessage, &e.StartedAt, &e.CompletedAt, &e.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	if snapshotJSON != nil {
		e.ConfigSnapshot = &domain.AutomationGraph{}
		_ = json.Unmarshal(snapshotJSON, e.ConfigSnapshot)
	}
	if ctxJSON != nil {
		_ = json.Unmarshal(ctxJSON, &e.ContextData)
	}
	return e, nil
}
