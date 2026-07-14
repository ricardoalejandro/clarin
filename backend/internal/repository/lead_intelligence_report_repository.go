package repository

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type LeadIntelligenceReportRepository struct {
	db *pgxpool.Pool
}

const leadIntelligenceRunColumns = `id, account_id, user_id, report_type, parameters, status, phase,
	selected_reasoning, recommended_reasoning, total_items, processed_items, ai_candidate_count,
	ai_processed_count, warnings, summary, idempotency_key, cancel_requested, error_code,
	safe_error, attempt_count, heartbeat_at, created_at, started_at, completed_at, expires_at, updated_at`

type leadIntelligenceRunScanner interface{ Scan(...any) error }

func scanLeadIntelligenceRun(scanner leadIntelligenceRunScanner) (*domain.LeadIntelligenceReportRun, error) {
	var run domain.LeadIntelligenceReportRun
	var parameters, warnings, summary []byte
	err := scanner.Scan(
		&run.ID, &run.AccountID, &run.UserID, &run.ReportType, &parameters, &run.Status, &run.Phase,
		&run.SelectedReasoning, &run.RecommendedReasoning, &run.TotalItems, &run.ProcessedItems,
		&run.AICandidateCount, &run.AIProcessedCount, &warnings, &summary, &run.IdempotencyKey,
		&run.CancelRequested, &run.ErrorCode, &run.SafeError, &run.AttemptCount, &run.HeartbeatAt,
		&run.CreatedAt, &run.StartedAt, &run.CompletedAt, &run.ExpiresAt, &run.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	run.Parameters = json.RawMessage(parameters)
	run.Warnings = json.RawMessage(warnings)
	run.Summary = json.RawMessage(summary)
	return &run, nil
}

func (r *LeadIntelligenceReportRepository) CreateRun(ctx context.Context, run *domain.LeadIntelligenceReportRun) (*domain.LeadIntelligenceReportRun, bool, error) {
	if run.ID == uuid.Nil {
		run.ID = uuid.New()
	}
	if run.ReportType == "" {
		run.ReportType = domain.LeadIntelligenceReportType
	}
	created, err := scanLeadIntelligenceRun(r.db.QueryRow(ctx, `
		INSERT INTO lead_intelligence_report_runs (
			id, account_id, user_id, report_type, parameters, selected_reasoning,
			recommended_reasoning, idempotency_key
		) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
		ON CONFLICT (account_id,user_id,idempotency_key) DO NOTHING
		RETURNING `+leadIntelligenceRunColumns,
		run.ID, run.AccountID, run.UserID, run.ReportType, normalizedJSONRaw(run.Parameters, "{}"),
		run.SelectedReasoning, run.RecommendedReasoning, run.IdempotencyKey,
	))
	if err == pgx.ErrNoRows {
		existing, getErr := scanLeadIntelligenceRun(r.db.QueryRow(ctx, `SELECT `+leadIntelligenceRunColumns+` FROM lead_intelligence_report_runs WHERE account_id=$1 AND user_id=$2 AND idempotency_key=$3`, run.AccountID, run.UserID, run.IdempotencyKey))
		return existing, false, getErr
	}
	return created, true, err
}

func (r *LeadIntelligenceReportRepository) GetRun(ctx context.Context, accountID, userID, runID uuid.UUID) (*domain.LeadIntelligenceReportRun, error) {
	return scanLeadIntelligenceRun(r.db.QueryRow(ctx, `SELECT `+leadIntelligenceRunColumns+` FROM lead_intelligence_report_runs WHERE id=$1 AND account_id=$2 AND user_id=$3`, runID, accountID, userID))
}

func (r *LeadIntelligenceReportRepository) ListRuns(ctx context.Context, accountID, userID uuid.UUID, limit int) ([]domain.LeadIntelligenceReportRun, error) {
	if limit <= 0 || limit > 20 {
		limit = 10
	}
	rows, err := r.db.Query(ctx, `SELECT `+leadIntelligenceRunColumns+` FROM lead_intelligence_report_runs WHERE account_id=$1 AND user_id=$2 AND expires_at>NOW() ORDER BY created_at DESC LIMIT $3`, accountID, userID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.LeadIntelligenceReportRun, 0)
	for rows.Next() {
		run, scanErr := scanLeadIntelligenceRun(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, *run)
	}
	return result, rows.Err()
}

func (r *LeadIntelligenceReportRepository) ClaimNext(ctx context.Context) (*domain.LeadIntelligenceReportRun, error) {
	return scanLeadIntelligenceRun(r.db.QueryRow(ctx, `
		WITH candidate AS (
			SELECT id AS run_id FROM lead_intelligence_report_runs
			WHERE status='queued' AND cancel_requested=FALSE AND expires_at>NOW()
			ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE lead_intelligence_report_runs r
		SET status='running', phase='preparing_data', started_at=COALESCE(started_at,NOW()),
			heartbeat_at=NOW(), attempt_count=attempt_count+1, updated_at=NOW()
		FROM candidate WHERE r.id=candidate.run_id RETURNING `+leadIntelligenceRunColumns))
}

func (r *LeadIntelligenceReportRepository) UpdateProgress(ctx context.Context, runID uuid.UUID, phase string, total, processed, aiCandidates, aiProcessed int) error {
	_, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET phase=$2,total_items=$3,processed_items=$4,ai_candidate_count=$5,ai_processed_count=$6,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, runID, phase, total, processed, aiCandidates, aiProcessed)
	return err
}

func (r *LeadIntelligenceReportRepository) UpdateScope(ctx context.Context, runID uuid.UUID, total, aiCandidates int, recommended string) error {
	_, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET phase='ai_analysis',total_items=$2,processed_items=$2,ai_candidate_count=$3,recommended_reasoning=$4,heartbeat_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='running'`, runID, total, aiCandidates, recommended)
	return err
}

func (r *LeadIntelligenceReportRepository) IsCancellationRequested(ctx context.Context, runID uuid.UUID) (bool, error) {
	var cancelled bool
	err := r.db.QueryRow(ctx, `SELECT cancel_requested OR status='cancelled' FROM lead_intelligence_report_runs WHERE id=$1`, runID).Scan(&cancelled)
	return cancelled, err
}

func (r *LeadIntelligenceReportRepository) RequestCancel(ctx context.Context, accountID, userID, runID uuid.UUID) (bool, error) {
	cmd, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET cancel_requested=TRUE,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,phase=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END,completed_at=CASE WHEN status='queued' THEN NOW() ELSE completed_at END,updated_at=NOW() WHERE id=$1 AND account_id=$2 AND user_id=$3 AND status IN ('queued','running')`, runID, accountID, userID)
	return cmd.RowsAffected() > 0, err
}

func (r *LeadIntelligenceReportRepository) MarkCancelled(ctx context.Context, runID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET status='cancelled',phase='cancelled',cancel_requested=TRUE,completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW() WHERE id=$1 AND status IN ('queued','running')`, runID)
	return err
}

func (r *LeadIntelligenceReportRepository) ReplaceItems(ctx context.Context, run *domain.LeadIntelligenceReportRun, items []domain.LeadIntelligenceReportItem) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `DELETE FROM lead_intelligence_report_items WHERE run_id=$1 AND account_id=$2`, run.ID, run.AccountID); err != nil {
		return err
	}
	_, err = tx.CopyFrom(ctx, pgx.Identifier{"lead_intelligence_report_items"}, []string{"run_id", "account_id", "lead_id", "position", "ai_analyzed", "row_data"}, pgx.CopyFromSlice(len(items), func(i int) ([]any, error) {
		item := items[i]
		return []any{run.ID, run.AccountID, item.LeadID, item.Position, item.AIAnalyzed, normalizedJSONRaw(item.RowData, "{}")}, nil
	}))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *LeadIntelligenceReportRepository) Complete(ctx context.Context, runID uuid.UUID, summary, warnings json.RawMessage, withWarnings bool) error {
	status := domain.LeadIntelligenceRunCompleted
	if withWarnings {
		status = domain.LeadIntelligenceRunCompletedWithWarnings
	}
	_, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET
		status=CASE WHEN cancel_requested THEN 'cancelled' ELSE $2 END,
		phase=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'completed' END,
		summary=$3::jsonb,warnings=$4::jsonb,processed_items=total_items,completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW()
		WHERE id=$1 AND status='running'`, runID, status, normalizedJSONRaw(summary, "{}"), normalizedJSONRaw(warnings, "[]"))
	return err
}

func (r *LeadIntelligenceReportRepository) Fail(ctx context.Context, runID uuid.UUID, code, safeError string) error {
	_, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET status='failed',phase='failed',error_code=$2,safe_error=$3,completed_at=NOW(),heartbeat_at=NULL,updated_at=NOW() WHERE id=$1 AND status='running'`, runID, code, safeError)
	return err
}

func (r *LeadIntelligenceReportRepository) GetItems(ctx context.Context, accountID, userID, runID uuid.UUID) ([]domain.LeadIntelligenceReportItem, error) {
	rows, err := r.db.Query(ctx, `SELECT i.run_id,i.account_id,i.lead_id,i.position,i.ai_analyzed,i.row_data FROM lead_intelligence_report_items i JOIN lead_intelligence_report_runs r ON r.id=i.run_id AND r.account_id=i.account_id WHERE i.run_id=$1 AND i.account_id=$2 AND r.user_id=$3 AND r.status IN ('completed','completed_with_warnings') ORDER BY i.position`, runID, accountID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.LeadIntelligenceReportItem, 0)
	for rows.Next() {
		var item domain.LeadIntelligenceReportItem
		var data []byte
		if err := rows.Scan(&item.RunID, &item.AccountID, &item.LeadID, &item.Position, &item.AIAnalyzed, &data); err != nil {
			return nil, err
		}
		item.RowData = json.RawMessage(data)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *LeadIntelligenceReportRepository) RecoverStale(ctx context.Context, lease time.Duration) (int64, error) {
	cmd, err := r.db.Exec(ctx, `UPDATE lead_intelligence_report_runs SET
		status=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'queued' END,
		phase=CASE WHEN cancel_requested THEN 'cancelled' ELSE 'recovered' END,
		completed_at=CASE WHEN cancel_requested THEN NOW() ELSE completed_at END,
		heartbeat_at=NULL,updated_at=NOW()
		WHERE status='running' AND COALESCE(heartbeat_at,started_at,created_at)<$1`, time.Now().Add(-lease))
	return cmd.RowsAffected(), err
}

func (r *LeadIntelligenceReportRepository) PurgeExpired(ctx context.Context) (int64, error) {
	cmd, err := r.db.Exec(ctx, `DELETE FROM lead_intelligence_report_runs WHERE expires_at<NOW() AND status<>'running'`)
	return cmd.RowsAffected(), err
}
