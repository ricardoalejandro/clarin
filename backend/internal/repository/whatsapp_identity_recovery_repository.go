package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"strings"
	"time"
)

var ErrWhatsAppIdentitySessionChanged = errors.New("WhatsApp identity session changed")

func lockWhatsAppIdentityScope(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))`, "wa-peer|"+accountID.String()+"|"+deviceID.String())
	return err
}

// The scope barrier is shared with session replacement and provider observation.
// Checking inside the same transaction makes the following projection write
// linearize before a replacement, or reject the old response after it.
func requireWhatsAppIdentitySessionTx(ctx context.Context, tx pgx.Tx, accountID, deviceID uuid.UUID, fingerprint string) error {
	if fingerprint == "" || len(fingerprint) > 256 {
		return ErrWhatsAppIdentitySessionChanged
	}
	if err := lockWhatsAppIdentityScope(ctx, tx, accountID, deviceID); err != nil {
		return err
	}
	var current bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM whatsapp_identity_scopes scope JOIN devices d ON d.account_id=scope.account_id AND d.id=scope.device_id WHERE scope.account_id=$1 AND scope.device_id=$2 AND scope.session_fingerprint=$3 AND d.delete_operation_id IS NULL AND COALESCE(NULLIF(d.provider,''),'whatsapp_web')='whatsapp_web')`, accountID, deviceID, fingerprint).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrWhatsAppIdentitySessionChanged
	}
	return nil
}

// The first scoped baseline adopts only facts already owned by this device.
// Subsequent companion sessions cannot read facts or group projections from it.
func (r *ChatRepository) EnsureWhatsAppIdentitySession(ctx context.Context, accountID, deviceID uuid.UUID, fingerprint string) (int64, error) {
	if fingerprint == "" || len(fingerprint) > 256 {
		return 0, ErrWhatsAppIdentitySessionChanged
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if err = lockWhatsAppIdentityScope(ctx, tx, accountID, deviceID); err != nil {
		return 0, err
	}
	var alive bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL AND COALESCE(NULLIF(provider,''),'whatsapp_web')='whatsapp_web')`, accountID, deviceID).Scan(&alive); err != nil {
		return 0, err
	}
	if !alive {
		return 0, pgx.ErrNoRows
	}
	var previous string
	var generation int64
	err = tx.QueryRow(ctx, `SELECT session_fingerprint,session_generation FROM whatsapp_identity_scopes WHERE account_id=$1 AND device_id=$2 FOR UPDATE`, accountID, deviceID).Scan(&previous, &generation)
	if errors.Is(err, pgx.ErrNoRows) {
		_, err = tx.Exec(ctx, `INSERT INTO whatsapp_identity_scopes(account_id,device_id,session_fingerprint,session_generation) VALUES($1,$2,$3,1)`, accountID, deviceID, fingerprint)
		generation = 1
		previous = ""
	} else if err == nil && previous == fingerprint {
		return generation, tx.Commit(ctx)
	} else if err == nil {
		generation++
		_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_scopes SET session_fingerprint=$3,session_generation=$4,session_started_at=CASE WHEN session_fingerprint='' THEN NULL ELSE NOW() END,identity_revision=identity_revision+1 WHERE account_id=$1 AND device_id=$2`, accountID, deviceID, fingerprint, generation)
	}
	if err != nil {
		return 0, err
	}
	if previous == "" {
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_peer_identity_fields SET session_generation=$3 WHERE account_id=$1 AND device_id=$2`, accountID, deviceID, generation); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE whatsapp_peer_identity_aliases SET session_generation=$3 WHERE account_id=$1 AND device_id=$2`, accountID, deviceID, generation); err != nil {
			return 0, err
		}
	} else {
		if _, err = tx.Exec(ctx, `DELETE FROM whatsapp_peer_identity_fields WHERE account_id=$1 AND device_id=$2`, accountID, deviceID); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM whatsapp_peer_identity_aliases WHERE account_id=$1 AND device_id=$2`, accountID, deviceID); err != nil {
			return 0, err
		}
		if _, err = tx.Exec(ctx, `UPDATE chat_groups g SET participants='[]'::jsonb,membership_status='unknown' FROM chats c WHERE g.account_id=$1 AND c.account_id=g.account_id AND c.id=g.chat_id AND c.device_id=$2`, accountID, deviceID); err != nil {
			return 0, err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE whatsapp_identity_recovery_runs SET state='cancelled',lease_id=NULL,lease_until=NULL,updated_at=NOW() WHERE account_id=$1 AND device_id=$2 AND session_generation<>$3 AND state<>'cancelled'`, accountID, deviceID, generation)
	if err != nil {
		return 0, err
	}
	return generation, tx.Commit(ctx)
}

func (r *ChatRepository) WhatsAppIdentityRevision(ctx context.Context, accountID, deviceID uuid.UUID) (int64, error) {
	var revision int64
	err := r.db.QueryRow(ctx, `SELECT COALESCE(s.identity_revision,0) FROM devices d LEFT JOIN whatsapp_identity_scopes s ON s.account_id=d.account_id AND s.device_id=d.id WHERE d.account_id=$1 AND d.id=$2 AND d.delete_operation_id IS NULL`, accountID, deviceID).Scan(&revision)
	return revision, err
}
func (r *ChatRepository) CRMIdentityRevision(ctx context.Context, accountID uuid.UUID) (int64, error) {
	var revision int64
	err := r.db.QueryRow(ctx, `SELECT COALESCE(v.revision,0) FROM accounts a LEFT JOIN whatsapp_identity_crm_versions v ON v.account_id=a.id WHERE a.id=$1`, accountID).Scan(&revision)
	return revision, err
}
func (r *ChatRepository) CRMRevision(ctx context.Context, accountID uuid.UUID) (int64, error) {
	return r.CRMIdentityRevision(ctx, accountID)
}
func (r *ChatRepository) SnapshotVersionByGroupJID(ctx context.Context, accountID, deviceID uuid.UUID, groupJID string) (int64, int64, error) {
	var identity, group int64
	err := r.db.QueryRow(ctx, `SELECT COALESCE(s.identity_revision,0),COALESCE(g.revision,0) FROM devices d LEFT JOIN whatsapp_identity_scopes s ON s.account_id=d.account_id AND s.device_id=d.id LEFT JOIN whatsapp_identity_group_versions g ON g.account_id=d.account_id AND g.device_id=d.id AND g.group_jid=$3 WHERE d.account_id=$1 AND d.id=$2 AND d.delete_operation_id IS NULL`, accountID, deviceID, groupJID).Scan(&identity, &group)
	return identity, group, err
}
func (r *ChatRepository) GroupRevisionByJID(ctx context.Context, accountID, deviceID uuid.UUID, groupJID string) (int64, error) {
	_, group, err := r.SnapshotVersionByGroupJID(ctx, accountID, deviceID, groupJID)
	return group, err
}
func (r *ChatRepository) GroupRevision(ctx context.Context, accountID, chatID uuid.UUID) (int64, error) {
	var revision int64
	err := r.db.QueryRow(ctx, `SELECT COALESCE(g.revision,0) FROM chats c LEFT JOIN whatsapp_identity_group_versions g ON g.account_id=c.account_id AND g.device_id=c.device_id AND g.group_jid=c.jid WHERE c.account_id=$1 AND c.id=$2`, accountID, chatID).Scan(&revision)
	return revision, err
}
func (r *ChatRepository) RecordWhatsAppGroupSnapshotVersion(ctx context.Context, accountID, deviceID uuid.UUID, groupJID string, material []byte) (int64, error) {
	if !strings.HasSuffix(groupJID, "@g.us") || !json.Valid(material) || len(material) > 2<<20 {
		return 0, fmt.Errorf("invalid group version material")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	result, err := tx.Exec(ctx, `INSERT INTO whatsapp_identity_group_versions(account_id,device_id,group_jid,revision,material) SELECT $1,$2,$3::text,1,$4::jsonb FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL ON CONFLICT(account_id,device_id,group_jid) DO UPDATE SET revision=whatsapp_identity_group_versions.revision+1,material=EXCLUDED.material WHERE whatsapp_identity_group_versions.material IS DISTINCT FROM EXCLUDED.material`, accountID, deviceID, groupJID, material)
	if err != nil {
		return 0, err
	}
	_ = result
	var revision int64
	err = tx.QueryRow(ctx, `SELECT revision FROM whatsapp_identity_group_versions WHERE account_id=$1 AND device_id=$2 AND group_jid=$3`, accountID, deviceID, groupJID).Scan(&revision)
	if err != nil {
		return 0, err
	}
	return revision, tx.Commit(ctx)
}
func (r *ChatRepository) IdentityRecoveryStatus(ctx context.Context, accountID, deviceID uuid.UUID) (*domain.WhatsAppIdentityRecoveryStatus, error) {
	out := &domain.WhatsAppIdentityRecoveryStatus{}
	err := r.db.QueryRow(ctx, `SELECT CASE WHEN d.status<>'connected' AND run.state IN('pending','recovering','waiting_connection') THEN 'waiting_connection' ELSE run.state END,run.phase,run.last_error_code,run.updated_at,
 COUNT(item.pn_jid) FILTER(WHERE item.state<>'pending'),COUNT(item.pn_jid) FILTER(WHERE item.state='resolved'),COUNT(item.pn_jid) FILTER(WHERE item.state='pending'),COUNT(item.pn_jid) FILTER(WHERE item.state='conflict'),run.unresolved_members
 FROM devices d JOIN whatsapp_identity_scopes scope ON scope.account_id=d.account_id AND scope.device_id=d.id JOIN whatsapp_identity_recovery_runs run ON run.account_id=scope.account_id AND run.device_id=scope.device_id AND run.session_generation=scope.session_generation AND run.version=$3
 LEFT JOIN whatsapp_identity_recovery_items item ON item.account_id=run.account_id AND item.run_id=run.id
 WHERE d.account_id=$1 AND d.id=$2 AND d.delete_operation_id IS NULL AND run.state<>'cancelled' GROUP BY d.status,run.id,run.account_id`, accountID, deviceID, domain.WhatsAppIdentityRecoveryVersion).Scan(&out.State, &out.Phase, &out.LastErrorCode, &out.UpdatedAt, &out.Processed, &out.Resolved, &out.Pending, &out.Conflicts, &out.UnresolvedMembers)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return out, err
}

// Private device-name rows are candidates only. A provider response must prove
// the pair before these known PN values can resolve another participant LID.
func (r *ChatRepository) IdentityRecoveryPrivatePNCandidates(ctx context.Context, accountID, deviceID uuid.UUID, after string, limit int) ([]string, error) {
	if limit < 1 || limit > 500 {
		limit = 500
	}
	rows, err := r.db.Query(ctx, `WITH candidates AS(SELECT DISTINCT CASE WHEN c.jid ~ '^[0-9]{7,15}@s[.]whatsapp[.]net$' THEN c.jid ELSE regexp_replace(c.phone,'[^0-9]','','g')||'@s.whatsapp.net' END pn
 FROM contact_device_names names JOIN contacts c ON c.id=names.contact_id AND c.account_id=$1 AND c.is_group=FALSE
 JOIN devices d ON d.id=names.device_id AND d.account_id=c.account_id
 LEFT JOIN whatsapp_identity_scopes scope ON scope.account_id=d.account_id AND scope.device_id=d.id
 WHERE names.device_id=$2 AND (scope.session_started_at IS NULL OR names.synced_at>=scope.session_started_at)
 AND EXISTS(SELECT 1 FROM chats ch WHERE ch.account_id=c.account_id AND ch.device_id=d.id AND ch.contact_id=c.id AND ch.jid NOT LIKE '%@g.us' AND ch.channel_key='whatsapp_web'))
 SELECT pn FROM candidates WHERE pn ~ '^[0-9]{7,15}@s[.]whatsapp[.]net$' AND pn>$3::text ORDER BY pn LIMIT $4`, accountID, deviceID, after, limit)
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

// Keep durations in SQL inputs typed rather than interpolating any provider data.
func identityRecoveryNext(attempt int) time.Time {
	return time.Now().UTC().Add(domain.WhatsAppIdentityRecoveryRetryDelay(attempt))
}

var ErrWhatsAppGroupSnapshotChanged = errors.New("WhatsApp group snapshot changed")

func (r *ChatRepository) RecordWhatsAppGroupSnapshotVersionCAS(ctx context.Context, accountID, deviceID uuid.UUID, groupJID string, material []byte, expected int64) (int64, error) {
	if !strings.HasSuffix(groupJID, "@g.us") || !json.Valid(material) || len(material) > 2<<20 {
		return 0, fmt.Errorf("invalid group version material")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO whatsapp_identity_group_versions(account_id,device_id,group_jid,revision) SELECT $1,$2,$3::text,0 FROM devices WHERE account_id=$1 AND id=$2 AND delete_operation_id IS NULL ON CONFLICT(account_id,device_id,group_jid) DO NOTHING`, accountID, deviceID, groupJID); err != nil {
		return 0, err
	}
	var current int64
	if err = tx.QueryRow(ctx, `SELECT revision FROM whatsapp_identity_group_versions WHERE account_id=$1 AND device_id=$2 AND group_jid=$3 FOR UPDATE`, accountID, deviceID, groupJID).Scan(&current); err != nil {
		return 0, err
	}
	if current != expected {
		return current, ErrWhatsAppGroupSnapshotChanged
	}
	if _, err = tx.Exec(ctx, `UPDATE whatsapp_identity_group_versions SET revision=revision+1,material=$4::jsonb WHERE account_id=$1 AND device_id=$2 AND group_jid=$3 AND material IS DISTINCT FROM $4::jsonb`, accountID, deviceID, groupJID, material); err != nil {
		return 0, err
	}
	if err = tx.QueryRow(ctx, `SELECT revision FROM whatsapp_identity_group_versions WHERE account_id=$1 AND device_id=$2 AND group_jid=$3`, accountID, deviceID, groupJID).Scan(&current); err != nil {
		return 0, err
	}
	return current, tx.Commit(ctx)
}
