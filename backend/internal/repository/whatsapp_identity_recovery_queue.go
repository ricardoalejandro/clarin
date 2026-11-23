package repository

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"time"
)

func (r *ChatRepository) EnqueueWhatsAppIdentityRecovery(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint, trigger string, candidates []string) (uuid.UUID, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return uuid.Nil, err
	}
	defer tx.Rollback(ctx)
	if err = lockWhatsAppIdentityScope(ctx, tx, accountID, deviceID); err != nil {
		return uuid.Nil, err
	}
	var generation int64
	if err = tx.QueryRow(ctx, `SELECT session_generation FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2 AND session_fingerprint=$3 AND session_generation>0 FOR UPDATE`, accountID, deviceID, fingerprint).Scan(&generation); errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrWhatsAppIdentitySessionChanged
	} else if err != nil {
		return uuid.Nil, err
	}
	var id uuid.UUID
	err = tx.QueryRow(ctx, `INSERT INTO whatsapp_identity_recovery_runs(account_id,device_id,version,session_generation,session_fingerprint) VALUES($1,$2,$3,$4,$5) ON CONFLICT(account_id,device_id,version,session_generation) DO UPDATE SET updated_at=whatsapp_identity_recovery_runs.updated_at RETURNING id`, accountID, deviceID, domain.WhatsAppIdentityRecoveryVersion, generation, fingerprint).Scan(&id)
	if err != nil {
		return uuid.Nil, err
	}
	clean := []string{}
	seen := map[string]bool{}
	for _, raw := range candidates {
		pn := canonicalPeerAddress(raw)
		if pn != "" && strings.HasSuffix(pn, "@s.whatsapp.net") && !seen[pn] {
			seen[pn] = true
			clean = append(clean, pn)
		}
	}
	for start := 0; start < len(clean); start += 500 {
		end := start + 500
		if end > len(clean) {
			end = len(clean)
		}
		if _, err = tx.Exec(ctx, `INSERT INTO whatsapp_identity_recovery_items(account_id,run_id,pn_jid) SELECT $1,$2,pn FROM unnest($3::text[]) pn ON CONFLICT(account_id,run_id,pn_jid) DO NOTHING`, accountID, id, clean[start:end]); err != nil {
			return uuid.Nil, err
		}
	}
	if trigger == "paired" {
		// Pairing/bootstrap records offline work without restarting a finished run
		// or disturbing a worker's lease, phase, retry budget or full-sync ACK.
		_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs run SET state=CASE WHEN EXISTS(SELECT 1 FROM devices d WHERE d.account_id=run.account_id AND d.id=run.device_id AND d.status='connected' AND d.delete_operation_id IS NULL) THEN 'pending' ELSE 'waiting_connection' END,updated_at=NOW() WHERE run.account_id=$1 AND run.id=$2 AND run.state IN('pending','waiting_connection') AND (run.lease_until IS NULL OR run.lease_until<NOW())`, accountID, id)
		if err != nil {
			return uuid.Nil, err
		}
		return id, tx.Commit(ctx)
	}
	if trigger == "sync" || trigger == "manual" || trigger == "inventory_after_appstate" {
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_items SET state='pending',attempts=0,next_attempt_at=NOW(),last_error_code='' WHERE account_id=$1 AND run_id=$2 AND state IN('error','unavailable','conflict')`, accountID, id); err != nil {
			return uuid.Nil, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs SET state='pending',phase='inventory',attempts=0,last_error_code='',next_attempt_at=NOW(),updated_at=NOW() WHERE account_id=$1 AND id=$2 AND (lease_until IS NULL OR lease_until<NOW()) AND (state NOT IN('completed','partial') OR $3::bool OR EXISTS(SELECT 1 FROM whatsapp_identity_recovery_items WHERE account_id=$1 AND run_id=$2 AND state='pending'))`, accountID, id, trigger == "sync" || trigger == "manual")
	if err != nil {
		return uuid.Nil, err
	}
	return id, tx.Commit(ctx)
}

func scanIdentityRecoveryRun(row pgx.Row) (*domain.WhatsAppIdentityRecoveryRun, error) {
	out := &domain.WhatsAppIdentityRecoveryRun{}
	err := row.Scan(&out.ID, &out.AccountID, &out.DeviceID, &out.SessionFingerprint, &out.SessionGeneration, &out.Version, &out.Phase, &out.Attempts, &out.LeaseID, &out.AppStateAcknowledged)
	return out, err
}
func (r *ChatRepository) ClaimIdentityRecoveryRun(ctx context.Context) (*domain.WhatsAppIdentityRecoveryRun, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('wa-identity-global-slots',0))`); err != nil {
		return nil, err
	}
	var active int
	if err = tx.QueryRow(ctx, `SELECT COUNT(*) FROM whatsapp_identity_recovery_runs WHERE lease_until>NOW() AND state='recovering'`).Scan(&active); err != nil {
		return nil, err
	}
	if active >= 2 {
		return nil, pgx.ErrNoRows
	}
	lease := uuid.New()
	run, err := scanIdentityRecoveryRun(tx.QueryRow(ctx, `WITH candidate AS(SELECT run.account_id,run.id FROM whatsapp_identity_recovery_runs run JOIN whatsapp_identity_scopes scope ON scope.account_id=run.account_id AND scope.device_id=run.device_id AND scope.session_generation=run.session_generation AND scope.session_fingerprint=run.session_fingerprint JOIN devices d ON d.account_id=run.account_id AND d.id=run.device_id WHERE run.state IN('pending','recovering','waiting_connection') AND run.next_attempt_at<=NOW() AND (run.lease_until IS NULL OR run.lease_until<NOW()) AND d.status='connected' AND d.delete_operation_id IS NULL AND run.version=$2::int ORDER BY run.next_attempt_at,run.created_at FOR UPDATE OF run SKIP LOCKED LIMIT 1)
 UPDATE whatsapp_identity_recovery_runs run SET state='recovering',lease_id=$1,lease_until=NOW()+INTERVAL '90 seconds',updated_at=NOW() FROM candidate WHERE run.account_id=candidate.account_id AND run.id=candidate.id RETURNING run.id,run.account_id,run.device_id,run.session_fingerprint,run.session_generation,run.version,run.phase,run.attempts,run.lease_id,run.appstate_acknowledged`, lease, domain.WhatsAppIdentityRecoveryVersion))
	if err != nil {
		return nil, err
	}
	return run, tx.Commit(ctx)
}
func (r *ChatRepository) RenewIdentityRecoveryLease(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) error {
	result, err := r.db.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs run SET lease_until=NOW()+INTERVAL '90 seconds' WHERE run.account_id=$1 AND run.id=$2 AND run.lease_id=$3 AND run.state='recovering' AND EXISTS(SELECT 1 FROM whatsapp_identity_scopes scope WHERE scope.account_id=run.account_id AND scope.device_id=run.device_id AND scope.session_fingerprint=$4 AND scope.session_generation=run.session_generation)`, run.AccountID, run.ID, run.LeaseID, run.SessionFingerprint)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrWhatsAppIdentitySessionChanged
	}
	return nil
}
func (r *ChatRepository) CheckpointIdentityRecovery(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun, phase string, ack bool) error {
	result, err := r.db.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs SET phase=$4::text,appstate_acknowledged=appstate_acknowledged OR $5::bool,attempts=0,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND lease_id=$3 AND state='recovering'`, run.AccountID, run.ID, run.LeaseID, phase, ack)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrWhatsAppIdentitySessionChanged
	}
	run.Phase = phase
	run.AppStateAcknowledged = run.AppStateAcknowledged || ack
	run.Attempts = 0
	return nil
}
func (r *ChatRepository) FinishIdentityRecoveryCycle(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun, state, phase, code string, delay time.Duration) error {
	result, err := r.db.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs SET state=$4::text,phase=$5::text,last_error_code=$6::text,attempts=attempts+CASE WHEN $6::text<>'' THEN 1 ELSE 0 END,next_attempt_at=$7::timestamptz,lease_id=NULL,lease_until=NULL,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND lease_id=$3 AND state='recovering'`, run.AccountID, run.ID, run.LeaseID, state, phase, code, time.Now().UTC().Add(delay))
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrWhatsAppIdentitySessionChanged
	}
	return nil
}
func (r *ChatRepository) PendingIdentityRecoveryBatch(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) ([]string, error) {
	rows, err := r.db.Query(ctx, `SELECT pn_jid FROM whatsapp_identity_recovery_items item WHERE account_id=$1 AND run_id=$2 AND state='pending' AND next_attempt_at<=NOW() AND EXISTS(SELECT 1 FROM whatsapp_identity_recovery_runs run WHERE run.account_id=item.account_id AND run.id=item.run_id AND run.lease_id=$3 AND run.state='recovering') ORDER BY pn_jid LIMIT 50`, run.AccountID, run.ID, run.LeaseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var pn string
		if err = rows.Scan(&pn); err != nil {
			return nil, err
		}
		out = append(out, pn)
	}
	return out, rows.Err()
}
func (r *ChatRepository) CompleteIdentityRecoveryBatch(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun, phones []string, succeeded bool) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var active bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whatsapp_identity_recovery_runs run JOIN whatsapp_identity_scopes scope ON scope.account_id=run.account_id AND scope.device_id=run.device_id AND scope.session_generation=run.session_generation AND scope.session_fingerprint=run.session_fingerprint WHERE run.account_id=$1 AND run.id=$2 AND run.lease_id=$3 AND run.state='recovering')`, run.AccountID, run.ID, run.LeaseID).Scan(&active); err != nil {
		return err
	}
	if !active {
		return ErrWhatsAppIdentitySessionChanged
	}
	if succeeded {
		_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_items item SET state=CASE WHEN EXISTS(SELECT 1 FROM whatsapp_peer_identity_aliases a WHERE a.account_id=item.account_id AND a.device_id=$4 AND a.session_generation=$5 AND a.pn_jid=item.pn_jid) THEN 'resolved' ELSE 'unavailable' END,attempts=attempts+1,last_error_code='' WHERE item.account_id=$1 AND item.run_id=$2 AND item.pn_jid=ANY($3::text[]) AND item.state='pending'`, run.AccountID, run.ID, phones, run.DeviceID, run.SessionGeneration)
	} else {
		_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_items SET state=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,attempts=attempts+1,next_attempt_at=NOW()+CASE WHEN attempts=0 THEN INTERVAL '30 seconds' WHEN attempts=1 THEN INTERVAL '2 minutes' ELSE INTERVAL '10 minutes' END,last_error_code='provider_unavailable' WHERE account_id=$1 AND run_id=$2 AND pn_jid=ANY($3::text[]) AND state='pending'`, run.AccountID, run.ID, phones)
	}
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (r *ChatRepository) IdentityRecoveryRemaining(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) (pending, unavailable int, next *time.Time, err error) {
	err = r.db.QueryRow(ctx, `SELECT COUNT(*) FILTER(WHERE state='pending'),COUNT(*) FILTER(WHERE state IN('unavailable','error','conflict')),MIN(next_attempt_at) FILTER(WHERE state='pending') FROM whatsapp_identity_recovery_items WHERE account_id=$1 AND run_id=$2`, run.AccountID, run.ID).Scan(&pending, &unavailable, &next)
	return
}

type IdentityRecoveryGroup struct {
	ChatID  uuid.UUID
	Members []domain.GroupParticipant
	Raw     []byte
}

func (r *ChatRepository) IdentityRecoveryGroups(ctx context.Context, accountID, deviceID uuid.UUID, after uuid.UUID) ([]IdentityRecoveryGroup, error) {
	rows, err := r.db.Query(ctx, `SELECT g.chat_id,g.participants FROM chat_groups g JOIN chats c ON c.account_id=g.account_id AND c.id=g.chat_id WHERE g.account_id=$1 AND c.device_id=$2 AND g.chat_id>$3 AND g.membership_status='member' ORDER BY g.chat_id LIMIT 50`, accountID, deviceID, after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IdentityRecoveryGroup{}
	for rows.Next() {
		var item IdentityRecoveryGroup
		if err = rows.Scan(&item.ChatID, &item.Raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(item.Raw, &item.Members); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
func (r *ChatRepository) ProjectIdentityRecoveryGroup(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun, group IdentityRecoveryGroup, members []domain.GroupParticipant) (bool, error) {
	raw, err := json.Marshal(members)
	if err != nil {
		return false, err
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if err = lockWhatsAppIdentityScope(ctx, tx, run.AccountID, run.DeviceID); err != nil {
		return false, err
	}
	result, err := tx.Exec(ctx, `UPDATE chat_groups g SET participants=$5::jsonb FROM chats c WHERE g.account_id=$1 AND g.chat_id=$2 AND c.account_id=g.account_id AND c.id=g.chat_id AND c.device_id=$3 AND g.participants=$4::jsonb AND g.participants IS DISTINCT FROM $5::jsonb AND EXISTS(SELECT 1 FROM whatsapp_identity_recovery_runs run JOIN whatsapp_identity_scopes scope ON scope.account_id=run.account_id AND scope.device_id=run.device_id AND scope.session_generation=run.session_generation AND scope.session_fingerprint=run.session_fingerprint WHERE run.account_id=$1 AND run.id=$6 AND run.lease_id=$7 AND run.state='recovering')`, run.AccountID, group.ChatID, run.DeviceID, group.Raw, raw, run.ID, run.LeaseID)
	if err != nil {
		return false, err
	}
	changed := result.RowsAffected() == 1
	return changed, tx.Commit(ctx)
}

// Reservations enforce device pacing across processes and request/restart boundaries.
func (r *ChatRepository) ReserveIdentityRecoveryLookup(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun) (time.Duration, error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var next time.Time
	err = tx.QueryRow(ctx, `UPDATE whatsapp_identity_scopes scope SET next_lookup_at=GREATEST(NOW(),next_lookup_at)+INTERVAL '2 seconds' WHERE scope.account_id=$1 AND scope.device_id=$2 AND scope.session_fingerprint=$3 AND EXISTS(SELECT 1 FROM whatsapp_identity_recovery_runs run WHERE run.account_id=scope.account_id AND run.device_id=scope.device_id AND run.id=$4 AND run.lease_id=$5 AND run.state='recovering') RETURNING next_lookup_at-INTERVAL '2 seconds'`, run.AccountID, run.DeviceID, run.SessionFingerprint, run.ID, run.LeaseID).Scan(&next)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrWhatsAppIdentitySessionChanged
	}
	if err != nil {
		return 0, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 0, err
	}
	delay := time.Until(next)
	if delay < 0 {
		delay = 0
	}
	return delay, nil
}

func (r *ChatRepository) SetIdentityRecoveryUnresolved(ctx context.Context, run *domain.WhatsAppIdentityRecoveryRun, count int) error {
	result, err := r.db.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs SET unresolved_members=$4::int,updated_at=NOW() WHERE account_id=$1 AND id=$2 AND lease_id=$3 AND state='recovering'`, run.AccountID, run.ID, run.LeaseID, count)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return ErrWhatsAppIdentitySessionChanged
	}
	return nil
}
