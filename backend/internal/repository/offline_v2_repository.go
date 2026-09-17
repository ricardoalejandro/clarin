package repository

import (
	"context"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

const offlineChallengeV2TTL = time.Minute

var ErrOfflineReplay = errors.New("offline request replayed or out of order")

type OfflineChallengeV2 struct {
	ChallengeID uuid.UUID `json:"challenge_id"`
	Nonce       string    `json:"nonce"`
	ExpiresAt   time.Time `json:"expires_at"`
	State       string    `json:"terminal_state"`
}

type OfflineAuthRecordV2 struct {
	TerminalID          uuid.UUID
	UserID              uuid.UUID
	AccountID           uuid.UUID
	PolicyRevision      int64
	GrantRevision       int64
	MaxOfflineSeconds   int
	Modules             []string
	Actions             json.RawMessage
	TerminalState       string
	GrantState          string
	SelectionRevision   int64
	QuotaBytes          int64
	MaxStorageBytes     int64
	InstallInstanceHash string
	PublicKeyPEM        string
}

// Small indirections keep entropy encoding testable without weakening it.
var randRead = func(p []byte) (int, error) { return cryptorand.Read(p) }
var base64Raw = func(p []byte) string { return base64.RawURLEncoding.EncodeToString(p) }

type OfflineSignedControlInput struct {
	ID               uuid.UUID
	DirectiveType    string
	Payload          json.RawMessage
	PayloadHash      []byte
	Signature        string
	SignerKeyVersion int
}

func (r *OfflineRepository) CreateChallengeV2(ctx context.Context, terminalID uuid.UUID) (*OfflineChallengeV2, error) {
	var state string
	if err := r.db.QueryRow(ctx, `SELECT state FROM offline_terminals WHERE id=$1 AND state IN ('active','revoked') AND public_key_pem IS NOT NULL`, terminalID).Scan(&state); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineTerminalNotFound
	} else if err != nil {
		return nil, err
	}
	raw := make([]byte, 32)
	if _, err := randRead(raw); err != nil {
		return nil, err
	}
	nonce := base64Raw(raw)
	hash := sha256.Sum256([]byte(nonce))
	challenge := &OfflineChallengeV2{ChallengeID: uuid.New(), Nonce: nonce, ExpiresAt: time.Now().UTC().Add(offlineChallengeV2TTL), State: state}
	_, err := r.db.Exec(ctx, `INSERT INTO offline_sync_nonces(terminal_id,challenge_id,nonce_hash,expires_at) VALUES($1,$2,$3,$4)`, terminalID, challenge.ChallengeID, hash[:], challenge.ExpiresAt)
	if err != nil {
		return nil, err
	}
	return challenge, nil
}

// OfflineAuthV2 resolves identity exclusively from persisted terminal and
// grant state. A revoked terminal remains recognizable only so the server can
// return a signed wipe directive; it never regains data access.
func (r *OfflineRepository) OfflineAuthV2(ctx context.Context, terminalID, accountID uuid.UUID) (*OfflineAuthRecordV2, error) {
	record := &OfflineAuthRecordV2{}
	err := r.db.QueryRow(ctx, `SELECT t.id,t.user_id,g.account_id,t.policy_revision,g.policy_revision,g.max_offline_seconds,g.modules,g.actions,t.state,g.state,g.selection_revision,g.quota_bytes,t.max_storage_bytes,COALESCE(t.install_instance_hash,''),COALESCE(t.public_key_pem,'')
		FROM offline_terminals t
		JOIN offline_terminal_grants g ON g.terminal_id=t.id AND g.user_id=t.user_id
		WHERE t.id=$1 AND g.account_id=$2 AND t.state IN ('active','revoked') AND t.public_key_pem IS NOT NULL`, terminalID, accountID).
		Scan(&record.TerminalID, &record.UserID, &record.AccountID, &record.PolicyRevision, &record.GrantRevision, &record.MaxOfflineSeconds, &record.Modules, &record.Actions, &record.TerminalState, &record.GrantState, &record.SelectionRevision, &record.QuotaBytes, &record.MaxStorageBytes, &record.InstallInstanceHash, &record.PublicKeyPEM)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrOfflineTerminalNotFound
	}
	return record, err
}

func (r *OfflineRepository) ConsumeChallengeV2(ctx context.Context, challengeID, terminalID, accountID uuid.UUID, nonce string, counter int64) error {
	if challengeID == uuid.Nil || counter < 1 {
		return ErrOfflineReplay
	}
	hash := sha256.Sum256([]byte(nonce))
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE offline_sync_nonces SET consumed_at=NOW() WHERE challenge_id=$1 AND terminal_id=$2 AND nonce_hash=$3 AND consumed_at IS NULL AND expires_at>NOW()`, challengeID, terminalID, hash[:])
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineReplay
	}
	var accepted int64
	err = tx.QueryRow(ctx, `INSERT INTO offline_terminal_cursors(terminal_id,account_id,last_counter,updated_at) VALUES($1,$2,$3,NOW()) ON CONFLICT(terminal_id,account_id) DO UPDATE SET last_counter=EXCLUDED.last_counter,updated_at=NOW() WHERE offline_terminal_cursors.last_counter<EXCLUDED.last_counter RETURNING last_counter`, terminalID, accountID, counter).Scan(&accepted)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineReplay
	} else if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) ListUserOfflineGrants(ctx context.Context, userID uuid.UUID) ([]domain.OfflineGrant, error) {
	rows, err := r.db.Query(ctx, `SELECT g.id,g.terminal_id,g.user_id,g.account_id,a.name,g.modules,g.actions,g.max_offline_seconds,g.quota_bytes,g.state,g.policy_revision,g.selection_revision,g.created_at,g.updated_at
		FROM offline_terminal_grants g
		JOIN offline_terminals t ON t.id=g.terminal_id AND t.user_id=g.user_id
		JOIN accounts a ON a.id=g.account_id
		WHERE g.user_id=$1 AND g.state='active' AND t.state='active'
		ORDER BY a.name,t.display_name`, userID)
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

func (r *OfflineRepository) ListSelections(ctx context.Context, grantID, userID uuid.UUID) ([]domain.OfflineResourceSelection, error) {
	rows, err := r.db.Query(ctx, `SELECT s.id,s.grant_id,s.account_id,s.module,s.resource_type,s.resource_id,
		CASE s.resource_type WHEN 'whiteboard' THEN COALESCE((SELECT name FROM whiteboards WHERE account_id=s.account_id AND id=s.resource_id),'Pizarra no disponible') WHEN 'task_list' THEN COALESCE((SELECT name FROM task_lists WHERE account_id=s.account_id AND id=s.resource_id),'Lista no disponible') WHEN 'contact' THEN COALESCE((SELECT COALESCE(NULLIF(BTRIM(custom_name),''),NULLIF(BTRIM(name),''),phone,'Contacto sin nombre') FROM contacts WHERE account_id=s.account_id AND id=s.resource_id),'Contacto no disponible') WHEN 'program' THEN COALESCE((SELECT name FROM programs WHERE account_id=s.account_id AND id=s.resource_id),'Programa no disponible') END,
		COALESCE(h.head_version,1),s.updated_at
		FROM offline_resource_selections s
		JOIN offline_terminal_grants g ON g.id=s.grant_id AND g.account_id=s.account_id
		LEFT JOIN offline_resource_heads h ON h.selection_id=s.id
		WHERE s.grant_id=$1 AND g.user_id=$2 AND g.state='active'
		ORDER BY s.module,s.resource_id`, grantID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineResourceSelection, 0)
	for rows.Next() {
		var item domain.OfflineResourceSelection
		if err := rows.Scan(&item.ID, &item.GrantID, &item.AccountID, &item.Module, &item.ResourceType, &item.ResourceID, &item.Label, &item.HeadVersion, &item.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

// ReplaceSelections is called only after the API has checked the target
// user's current canonical ACL for every resource. The transaction repeats all
// account/module/type invariants and advances one revision for reconciliation.
func (r *OfflineRepository) ReplaceSelections(ctx context.Context, grantID, userID uuid.UUID, selections []domain.OfflineResourceSelection) (int64, error) {
	if len(selections) > 20 {
		return 0, ErrOfflineResourceInvalid
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	var accountID uuid.UUID
	var modules []string
	if err := tx.QueryRow(ctx, `SELECT account_id,modules FROM offline_terminal_grants WHERE id=$1 AND user_id=$2 AND state='active' FOR UPDATE`, grantID, userID).Scan(&accountID, &modules); errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrOfflineTerminalNotFound
	} else if err != nil {
		return 0, err
	}
	allowedModules := make(map[string]bool, len(modules))
	for _, module := range modules {
		allowedModules[module] = true
	}
	seen := make(map[string]struct{}, len(selections))
	for _, selection := range selections {
		expectedModule, ok := domain.OfflineModuleForResourceType(selection.ResourceType)
		key := selection.Module + ":" + selection.ResourceType + ":" + selection.ResourceID.String()
		if !ok || expectedModule != selection.Module || !allowedModules[selection.Module] || selection.ResourceID == uuid.Nil {
			return 0, ErrOfflineResourceInvalid
		}
		if _, duplicate := seen[key]; duplicate {
			return 0, ErrOfflineResourceInvalid
		}
		seen[key] = struct{}{}
		if err := validateOfflineResource(ctx, tx, accountID, selection); err != nil {
			return 0, err
		}
	}
	existingRows, err := tx.Query(ctx, `SELECT id,module,resource_type,resource_id FROM offline_resource_selections WHERE grant_id=$1 FOR UPDATE`, grantID)
	if err != nil {
		return 0, err
	}
	existing := make(map[string]uuid.UUID)
	for existingRows.Next() {
		var id, resourceID uuid.UUID
		var module, resourceType string
		if err := existingRows.Scan(&id, &module, &resourceType, &resourceID); err != nil {
			existingRows.Close()
			return 0, err
		}
		existing[offlineSelectionKey(module, resourceType, resourceID)] = id
	}
	if err := existingRows.Err(); err != nil {
		existingRows.Close()
		return 0, err
	}
	existingRows.Close()
	changed := len(existing) != len(selections)
	for key, selectionID := range existing {
		if _, keep := seen[key]; keep {
			continue
		}
		changed = true
		if _, err := tx.Exec(ctx, `DELETE FROM offline_resource_selections WHERE grant_id=$1 AND id=$2`, grantID, selectionID); err != nil {
			return 0, err
		}
	}
	for _, selection := range selections {
		key := offlineSelectionKey(selection.Module, selection.ResourceType, selection.ResourceID)
		if _, keep := existing[key]; keep {
			continue
		}
		changed = true
		var selectionID uuid.UUID
		if err := tx.QueryRow(ctx, `INSERT INTO offline_resource_selections(grant_id,account_id,module,resource_type,resource_id,selected_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, grantID, accountID, selection.Module, selection.ResourceType, selection.ResourceID, userID).Scan(&selectionID); err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_resource_heads(selection_id,grant_id,account_id,module,resource_type,resource_id) VALUES($1,$2,$3,$4,$5,$6)`, selectionID, grantID, accountID, selection.Module, selection.ResourceType, selection.ResourceID); err != nil {
			return 0, err
		}
	}
	var revision int64
	if changed {
		if err := tx.QueryRow(ctx, `UPDATE offline_terminal_grants SET selection_revision=selection_revision+1,updated_at=NOW() WHERE id=$1 RETURNING selection_revision`, grantID).Scan(&revision); err != nil {
			return 0, err
		}
		metadata, err := offlineSelectionAuditMetadata(len(selections), revision)
		if err != nil {
			return 0, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,account_id,actor_id,event_type,metadata) SELECT terminal_id,account_id,$2,'resource_selection_replaced',$3::jsonb FROM offline_terminal_grants WHERE id=$1`, grantID, userID, metadata); err != nil {
			return 0, err
		}
	} else if err := tx.QueryRow(ctx, `SELECT selection_revision FROM offline_terminal_grants WHERE id=$1`, grantID).Scan(&revision); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return revision, nil
}

func offlineSelectionAuditMetadata(count int, revision int64) ([]byte, error) {
	return json.Marshal(struct {
		Count             int   `json:"count"`
		SelectionRevision int64 `json:"selection_revision"`
	}{Count: count, SelectionRevision: revision})
}

func offlineSelectionKey(module, resourceType string, resourceID uuid.UUID) string {
	return module + ":" + resourceType + ":" + resourceID.String()
}

func (r *OfflineRepository) Inventory(ctx context.Context, terminalID, accountID uuid.UUID) ([]domain.OfflineInventoryItem, error) {
	rows, err := r.db.Query(ctx, `SELECT h.selection_id,h.module,h.resource_type,h.resource_id,h.head_version,h.content_hash
		FROM offline_resource_heads h
		JOIN offline_terminal_grants g ON g.id=h.grant_id AND g.account_id=h.account_id
		WHERE g.terminal_id=$1 AND g.account_id=$2 AND g.state='active'
		ORDER BY h.module,h.resource_id`, terminalID, accountID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineInventoryItem, 0)
	for rows.Next() {
		var item domain.OfflineInventoryItem
		var hash []byte
		if err := rows.Scan(&item.SelectionID, &item.Module, &item.ResourceType, &item.ResourceID, &item.HeadVersion, &hash); err != nil {
			return nil, err
		}
		if len(hash) > 0 {
			item.ContentHash = hex.EncodeToString(hash)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) RecordSuccessfulSyncV2(ctx context.Context, terminalID uuid.UUID, clientVersion string, usedStorageBytes int64, posture domain.OfflineDevicePosture) error {
	if usedStorageBytes < 0 {
		usedStorageBytes = 0
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var previousBitLocker, previousWindowsHello string
	if err := tx.QueryRow(ctx, `SELECT bitlocker_status,windows_hello_status FROM offline_terminals WHERE id=$1 AND state='active' FOR UPDATE`, terminalID).Scan(&previousBitLocker, &previousWindowsHello); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_terminals SET last_seen_at=NOW(),last_sync_at=NOW(),used_storage_bytes=LEAST(max_storage_bytes,$3),client_version=COALESCE(NULLIF($2,''),client_version),bitlocker_status=$4,windows_hello_status=$5,posture_reported_at=NOW(),last_error_code=NULL,updated_at=NOW() WHERE id=$1 AND state='active'`, terminalID, clientVersion, usedStorageBytes, posture.BitLocker, posture.WindowsHello); err != nil {
		return err
	}
	if previousBitLocker != posture.BitLocker || previousWindowsHello != posture.WindowsHello {
		if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,event_type,metadata) VALUES($1,'device_posture_changed',jsonb_build_object('bitlocker_status',$2::text,'windows_hello_status',$3::text))`, terminalID, posture.BitLocker, posture.WindowsHello); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) RevokeTerminalWithControl(ctx context.Context, terminalID, actorID uuid.UUID, control OfflineSignedControlInput) error {
	if control.ID == uuid.Nil || control.DirectiveType != "wipe" || len(control.Payload) == 0 || len(control.PayloadHash) == 0 || control.Signature == "" || control.SignerKeyVersion < 1 {
		return fmt.Errorf("invalid signed offline control directive")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `UPDATE offline_terminals SET state='revoked',revoked_at=COALESCE(revoked_at,NOW()),wipe_required_at=COALESCE(wipe_required_at,NOW()),policy_revision=policy_revision+1,updated_at=NOW() WHERE id=$1 AND state<>'revoked'`, terminalID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM offline_terminals WHERE id=$1)`, terminalID).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrOfflineTerminalNotFound
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE offline_terminal_grants SET state='revoked',revoked_at=COALESCE(revoked_at,NOW()),policy_revision=policy_revision+1,updated_at=NOW() WHERE terminal_id=$1 AND state<>'revoked'`, terminalID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_control_directives(id,terminal_id,directive_type,payload,payload_encoded,payload_hash,signature,signer_key_version,created_by,signed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) ON CONFLICT(terminal_id,directive_type,payload_hash) DO NOTHING`, control.ID, terminalID, control.DirectiveType, control.Payload, base64.RawURLEncoding.EncodeToString(control.Payload), control.PayloadHash, control.Signature, control.SignerKeyVersion, actorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,actor_id,event_type,metadata) VALUES($1,$2,'terminal_revoked',jsonb_build_object('control_id',$3::text))`, terminalID, actorID, control.ID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *OfflineRepository) PendingControlDirectives(ctx context.Context, terminalID uuid.UUID) ([]domain.OfflineControlDirective, error) {
	rows, err := r.db.Query(ctx, `UPDATE offline_control_directives SET delivered_at=COALESCE(delivered_at,NOW()) WHERE terminal_id=$1 AND acknowledged_at IS NULL AND signature IS NOT NULL AND payload_encoded IS NOT NULL RETURNING id,terminal_id,directive_type,payload_encoded,signature,signer_key_version,created_at`, terminalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineControlDirective, 0)
	for rows.Next() {
		var directive domain.OfflineControlDirective
		if err := rows.Scan(&directive.ID, &directive.TerminalID, &directive.DirectiveType, &directive.Payload, &directive.Signature, &directive.SignerKeyVersion, &directive.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, directive)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) AcknowledgeControl(ctx context.Context, terminalID, directiveID uuid.UUID, acknowledgement json.RawMessage) error {
	if len(acknowledgement) == 0 {
		acknowledgement = json.RawMessage(`{}`)
	}
	tag, err := r.db.Exec(ctx, `WITH ack AS (UPDATE offline_control_directives SET acknowledged_at=NOW(),acknowledgement=$3 WHERE id=$1 AND terminal_id=$2 AND acknowledged_at IS NULL RETURNING directive_type) UPDATE offline_terminals SET wipe_acknowledged_at=CASE WHEN EXISTS(SELECT 1 FROM ack WHERE directive_type='wipe') THEN NOW() ELSE wipe_acknowledged_at END,updated_at=NOW() WHERE id=$2 AND EXISTS(SELECT 1 FROM ack)`, directiveID, terminalID, acknowledgement)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return ErrOfflineTerminalNotFound
	}
	return nil
}
