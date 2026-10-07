package repository

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var (
	ErrDeviceNotFound            = errors.New("dispositivo no encontrado")
	ErrDeviceDeleting            = errors.New("el dispositivo se está eliminando")
	ErrDeviceSessionConflict     = errors.New("la sesión pertenece a otro dispositivo o cambió")
	ErrDeviceDeletionLeaseLost   = errors.New("device deletion lease lost")
	ErrDeviceDeletionUnsupported = errors.New("este proveedor no admite baja de WhatsApp Web")
)

func (r *DeviceRepository) ValidateSessionOwner(ctx context.Context, accountID, deviceID uuid.UUID, jid string) error {
	var valid bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices d WHERE d.account_id=$1 AND d.id=$2 AND d.delete_operation_id IS NULL AND (COALESCE(d.jid,'')='' OR d.jid=$3::varchar) AND NOT EXISTS(SELECT 1 FROM devices other WHERE other.id<>d.id AND other.jid=$3::varchar))`, accountID, deviceID, jid).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrDeviceSessionConflict
	}
	return nil
}

func (r *DeviceRepository) WithSessionReservation(ctx context.Context, accountID, deviceID uuid.UUID, jid string, action func(context.Context) error) error {
	conn, err := r.db.Acquire(ctx)
	if err != nil {
		return err
	}
	defer conn.Release()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1::text,71128))`, deviceID.String()); err != nil {
		return err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, unlockErr := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1::text,71128))`, deviceID.String()); unlockErr != nil {
			_ = conn.Conn().Close(context.Background())
		}
	}()
	if _, err = conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1::text,71127))`, jid); err != nil {
		return err
	}
	defer func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, unlockErr := conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1::text,71127))`, jid); unlockErr != nil {
			// Do not return a connection with a session lock to the shared pool.
			_ = conn.Conn().Close(context.Background())
		}
	}()
	if err = r.ValidateSessionOwner(ctx, accountID, deviceID, jid); err != nil {
		return err
	}
	return action(ctx)
}

// RememberPairedSession is called while WithSessionReservation and the pool's
// resource lock are held. Pairing must bind the exact companion before its
// store Save returns: whatsmeow sends the remote pairing ACK only after Save.
func (r *DeviceRepository) RememberPairedSession(ctx context.Context, accountID, deviceID uuid.UUID, jid string) error {
	ct, err := r.db.Exec(ctx, `UPDATE devices SET jid=$3::varchar,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL AND (COALESCE(jid,'')='' OR jid=$3::varchar)`, accountID, deviceID, jid)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrDeviceSessionConflict
	}
	return nil
}

// DeviceDeletion is an internal lease. Never serialize session identity.
type DeviceDeletion struct {
	DeviceID, AccountID, OperationID, LeaseToken uuid.UUID
	JID, Fingerprint, Phase                      string
	Attempts                                     int
}

func (r *DeviceRepository) Active(ctx context.Context, accountID, deviceID uuid.UUID) error {
	var owner uuid.UUID
	var deleting bool
	err := r.db.QueryRow(ctx, `SELECT account_id,delete_operation_id IS NOT NULL FROM devices WHERE id=$1`, deviceID).Scan(&owner, &deleting)
	if err == pgx.ErrNoRows || (err == nil && accountID != uuid.Nil && owner != accountID) {
		return ErrDeviceNotFound
	}
	if err != nil {
		return err
	}
	if deleting {
		return ErrDeviceDeleting
	}
	return nil
}

func lockDeviceSession(ctx context.Context, tx pgx.Tx, jid string) error {
	if jid == "" {
		return nil
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71127))`, jid)
	return err
}

func lockDeviceResource(ctx context.Context, tx pgx.Tx, deviceID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,71128))`, deviceID.String())
	return err
}

// BindSession and deletion use the same full companion-JID reservation. A
// pairing callback cannot revive a tombstone or replace its cleanup target.
func (r *DeviceRepository) BindSession(ctx context.Context, id uuid.UUID, jid, phone string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockDeviceResource(ctx, tx, id); err != nil {
		return err
	}
	if err = lockDeviceSession(ctx, tx, jid); err != nil {
		return err
	}
	var deleting bool
	if err = tx.QueryRow(ctx, `SELECT delete_operation_id IS NOT NULL FROM devices WHERE id=$1 FOR UPDATE`, id).Scan(&deleting); err == pgx.ErrNoRows {
		return ErrDeviceNotFound
	} else if err != nil {
		return err
	}
	if deleting {
		return ErrDeviceDeleting
	}
	var reserved bool
	if jid != "" {
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE id<>$1 AND jid=$2::varchar)`, id, jid).Scan(&reserved); err != nil {
			return err
		}
	}
	if reserved {
		return ErrDeviceSessionConflict
	}
	_, err = tx.Exec(ctx, `UPDATE devices SET jid=$1::varchar,phone=$2,status=$3,qr_code=NULL,last_seen_at=NOW(),updated_at=NOW() WHERE id=$4 AND delete_operation_id IS NULL`, jid, phone, domain.DeviceStatusConnected, id)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// PendingDeletion reads only a committed tombstone. Operation identity and
// account counts share one MVCC statement snapshot, without waiting for a
// cleanup worker's JID reservation or Device/FK locks. A completion just after
// this snapshot is reconciled by its event and the next canonical GET.
func (r *DeviceRepository) PendingDeletion(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.DeviceDeletionResult, error) {
	result := &domain.DeviceDeletionResult{DeletionStatus: "pending"}
	var operationID *uuid.UUID
	err := r.db.QueryRow(ctx, `SELECT d.id,d.delete_operation_id,d.delete_next_attempt_at,d.delete_last_error_code,
	 (SELECT COUNT(*) FROM devices WHERE account_id=$1),
	 (SELECT COUNT(*) FROM devices WHERE account_id=$1 AND delete_operation_id IS NULL)
	 FROM devices d WHERE d.account_id=$1 AND d.id=$2`, accountID, deviceID).Scan(&result.DeviceID, &operationID, &result.NextRetryAt, &result.ErrorCode, &result.DevicesTotal, &result.DevicesAvailable)
	if err == pgx.ErrNoRows {
		return nil, ErrDeviceNotFound
	}
	if err != nil {
		return nil, err
	}
	if operationID == nil {
		return nil, nil
	}
	result.OperationID = *operationID
	return result, nil
}

func (r *DeviceRepository) BeginDeletion(ctx context.Context, accountID, deviceID uuid.UUID, expectedJID, fingerprint string) (*domain.DeviceDeletionResult, error) {
	if pending, err := r.PendingDeletion(ctx, accountID, deviceID); err != nil || pending != nil {
		return pending, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if err = lockDeviceResource(ctx, tx, deviceID); err != nil {
		return nil, err
	}
	if err = lockDeviceSession(ctx, tx, expectedJID); err != nil {
		return nil, err
	}
	var jid, status string
	var op *uuid.UUID
	var next *time.Time
	var errorCode *string
	if err = tx.QueryRow(ctx, `SELECT COALESCE(jid,''),COALESCE(status,''),delete_operation_id,delete_next_attempt_at,delete_last_error_code FROM devices WHERE account_id=$1 AND id=$2 FOR UPDATE`, accountID, deviceID).Scan(&jid, &status, &op, &next, &errorCode); err == pgx.ErrNoRows {
		return nil, ErrDeviceNotFound
	} else if err != nil {
		return nil, err
	}
	result := &domain.DeviceDeletionResult{DeviceID: deviceID, DeletionStatus: "pending", NextRetryAt: next, ErrorCode: errorCode}
	if op != nil {
		result.OperationID = *op
		if err = deviceDeletionCounts(ctx, tx, accountID, result); err != nil {
			return nil, err
		}
		return result, tx.Commit(ctx)
	}
	if jid != expectedJID {
		return nil, ErrDeviceSessionConflict
	}
	var collision bool
	if jid != "" {
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE id<>$1 AND jid=$2::varchar)`, deviceID, jid).Scan(&collision); err != nil {
			return nil, err
		}
	}
	if collision {
		return nil, ErrDeviceSessionConflict
	}
	result.OperationID = uuid.New()
	phase := "pending"
	if jid == "" || status == domain.DeviceStatusLoggedOut {
		phase = "remote_unlinked"
	}
	if _, err = tx.Exec(ctx, `UPDATE devices SET status='deleting',qr_code=NULL,receive_messages=false,delete_operation_id=$1,delete_phase=$2::text,delete_requested_at=NOW(),delete_session_fingerprint=$3::text,delete_attempts=0,delete_next_attempt_at=NOW(),delete_last_error_code=NULL,updated_at=NOW() WHERE account_id=$4 AND id=$5`, result.OperationID, phase, fingerprint, accountID, deviceID); err != nil {
		return nil, err
	}
	ct, err := tx.Exec(ctx, `UPDATE contacts SET device_id=NULL,updated_at=NOW() WHERE account_id=$1 AND device_id=$2`, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	result.ContactsDetached = ct.RowsAffected()
	ct, err = tx.Exec(ctx, `UPDATE chats SET device_id=NULL,updated_at=NOW() WHERE account_id=$1 AND device_id=$2`, accountID, deviceID)
	if err != nil {
		return nil, err
	}
	result.ChatsDetached = ct.RowsAffected()
	if err = deviceDeletionCounts(ctx, tx, accountID, result); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}

func deviceDeletionCounts(ctx context.Context, tx pgx.Tx, accountID uuid.UUID, result *domain.DeviceDeletionResult) error {
	return tx.QueryRow(ctx, `SELECT COUNT(*),COUNT(*) FILTER(WHERE delete_operation_id IS NULL) FROM devices WHERE account_id=$1`, accountID).Scan(&result.DevicesTotal, &result.DevicesAvailable)
}

func (r *DeviceRepository) ClaimDeletion(ctx context.Context) (*DeviceDeletion, error) {
	job := &DeviceDeletion{LeaseToken: uuid.New()}
	err := r.db.QueryRow(ctx, `WITH candidate AS (
	 SELECT id FROM devices WHERE delete_operation_id IS NOT NULL AND delete_next_attempt_at<=NOW()
	 AND (delete_lease_until IS NULL OR delete_lease_until<NOW()) ORDER BY delete_next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
	) UPDATE devices d SET delete_lease_token=$1,delete_lease_until=NOW()+INTERVAL '120 seconds',delete_attempts=delete_attempts+1
	 FROM candidate c WHERE d.id=c.id RETURNING d.id,d.account_id,d.delete_operation_id,COALESCE(d.jid,''),COALESCE(d.delete_session_fingerprint,''),d.delete_phase,d.delete_attempts`, job.LeaseToken).Scan(&job.DeviceID, &job.AccountID, &job.OperationID, &job.JID, &job.Fingerprint, &job.Phase, &job.Attempts)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	return job, err
}

func (r *DeviceRepository) VerifyDeletion(ctx context.Context, job *DeviceDeletion) error {
	var valid bool
	err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices d WHERE d.account_id=$1 AND d.id=$2 AND d.delete_operation_id=$3 AND d.delete_lease_token=$4 AND d.delete_lease_until>NOW() AND COALESCE(d.jid,'')=$5::text AND COALESCE(d.delete_session_fingerprint,'')=$6::text AND NOT EXISTS(SELECT 1 FROM devices other WHERE other.id<>d.id AND other.jid=d.jid AND COALESCE(d.jid,'')<>''))`, job.AccountID, job.DeviceID, job.OperationID, job.LeaseToken, job.JID, job.Fingerprint).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return ErrDeviceDeletionLeaseLost
	}
	return nil
}

func (r *DeviceRepository) CheckpointUnlinked(ctx context.Context, job *DeviceDeletion) error {
	ct, err := r.db.Exec(ctx, `UPDATE devices SET delete_phase='remote_unlinked',delete_last_error_code=NULL WHERE account_id=$1 AND id=$2 AND delete_operation_id=$3 AND delete_lease_token=$4 AND delete_lease_until>NOW() AND COALESCE(jid,'')=$5::text AND COALESCE(delete_session_fingerprint,'')=$6::text`, job.AccountID, job.DeviceID, job.OperationID, job.LeaseToken, job.JID, job.Fingerprint)
	if err != nil {
		return err
	}
	if ct.RowsAffected() != 1 {
		return ErrDeviceDeletionLeaseLost
	}
	return nil
}

func (r *DeviceRepository) Unlinked(ctx context.Context, job *DeviceDeletion) error {
	var unlinked bool
	if err := r.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id=$3 AND delete_lease_token=$4 AND delete_phase='remote_unlinked' AND delete_lease_until>NOW())`, job.AccountID, job.DeviceID, job.OperationID, job.LeaseToken).Scan(&unlinked); err != nil {
		return err
	}
	if !unlinked {
		return ErrDeviceDeletionLeaseLost
	}
	return nil
}

func (r *DeviceRepository) RetryDeletion(ctx context.Context, job *DeviceDeletion, next time.Time, code string) error {
	_, err := r.db.Exec(ctx, `UPDATE devices SET delete_lease_token=NULL,delete_lease_until=NULL,delete_next_attempt_at=$5,delete_last_error_code=$6::text WHERE account_id=$1 AND id=$2 AND delete_operation_id=$3 AND delete_lease_token=$4`, job.AccountID, job.DeviceID, job.OperationID, job.LeaseToken, next, code)
	return err
}

func (r *DeviceRepository) FinishDeletion(ctx context.Context, job *DeviceDeletion) (*domain.DeviceDeletionResult, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	var found uuid.UUID
	if err = tx.QueryRow(ctx, `SELECT id FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id=$3 AND delete_lease_token=$4 AND delete_phase='remote_unlinked' AND delete_lease_until>NOW() FOR UPDATE`, job.AccountID, job.DeviceID, job.OperationID, job.LeaseToken).Scan(&found); err == pgx.ErrNoRows {
		return nil, ErrDeviceDeletionLeaseLost
	} else if err != nil {
		return nil, err
	}
	// Status inventory is reconciled by the existing durable periodic media GC;
	// Contact/chat/message objects are preserved and never deleted here.
	if _, err = tx.Exec(ctx, `DELETE FROM devices WHERE account_id=$1 AND id=$2`, job.AccountID, job.DeviceID); err != nil {
		return nil, err
	}
	result := &domain.DeviceDeletionResult{DeviceID: job.DeviceID, OperationID: job.OperationID, DeletionStatus: "completed"}
	if err = deviceDeletionCounts(ctx, tx, job.AccountID, result); err != nil {
		return nil, err
	}
	return result, tx.Commit(ctx)
}
