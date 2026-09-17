package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrOfflineTerminalNotFound          = errors.New("offline terminal not found")
	ErrOfflineTerminalNotActive         = errors.New("offline terminal is not active")
	ErrOfflineTerminalNotRequested      = errors.New("offline terminal is not awaiting approval")
	ErrOfflineTerminalExists            = errors.New("an offline terminal request already exists")
	ErrOfflineEnrollmentInvalid         = errors.New("offline enrollment invalid or expired")
	ErrOfflineResourceInvalid           = errors.New("offline resource is outside the selected account")
	ErrOfflineDeviceRiskNotAcknowledged = errors.New("offline device risk was not acknowledged")
)

type OfflineRepository struct{ db *pgxpool.Pool }

// RequestTerminal records the identity produced by the trusted desktop shell.
// The authenticated user comes from the JWT and cannot be supplied by a client.
func (r *OfflineRepository) RequestTerminal(ctx context.Context, terminalID, userID uuid.UUID, displayName, sidHash, installInstanceHash, clientVersion, publicKeyPEM string, posture domain.OfflineDevicePosture) (*domain.OfflineTerminal, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var allowed bool
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM offline_terminals WHERE state IN ('requested','approved','active'))<50
		AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND is_active=TRUE AND is_super_admin=FALSE)
		AND NOT EXISTS(SELECT 1 FROM offline_terminals WHERE user_id=$1 AND state IN ('requested','approved','active'))`, userID).Scan(&allowed); err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrOfflineTerminalExists
	}
	terminal := &domain.OfflineTerminal{}
	err = tx.QueryRow(ctx, `INSERT INTO offline_terminals(id,user_id,display_name,windows_sid_hash,install_instance_hash,client_version,public_key_pem,state,max_storage_bytes,created_by,requested_at,bitlocker_status,windows_hello_status,posture_reported_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,'requested',$8,$2,NOW(),$9,$10,NOW())
		RETURNING id,user_id,display_name,platform,windows_sid_hash,state,client_version,bitlocker_status,windows_hello_status,posture_reported_at,max_storage_bytes,policy_revision,created_by,created_at,activated_at,revoked_at,last_seen_at,updated_at,last_sync_at,wipe_required_at,wipe_acknowledged_at,used_storage_bytes,requested_at,approved_at,rejected_at`,
		terminalID, userID, displayName, sidHash, installInstanceHash, clientVersion, publicKeyPEM, int64(5*1024*1024*1024), posture.BitLocker, posture.WindowsHello).
		Scan(&terminal.ID, &terminal.UserID, &terminal.DisplayName, &terminal.Platform, &terminal.WindowsSIDHash, &terminal.State, &terminal.ClientVersion, &terminal.BitLockerStatus, &terminal.WindowsHelloStatus, &terminal.PostureReportedAt, &terminal.MaxStorageBytes, &terminal.PolicyRevision, &terminal.CreatedBy, &terminal.CreatedAt, &terminal.ActivatedAt, &terminal.RevokedAt, &terminal.LastSeenAt, &terminal.UpdatedAt, &terminal.LastSyncAt, &terminal.WipeRequiredAt, &terminal.WipeAcknowledgedAt, &terminal.UsedStorageBytes, &terminal.RequestedAt, &terminal.ApprovedAt, &terminal.RejectedAt)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,actor_id,event_type,metadata) VALUES($1,$2,'terminal_requested',jsonb_build_object('client_version',$3::text,'bitlocker_status',$4::text,'windows_hello_status',$5::text))`, terminalID, userID, clientVersion, posture.BitLocker, posture.WindowsHello); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return terminal, nil
}

type OfflineEnrollmentRequestRecord struct {
	TerminalID          uuid.UUID
	UserID              uuid.UUID
	State               string
	DisplayName         string
	PublicKeyPEM        string
	InstallInstanceHash string
	BitLockerStatus     string
	WindowsHelloStatus  string
	PostureReportedAt   *time.Time
}

func (r *OfflineRepository) EnrollmentRequest(ctx context.Context, terminalID, userID uuid.UUID) (*OfflineEnrollmentRequestRecord, error) {
	record := &OfflineEnrollmentRequestRecord{}
	err := r.db.QueryRow(ctx, `SELECT id,user_id,state,display_name,COALESCE(public_key_pem,''),COALESCE(install_instance_hash,''),bitlocker_status,windows_hello_status,posture_reported_at FROM offline_terminals WHERE id=$1 AND user_id=$2`, terminalID, userID).
		Scan(&record.TerminalID, &record.UserID, &record.State, &record.DisplayName, &record.PublicKeyPEM, &record.InstallInstanceHash, &record.BitLockerStatus, &record.WindowsHelloStatus, &record.PostureReportedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineTerminalNotFound
	}
	return record, err
}

func (r *OfflineRepository) RequestedTerminal(ctx context.Context, terminalID uuid.UUID) (*OfflineEnrollmentRequestRecord, error) {
	record := &OfflineEnrollmentRequestRecord{}
	err := r.db.QueryRow(ctx, `SELECT id,user_id,state,display_name,COALESCE(public_key_pem,''),COALESCE(install_instance_hash,''),bitlocker_status,windows_hello_status,posture_reported_at FROM offline_terminals WHERE id=$1`, terminalID).
		Scan(&record.TerminalID, &record.UserID, &record.State, &record.DisplayName, &record.PublicKeyPEM, &record.InstallInstanceHash, &record.BitLockerStatus, &record.WindowsHelloStatus, &record.PostureReportedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineTerminalNotFound
	}
	return record, err
}

func (r *OfflineRepository) RecordDevicePosture(ctx context.Context, terminalID uuid.UUID, posture domain.OfflineDevicePosture) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var previousBitLocker, previousWindowsHello string
	if err := tx.QueryRow(ctx, `SELECT bitlocker_status,windows_hello_status FROM offline_terminals WHERE id=$1 FOR UPDATE`, terminalID).Scan(&previousBitLocker, &previousWindowsHello); errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineTerminalNotFound
	} else if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_terminals SET bitlocker_status=$2,windows_hello_status=$3,posture_reported_at=NOW(),updated_at=NOW() WHERE id=$1`, terminalID, posture.BitLocker, posture.WindowsHello); err != nil {
		return err
	}
	if previousBitLocker != posture.BitLocker || previousWindowsHello != posture.WindowsHello {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,event_type,metadata) VALUES($1,'device_posture_changed',jsonb_build_object('bitlocker_status',$2::text,'windows_hello_status',$3::text))`, terminalID, posture.BitLocker, posture.WindowsHello); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) ApproveRequestedTerminal(ctx context.Context, terminalID, actorID uuid.UUID, grants []domain.OfflineGrantInput, riskAcknowledged bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var userID uuid.UUID
	var state, publicKeyPEM, bitLockerStatus, windowsHelloStatus string
	if err := tx.QueryRow(ctx, `SELECT user_id,state,COALESCE(public_key_pem,''),bitlocker_status,windows_hello_status FROM offline_terminals WHERE id=$1 FOR UPDATE`, terminalID).Scan(&userID, &state, &publicKeyPEM, &bitLockerStatus, &windowsHelloStatus); errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineTerminalNotFound
	} else if err != nil {
		return err
	}
	if state != "requested" || publicKeyPEM == "" {
		return ErrOfflineTerminalNotRequested
	}
	posture := domain.OfflineDevicePosture{BitLocker: bitLockerStatus, WindowsHello: windowsHelloStatus}
	if domain.OfflineDevicePostureRequiresRiskAcknowledgement(posture) && !riskAcknowledged {
		return ErrOfflineDeviceRiskNotAcknowledged
	}
	for _, input := range grants {
		actions := input.Actions
		if len(actions) == 0 {
			actions = json.RawMessage(`{}`)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_grants(terminal_id,user_id,account_id,modules,actions,max_offline_seconds,quota_bytes,granted_by)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, terminalID, userID, input.AccountID, input.Modules, actions, input.MaxOfflineSeconds, input.QuotaBytes, actorID); err != nil {
			return fmt.Errorf("approve offline grant: %w", err)
		}
	}
	tag, err := tx.Exec(ctx, `UPDATE offline_terminals SET state='approved',approved_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='requested'`, terminalID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineTerminalNotRequested
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,actor_id,event_type,metadata) VALUES($1,$2,'terminal_approved',jsonb_build_object('accounts',$3::int,'risk_acknowledged',$4::boolean,'bitlocker_status',$5::text,'windows_hello_status',$6::text))`, terminalID, actorID, len(grants), riskAcknowledged, bitLockerStatus, windowsHelloStatus); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) RejectRequestedTerminal(ctx context.Context, terminalID, actorID uuid.UUID) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE offline_terminals SET state='rejected',rejected_at=NOW(),updated_at=NOW() WHERE id=$1 AND state='requested'`, terminalID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_terminals WHERE id=$1)`, terminalID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrOfflineTerminalNotFound
		}
		return ErrOfflineTerminalNotRequested
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,actor_id,event_type) VALUES($1,$2,'terminal_rejected')`, terminalID, actorID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) ActivateApprovedTerminal(ctx context.Context, terminalID uuid.UUID, installInstanceHash string) (uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	var userID uuid.UUID
	var state, storedHash string
	if err := tx.QueryRow(ctx, `SELECT user_id,state,COALESCE(install_instance_hash,'') FROM offline_terminals WHERE id=$1 FOR UPDATE`, terminalID).Scan(&userID, &state, &storedHash); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrOfflineTerminalNotFound
	} else if err != nil {
		return uuid.Nil, err
	}
	if storedHash != installInstanceHash {
		return uuid.Nil, ErrOfflineEnrollmentInvalid
	}
	if state == "approved" {
		if _, err := tx.Exec(ctx, `UPDATE offline_terminals SET state='active',activated_at=COALESCE(activated_at,NOW()),updated_at=NOW() WHERE id=$1`, terminalID); err != nil {
			return uuid.Nil, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,actor_id,event_type) VALUES($1,$2,'terminal_activated')`, terminalID, userID); err != nil {
			return uuid.Nil, err
		}
	} else if state != "active" {
		return uuid.Nil, ErrOfflineTerminalNotActive
	}
	if err := tx.Commit(ctx); err != nil {
		return uuid.Nil, err
	}
	return userID, nil
}

func validateOfflineResource(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, resource domain.OfflineResourceSelection) error {
	var table string
	switch resource.Module {
	case domain.OfflineModuleWhiteboards:
		if resource.ResourceType != domain.OfflineResourceWhiteboard {
			return ErrOfflineResourceInvalid
		}
		table = "whiteboards"
	case domain.OfflineModuleTasks:
		if resource.ResourceType != domain.OfflineResourceTaskList {
			return ErrOfflineResourceInvalid
		}
		table = "task_lists"
	case domain.OfflineModuleContacts:
		if resource.ResourceType != domain.OfflineResourceContact {
			return ErrOfflineResourceInvalid
		}
		table = "contacts"
	case domain.OfflineModulePrograms:
		if resource.ResourceType != domain.OfflineResourceProgram {
			return ErrOfflineResourceInvalid
		}
		table = "programs"
	default:
		return ErrOfflineResourceInvalid
	}
	var exists bool
	if err := tx.QueryRow(ctx, fmt.Sprintf(`SELECT EXISTS(SELECT 1 FROM %s WHERE account_id=$1 AND id=$2)`, table), accountID, resource.ResourceID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrOfflineResourceInvalid
	}
	return nil
}

func (r *OfflineRepository) ListTerminals(ctx context.Context) ([]domain.OfflineTerminal, error) {
	rows, err := r.db.Query(ctx, `SELECT t.id,t.user_id,COALESCE(u.display_name,u.username),t.display_name,t.platform,t.windows_sid_hash,t.state,t.client_version,t.bitlocker_status,t.windows_hello_status,t.posture_reported_at,t.max_storage_bytes,t.policy_revision,t.created_by,t.created_at,t.activated_at,t.revoked_at,t.last_seen_at,t.updated_at,t.last_sync_at,t.wipe_required_at,t.wipe_acknowledged_at,t.used_storage_bytes,t.requested_at,t.approved_at,t.rejected_at FROM offline_terminals t JOIN users u ON u.id=t.user_id ORDER BY t.created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.OfflineTerminal, 0)
	for rows.Next() {
		var terminal domain.OfflineTerminal
		if err := rows.Scan(&terminal.ID, &terminal.UserID, &terminal.UserDisplayName, &terminal.DisplayName, &terminal.Platform, &terminal.WindowsSIDHash, &terminal.State, &terminal.ClientVersion, &terminal.BitLockerStatus, &terminal.WindowsHelloStatus, &terminal.PostureReportedAt, &terminal.MaxStorageBytes, &terminal.PolicyRevision, &terminal.CreatedBy, &terminal.CreatedAt, &terminal.ActivatedAt, &terminal.RevokedAt, &terminal.LastSeenAt, &terminal.UpdatedAt, &terminal.LastSyncAt, &terminal.WipeRequiredAt, &terminal.WipeAcknowledgedAt, &terminal.UsedStorageBytes, &terminal.RequestedAt, &terminal.ApprovedAt, &terminal.RejectedAt); err != nil {
			return nil, err
		}
		grants, err := r.listGrants(ctx, terminal.ID)
		if err != nil {
			return nil, err
		}
		terminal.Grants = grants
		result = append(result, terminal)
	}
	return result, rows.Err()
}

func (r *OfflineRepository) listGrants(ctx context.Context, terminalID uuid.UUID) ([]domain.OfflineGrant, error) {
	rows, err := r.db.Query(ctx, `SELECT g.id,g.terminal_id,g.user_id,g.account_id,a.name,g.modules,g.actions,g.max_offline_seconds,g.quota_bytes,g.state,g.policy_revision,g.selection_revision,g.created_at,g.updated_at FROM offline_terminal_grants g JOIN accounts a ON a.id=g.account_id WHERE g.terminal_id=$1 ORDER BY a.name`, terminalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineGrant, 0)
	for rows.Next() {
		var grant domain.OfflineGrant
		if err := rows.Scan(&grant.ID, &grant.TerminalID, &grant.UserID, &grant.AccountID, &grant.AccountName, &grant.Modules, &grant.Actions, &grant.MaxOfflineSeconds, &grant.QuotaBytes, &grant.State, &grant.PolicyRevision, &grant.SelectionRevision, &grant.CreatedAt, &grant.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, grant)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) ApprovedAccountsForTerminal(ctx context.Context, terminalID, userID uuid.UUID) ([]domain.OfflineGrant, error) {
	rows, err := r.db.Query(ctx, `SELECT g.id,g.terminal_id,g.user_id,g.account_id,a.name,g.modules,g.actions,g.max_offline_seconds,g.quota_bytes,g.state,g.policy_revision,g.selection_revision,g.created_at,g.updated_at FROM offline_terminal_grants g JOIN accounts a ON a.id=g.account_id WHERE g.terminal_id=$1 AND g.user_id=$2 AND g.state='active' ORDER BY a.name`, terminalID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineGrant, 0)
	for rows.Next() {
		var grant domain.OfflineGrant
		if err := rows.Scan(&grant.ID, &grant.TerminalID, &grant.UserID, &grant.AccountID, &grant.AccountName, &grant.Modules, &grant.Actions, &grant.MaxOfflineSeconds, &grant.QuotaBytes, &grant.State, &grant.PolicyRevision, &grant.SelectionRevision, &grant.CreatedAt, &grant.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, grant)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) Audit(ctx context.Context, limit int) ([]domain.OfflineAuditEvent, error) {
	rows, err := r.db.Query(ctx, `SELECT id,terminal_id,account_id,actor_id,event_type,metadata,created_at FROM offline_terminal_audit ORDER BY created_at DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineAuditEvent, 0)
	for rows.Next() {
		var event domain.OfflineAuditEvent
		if err := rows.Scan(&event.ID, &event.TerminalID, &event.AccountID, &event.ActorID, &event.EventType, &event.Metadata, &event.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, event)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) UserHasTerminal(ctx context.Context, userID uuid.UUID) (bool, error) {
	var exists bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_terminals WHERE user_id=$1 AND state IN ('requested','approved','active'))`, userID).Scan(&exists)
	return exists, err
}

func (r *OfflineRepository) UserHasAccountModule(ctx context.Context, userID, accountID uuid.UUID, module string) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM user_accounts ua JOIN users u ON u.id=ua.user_id LEFT JOIN roles ro ON ro.id=ua.role_id WHERE ua.user_id=$1 AND ua.account_id=$2 AND u.is_active=TRUE AND (u.is_super_admin=TRUE OR ua.role IN ('admin','owner','super_admin') OR $3=ANY(COALESCE(ro.permissions,'{}'::text[])) OR '*'=ANY(COALESCE(ro.permissions,'{}'::text[]))))`, userID, accountID, module).Scan(&allowed)
	return allowed, err
}

func (r *OfflineRepository) CleanupExpiredControlData(ctx context.Context) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `DELETE FROM offline_sync_nonces WHERE expires_at<NOW() OR consumed_at IS NOT NULL`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM offline_terminal_audit WHERE created_at<NOW()-INTERVAL '12 months'`); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
