package repository

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

type ErosRunRepository struct {
	db *pgxpool.Pool
}

var ErrErosConversationBusy = errors.New("Eros conversation has an active run")
var ErrErosRunNotStartable = errors.New("Eros run is no longer startable")
var ErrErosRunCancelled = errors.New("Eros run was cancelled")

const erosRunColumns = `id, account_id, user_id, conversation_id, kind, task_key,
	parameters, permissions, status, phase, idempotency_key, codex_thread_id, codex_turn_id,
	attempt_count, max_attempts, next_attempt_at, locked_at, heartbeat_at, cancel_requested,
	error_code, safe_error, result, created_at, started_at, completed_at, updated_at, parent_run_id`

type erosRunScanner interface{ Scan(...any) error }

type ErosAttachmentFactory func(messageID uuid.UUID) *domain.ErosFile

func scanErosRun(scanner erosRunScanner) (*domain.ErosRun, error) {
	var run domain.ErosRun
	var parameters, result []byte
	err := scanner.Scan(
		&run.ID, &run.AccountID, &run.UserID, &run.ConversationID, &run.Kind, &run.TaskKey,
		&parameters, &run.Permissions, &run.Status, &run.Phase, &run.IdempotencyKey,
		&run.CodexThreadID, &run.CodexTurnID, &run.AttemptCount, &run.MaxAttempts,
		&run.NextAttemptAt, &run.LockedAt, &run.HeartbeatAt, &run.CancelRequested,
		&run.ErrorCode, &run.SafeError, &result, &run.CreatedAt, &run.StartedAt,
		&run.CompletedAt, &run.UpdatedAt, &run.ParentRunID,
	)
	if err != nil {
		return nil, err
	}
	run.Parameters = json.RawMessage(parameters)
	run.Result = json.RawMessage(result)
	return &run, nil
}

func IsErosConversationBusy(err error) bool {
	if errors.Is(err, ErrErosConversationBusy) {
		return true
	}
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "uq_eros_runs_active_conversation"
}

// CreateWithUserMessage atomically creates the durable run and its user message.
func (r *ErosRunRepository) CreateWithUserMessage(ctx context.Context, run *domain.ErosRun, message string) (*domain.ErosRun, bool, error) {
	if run.ID == uuid.Nil {
		run.ID = uuid.New()
	}
	if run.MaxAttempts <= 0 {
		run.MaxAttempts = 2
	}
	params := normalizedJSONRaw(run.Parameters, "{}")
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)

	row := tx.QueryRow(ctx, `
		INSERT INTO eros_runs (id, account_id, user_id, conversation_id, kind, task_key, parameters,
			permissions, status, phase, idempotency_key, max_attempts, parent_run_id)
		SELECT $1,$2,$3,$4,$5,$6,$7::jsonb,$8,'queued','queued',$9,$10,$11
		FROM eros_conversations c
		WHERE c.id=$4 AND c.account_id=$2 AND c.user_id=$3
		ON CONFLICT (account_id, user_id, idempotency_key) DO NOTHING
		RETURNING `+erosRunColumns,
		run.ID, run.AccountID, run.UserID, run.ConversationID, run.Kind, run.TaskKey,
		params, run.Permissions, run.IdempotencyKey, run.MaxAttempts, run.ParentRunID,
	)
	created, scanErr := scanErosRun(row)
	if scanErr == pgx.ErrNoRows {
		existing, getErr := scanErosRun(tx.QueryRow(ctx, `SELECT `+erosRunColumns+` FROM eros_runs WHERE account_id=$1 AND user_id=$2 AND idempotency_key=$3`, run.AccountID, run.UserID, run.IdempotencyKey))
		if getErr != nil {
			return nil, false, getErr
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, false, err
		}
		return existing, false, nil
	}
	if scanErr != nil {
		return nil, false, scanErr
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO eros_messages (conversation_id, run_id, role, content)
		VALUES ($1,$2,'user',$3)
	`, run.ConversationID, run.ID, message); err != nil {
		return nil, false, err
	}
	if _, err := tx.Exec(ctx, `UPDATE eros_conversations SET last_status='queued', last_error='', updated_at=NOW() WHERE id=$1 AND account_id=$2 AND user_id=$3`, run.ConversationID, run.AccountID, run.UserID); err != nil {
		return nil, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return created, true, nil
}

func (r *ErosRunRepository) Get(ctx context.Context, accountID, userID, runID uuid.UUID) (*domain.ErosRun, error) {
	return scanErosRun(r.db.QueryRow(ctx, `SELECT `+erosRunColumns+` FROM eros_runs WHERE id=$1 AND account_id=$2 AND user_id=$3`, runID, accountID, userID))
}

func (r *ErosRunRepository) GetByID(ctx context.Context, runID uuid.UUID) (*domain.ErosRun, error) {
	return scanErosRun(r.db.QueryRow(ctx, `SELECT `+erosRunColumns+` FROM eros_runs WHERE id=$1`, runID))
}

func (r *ErosRunRepository) ListActive(ctx context.Context, accountID, userID uuid.UUID) ([]domain.ErosRun, error) {
	rows, err := r.db.Query(ctx, `SELECT `+erosRunColumns+` FROM eros_runs WHERE account_id=$1 AND user_id=$2 AND status IN ('queued','starting','running','waiting_for_input') ORDER BY created_at`, accountID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.ErosRun, 0)
	for rows.Next() {
		run, err := scanErosRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *run)
	}
	return out, rows.Err()
}

// WaitForInput persists the assistant question and releases the worker lease.
func (r *ErosRunRepository) WaitForInput(ctx context.Context, run *domain.ErosRun, content, model, effort string, durationMS int64, metadata, toolCalls, result json.RawMessage) (*domain.ErosMessage, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var active bool
	if err = tx.QueryRow(ctx, `SELECT status IN ('starting','running') AND cancel_requested=FALSE FROM eros_runs WHERE id=$1 FOR UPDATE`, run.ID).Scan(&active); err != nil {
		return nil, err
	}
	if !active {
		return nil, ErrErosRunCancelled
	}
	var msg domain.ErosMessage
	var savedMetadata, savedTools []byte
	err = tx.QueryRow(ctx, `INSERT INTO eros_messages (conversation_id,run_id,role,content,codex_model,reasoning_effort,duration_ms,metadata,tool_calls)
		VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7::jsonb,$8::jsonb)
		RETURNING id,conversation_id,run_id,role,content,codex_model,reasoning_effort,duration_ms,metadata,tool_calls,created_at`,
		run.ConversationID, run.ID, content, model, effort, durationMS, normalizedJSONRaw(metadata, "{}"), normalizedJSONRaw(toolCalls, "[]")).Scan(
		&msg.ID, &msg.ConversationID, &msg.RunID, &msg.Role, &msg.Content, &msg.CodexModel, &msg.ReasoningEffort, &msg.DurationMS, &savedMetadata, &savedTools, &msg.CreatedAt)
	if err != nil {
		return nil, err
	}
	msg.Metadata, msg.ToolCalls = json.RawMessage(savedMetadata), json.RawMessage(savedTools)
	if _, err = tx.Exec(ctx, `UPDATE eros_runs SET status='waiting_for_input',phase='waiting_for_input',result=$2::jsonb,locked_at=NULL,heartbeat_at=NULL,updated_at=NOW() WHERE id=$1`, run.ID, normalizedJSONRaw(result, "{}")); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE eros_conversations SET last_status='waiting_for_input',last_error='',updated_at=NOW() WHERE id=$1`, run.ConversationID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &msg, nil
}

// AnswerClarification closes the waiting run and creates its child atomically.
func (r *ErosRunRepository) AnswerClarification(ctx context.Context, parent *domain.ErosRun, child *domain.ErosRun, message string) (*domain.ErosRun, bool, error) {
	if child.ID == uuid.Nil {
		child.ID = uuid.New()
	}
	if child.MaxAttempts <= 0 {
		child.MaxAttempts = 2
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback(ctx)
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM eros_runs WHERE id=$1 AND account_id=$2 AND user_id=$3 FOR UPDATE`, parent.ID, parent.AccountID, parent.UserID).Scan(&status); err != nil {
		return nil, false, err
	}
	if status != domain.ErosRunWaitingForInput {
		existing, getErr := scanErosRun(tx.QueryRow(ctx, `SELECT `+erosRunColumns+` FROM eros_runs WHERE account_id=$1 AND user_id=$2 AND idempotency_key=$3`, child.AccountID, child.UserID, child.IdempotencyKey))
		if getErr == nil {
			_ = tx.Commit(ctx)
			return existing, false, nil
		}
		return nil, false, ErrErosRunNotStartable
	}
	if _, err = tx.Exec(ctx, `UPDATE eros_runs SET status='completed',phase='clarification_answered',completed_at=NOW(),updated_at=NOW() WHERE id=$1`, parent.ID); err != nil {
		return nil, false, err
	}
	created, scanErr := scanErosRun(tx.QueryRow(ctx, `INSERT INTO eros_runs (id,account_id,user_id,conversation_id,kind,task_key,parameters,permissions,status,phase,idempotency_key,max_attempts,parent_run_id)
		VALUES ($1,$2,$3,$4,'chat','',$5::jsonb,$6,'queued','queued',$7,$8,$9)
		ON CONFLICT (account_id,user_id,idempotency_key) DO NOTHING RETURNING `+erosRunColumns,
		child.ID, child.AccountID, child.UserID, child.ConversationID, normalizedJSONRaw(child.Parameters, "{}"), child.Permissions, child.IdempotencyKey, child.MaxAttempts, parent.ID))
	if scanErr != nil {
		return nil, false, scanErr
	}
	if _, err = tx.Exec(ctx, `INSERT INTO eros_messages (conversation_id,run_id,role,content) VALUES ($1,$2,'user',$3)`, child.ConversationID, created.ID, message); err != nil {
		return nil, false, err
	}
	if _, err = tx.Exec(ctx, `UPDATE eros_conversations SET last_status='queued',updated_at=NOW() WHERE id=$1`, child.ConversationID); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, false, err
	}
	return created, true, nil
}

func (r *ErosRunRepository) ClaimNext(ctx context.Context) (*domain.ErosRun, error) {
	return r.ClaimNextKind(ctx, "")
}

// ClaimNextKind gives deterministic quick tasks their own worker pool while
// preserving SKIP LOCKED semantics. An empty kind keeps compatibility with
// callers that want the global queue.
func (r *ErosRunRepository) ClaimNextKind(ctx context.Context, kind string) (*domain.ErosRun, error) {
	return scanErosRun(r.db.QueryRow(ctx, `
		WITH candidate AS (
			SELECT id AS run_id FROM eros_runs
			WHERE status='queued' AND next_attempt_at <= NOW() AND cancel_requested=FALSE
			  AND ($1='' OR kind=$1)
			ORDER BY next_attempt_at, created_at
			FOR UPDATE SKIP LOCKED LIMIT 1
		)
		UPDATE eros_runs r SET status='starting', phase='starting', locked_at=NOW(), heartbeat_at=NOW(),
			started_at=COALESCE(started_at,NOW()), attempt_count=attempt_count+1, updated_at=NOW()
		FROM candidate WHERE r.id=candidate.run_id
		RETURNING `+erosRunColumns, kind))
}

func (r *ErosRunRepository) MarkRunning(ctx context.Context, runID uuid.UUID) error {
	cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET status='running', phase='processing', heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1 AND status='starting' AND cancel_requested=FALSE`, runID)
	if err == nil && cmd.RowsAffected() == 0 {
		return ErrErosRunNotStartable
	}
	return err
}

func (r *ErosRunRepository) Heartbeat(ctx context.Context, runID uuid.UUID, phase string) error {
	_, err := r.db.Exec(ctx, `UPDATE eros_runs SET heartbeat_at=NOW(), phase=COALESCE(NULLIF($2,''),phase), updated_at=NOW() WHERE id=$1 AND status IN ('starting','running')`, runID, phase)
	return err
}

func (r *ErosRunRepository) UpdateBridgeIDs(ctx context.Context, runID uuid.UUID, threadID, turnID string) error {
	_, err := r.db.Exec(ctx, `UPDATE eros_runs SET codex_thread_id=COALESCE(NULLIF($2,''),codex_thread_id), codex_turn_id=COALESCE(NULLIF($3,''),codex_turn_id), heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1`, runID, threadID, turnID)
	return err
}

// ClearBridgeIDs is used only after reconciliation proved that an earlier
// timed-out turn is terminal (interrupted). Unknown or still-running turns keep
// their identifiers so a retry cannot duplicate work.
func (r *ErosRunRepository) ClearBridgeIDs(ctx context.Context, runID uuid.UUID, threadID, turnID string) error {
	cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET codex_thread_id='', codex_turn_id='', heartbeat_at=NOW(), updated_at=NOW() WHERE id=$1 AND codex_thread_id=$2 AND codex_turn_id=$3 AND status='running'`, runID, threadID, turnID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return errors.New("Eros bridge identifiers changed while preparing a retry")
	}
	return nil
}

func (r *ErosRunRepository) UserMessage(ctx context.Context, runID uuid.UUID) (*domain.ErosMessage, error) {
	var msg domain.ErosMessage
	var metadata, tools []byte
	err := r.db.QueryRow(ctx, `SELECT id, conversation_id, run_id, role, content, COALESCE(codex_model,''), COALESCE(reasoning_effort,''), COALESCE(duration_ms,0), COALESCE(metadata,'{}'::jsonb), COALESCE(tool_calls,'[]'::jsonb), created_at FROM eros_messages WHERE run_id=$1 AND role='user'`, runID).Scan(
		&msg.ID, &msg.ConversationID, &msg.RunID, &msg.Role, &msg.Content, &msg.CodexModel, &msg.ReasoningEffort, &msg.DurationMS, &metadata, &tools, &msg.CreatedAt,
	)
	msg.Metadata, msg.ToolCalls = json.RawMessage(metadata), json.RawMessage(tools)
	return &msg, err
}

func (r *ErosRunRepository) Complete(ctx context.Context, run *domain.ErosRun, content, model, effort string, durationMS int64, metadata, toolCalls, result json.RawMessage, attachmentFactory ErosAttachmentFactory) (*domain.ErosMessage, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var completable bool
	if err = tx.QueryRow(ctx, `SELECT status IN ('starting','running') AND cancel_requested=FALSE FROM eros_runs WHERE id=$1 FOR UPDATE`, run.ID).Scan(&completable); err != nil {
		return nil, err
	}
	if !completable {
		return nil, ErrErosRunCancelled
	}
	var msg domain.ErosMessage
	var savedMetadata, savedTools []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO eros_messages (conversation_id, run_id, role, content, codex_model, reasoning_effort, duration_ms, metadata, tool_calls)
		VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7::jsonb,$8::jsonb)
		ON CONFLICT (run_id, role) WHERE run_id IS NOT NULL DO UPDATE SET content=EXCLUDED.content
		RETURNING id, conversation_id, run_id, role, content, codex_model, reasoning_effort, duration_ms, metadata, tool_calls, created_at
	`, run.ConversationID, run.ID, content, model, effort, durationMS, normalizedJSONRaw(metadata, "{}"), normalizedJSONRaw(toolCalls, "[]")).Scan(
		&msg.ID, &msg.ConversationID, &msg.RunID, &msg.Role, &msg.Content, &msg.CodexModel, &msg.ReasoningEffort, &msg.DurationMS, &savedMetadata, &savedTools, &msg.CreatedAt,
	)
	if err != nil {
		return nil, err
	}
	msg.Metadata, msg.ToolCalls = json.RawMessage(savedMetadata), json.RawMessage(savedTools)
	if attachmentFactory != nil {
		if file := attachmentFactory(msg.ID); file != nil {
			if file.ID == uuid.Nil {
				file.ID = uuid.New()
			}
			file.AccountID = run.AccountID
			file.UserID = run.UserID
			file.ConversationID = run.ConversationID
			file.MessageID = msg.ID
			if _, err = tx.Exec(ctx, `
				INSERT INTO eros_files (
					id, account_id, user_id, conversation_id, message_id, filename, format, content_type,
					status, size_bytes, checksum, generation_spec, expires_at
				) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE(NULLIF($9,''),'ready'),$10,$11,$12::jsonb,$13)
			`, file.ID, file.AccountID, file.UserID, file.ConversationID, file.MessageID,
				file.Filename, file.Format, file.ContentType, file.Status, file.SizeBytes, file.Checksum,
				normalizedJSONRaw(file.GenerationSpec, "{}"), file.ExpiresAt); err != nil {
				return nil, err
			}
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE eros_runs SET status='completed', phase='completed', result=$2::jsonb, completed_at=NOW(), locked_at=NULL, heartbeat_at=NOW(), error_code='', safe_error='', updated_at=NOW() WHERE id=$1`, run.ID, normalizedJSONRaw(result, "{}")); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE eros_conversations SET codex_thread_id=COALESCE(NULLIF($2,''),codex_thread_id), last_status='completed', last_error='', updated_at=NOW() WHERE id=$1`, run.ConversationID, run.CodexThreadID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &msg, nil
}

func (r *ErosRunRepository) RetryOrFail(ctx context.Context, run *domain.ErosRun, delay time.Duration, code, safeError string) (bool, error) {
	if run.AttemptCount < run.MaxAttempts && !run.CancelRequested {
		cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET status='queued', phase='retrying', next_attempt_at=NOW()+$2::interval, locked_at=NULL, heartbeat_at=NULL, error_code=$3, safe_error=$4, updated_at=NOW() WHERE id=$1 AND cancel_requested=FALSE`, run.ID, delay.String(), code, safeError)
		return cmd.RowsAffected() > 0, err
	}
	_, err := r.db.Exec(ctx, `UPDATE eros_runs SET status='failed', phase='failed', completed_at=NOW(), locked_at=NULL, heartbeat_at=NULL, error_code=$2, safe_error=$3, updated_at=NOW() WHERE id=$1`, run.ID, code, safeError)
	_, _ = r.db.Exec(ctx, `UPDATE eros_conversations SET last_status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`, run.ConversationID, safeError)
	return false, err
}

func (r *ErosRunRepository) RequestCancel(ctx context.Context, accountID, userID, runID uuid.UUID) (bool, error) {
	cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET cancel_requested=TRUE, status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END, phase=CASE WHEN status='queued' THEN 'cancelled' ELSE 'cancelling' END, completed_at=CASE WHEN status='queued' THEN NOW() ELSE completed_at END, updated_at=NOW() WHERE id=$1 AND account_id=$2 AND user_id=$3 AND status IN ('queued','starting','running')`, runID, accountID, userID)
	return cmd.RowsAffected() > 0, err
}

func (r *ErosRunRepository) MarkCancelled(ctx context.Context, runID uuid.UUID) error {
	_, err := r.db.Exec(ctx, `UPDATE eros_runs SET status='cancelled', phase='cancelled', cancel_requested=TRUE, completed_at=NOW(), locked_at=NULL, heartbeat_at=NULL, updated_at=NOW() WHERE id=$1 AND status IN ('starting','running','queued')`, runID)
	return err
}

func (r *ErosRunRepository) ResetFailed(ctx context.Context, accountID, userID, runID uuid.UUID) (bool, error) {
	cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET status='queued', phase='queued', attempt_count=0, next_attempt_at=NOW(), cancel_requested=FALSE, error_code='', safe_error='', codex_thread_id='', codex_turn_id='', completed_at=NULL, locked_at=NULL, heartbeat_at=NULL, updated_at=NOW() WHERE id=$1 AND account_id=$2 AND user_id=$3 AND status='failed'`, runID, accountID, userID)
	return cmd.RowsAffected() > 0, err
}

func (r *ErosRunRepository) RecoverStale(ctx context.Context, lease time.Duration) (int64, error) {
	cmd, err := r.db.Exec(ctx, `UPDATE eros_runs SET
		status=CASE WHEN cancel_requested THEN 'cancelled' WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
		phase=CASE WHEN cancel_requested THEN 'cancelled' WHEN attempt_count < max_attempts THEN 'recovered' ELSE 'failed' END,
		next_attempt_at=NOW(), locked_at=NULL, heartbeat_at=NULL,
		error_code=CASE WHEN cancel_requested THEN '' ELSE 'worker_restarted' END,
		safe_error=CASE WHEN cancel_requested OR attempt_count < max_attempts THEN '' ELSE 'La ejecución se interrumpió al reiniciar el servicio.' END,
		completed_at=CASE WHEN cancel_requested OR attempt_count >= max_attempts THEN NOW() ELSE NULL END,
		updated_at=NOW()
		WHERE status IN ('starting','running')
		AND COALESCE(heartbeat_at,locked_at,updated_at) < NOW()-$1::interval`, lease.String())
	return cmd.RowsAffected(), err
}
