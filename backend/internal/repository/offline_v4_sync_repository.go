package repository

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type OfflineV4SyncInput struct {
	GrantID           uuid.UUID                   `json:"grant_id"`
	BrowserProfileID  uuid.UUID                   `json:"browser_profile_id"`
	ChallengeID       uuid.UUID                   `json:"challenge_id"`
	Nonce             string                      `json:"nonce"`
	SelectionRevision int64                       `json:"selection_revision"`
	Operations        []domain.OfflineV3Operation `json:"operations"`
	WantSnapshots     []uuid.UUID                 `json:"want_snapshots"`
}

type OfflineV4SyncResult struct {
	Record    *OfflineV4AuthRecord
	Snapshots []domain.OfflineV4Snapshot
	Receipts  []domain.OfflineV3OperationResult
}

var ErrOfflineV4QuotaExceeded = errors.New("offline_quota_exceeded")

func offlineV4OperationBinding(record *OfflineV4AuthRecord, op domain.OfflineV3Operation, now time.Time) bool {
	return record != nil && op.ProtocolVersion == 4 && op.GrantID == record.GrantID && op.UserID == record.UserID && op.AccountID == record.AccountID &&
		op.BrowserProfileID == record.BrowserProfileID && op.OperationID != uuid.Nil && op.ResourceID != uuid.Nil && op.SelectionID != uuid.Nil &&
		op.SelectionRevision == record.SelectionRevision && op.CredentialEpoch == record.CredentialEpoch && op.AuthorityEpoch == record.AuthorityEpoch &&
		!op.OccurredAt.IsZero() && !op.OccurredAt.After(now.Add(5*time.Minute)) &&
		(op.Action == domain.OfflineV3ActionTasksCreate || op.Action == domain.OfflineV3ActionTasksComplete)
}

func (r *OfflineV4Repository) applyTaskTx(ctx context.Context, tx pgx.Tx, record *OfflineV4AuthRecord, op domain.OfflineV3Operation) (domain.OfflineV3OperationResult, error) {
	result := domain.OfflineV3OperationResult{OperationID: op.OperationID, ResourceID: op.ResourceID, Status: "rejected"}
	if !offlineV4OperationBinding(record, op, time.Now().UTC()) {
		return result, ErrOfflineV3Invalid
	}
	raw, err := json.Marshal(op)
	if err != nil {
		return result, err
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	var storedHash string
	var stored []byte
	err = tx.QueryRow(ctx, `SELECT request_hash,result FROM offline_v4_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`, record.GrantID, record.AccountID, op.OperationID).Scan(&storedHash, &stored)
	if err == nil {
		if storedHash != hash {
			return result, ErrOfflineV3ReceiptReuse
		}
		err = json.Unmarshal(stored, &result)
		return result, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return result, err
	}
	store := func(seed *domain.Task) (domain.OfflineV3OperationResult, error) {
		return result, r.storeReceiptTx(ctx, tx, record, op, hash, result, seed)
	}
	if !offlineV4HasAction(record.Actions, op.Action) || !offlineV4HasAction(record.Actions, domain.OfflineV3ActionTasksRead) {
		result.ErrorCode = "action_not_allowed"
		return store(nil)
	}
	selection := domain.OfflineV3Selection{ID: op.SelectionID, GrantID: record.GrantID, AccountID: record.AccountID, Module: domain.OfflineModuleTasks, ResourceType: domain.OfflineResourceTaskList}
	err = tx.QueryRow(ctx, `SELECT resource_id FROM offline_v4_selections WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND module='tasks' AND resource_type='task_list' FOR SHARE`, op.SelectionID, record.GrantID, record.AccountID).Scan(&selection.ResourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		result.ErrorCode = "outside_selection"
		return store(nil)
	}
	if err != nil {
		return result, err
	}
	access := domain.TaskAccessView
	if op.Action == domain.OfflineV3ActionTasksCreate {
		access = domain.TaskAccessEdit
	}
	if err = validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, selection, access); err != nil {
		if errors.Is(err, ErrOfflineV3AccessDenied) {
			result.ErrorCode = "access_revoked"
			return store(nil)
		}
		return result, err
	}
	version := op.BaseVersion
	if dep := op.DependsOnOperationID; dep != nil {
		if *dep == uuid.Nil || *dep == op.OperationID || op.Action != domain.OfflineV3ActionTasksComplete || version != 0 {
			result.ErrorCode = "invalid_operation_dependency"
			return store(nil)
		}
		var action, status string
		var resourceID uuid.UUID
		err = tx.QueryRow(ctx, `SELECT action_code,status,resource_id,server_version FROM offline_v4_receipts WHERE grant_id=$1 AND account_id=$2 AND operation_id=$3`, record.GrantID, record.AccountID, *dep).Scan(&action, &status, &resourceID, &version)
		if errors.Is(err, pgx.ErrNoRows) {
			result.Status = "pending"
			result.ErrorCode = "operation_dependency_pending"
			return result, nil
		}
		if err != nil {
			return result, err
		}
		if action != domain.OfflineV3ActionTasksCreate || status != "applied" || resourceID != op.ResourceID || version < 1 {
			result.ErrorCode = "operation_dependency_rejected"
			return store(nil)
		}
	}
	var seed *domain.Task
	result, seed, err = applyOfflineTaskMutationTx(ctx, tx, r.db, offlineTaskAuthority{AccountID: record.AccountID, UserID: record.UserID, GrantID: record.GrantID}, op, selection, version, offlineV4HasAction(record.Actions, domain.OfflineV3ActionTasksComplete), "offline_v4")
	if err != nil {
		return result, err
	}
	return store(seed)
}

func (r *OfflineV4Repository) storeReceiptTx(ctx context.Context, tx pgx.Tx, record *OfflineV4AuthRecord, op domain.OfflineV3Operation, hash string, result domain.OfflineV3OperationResult, seed *domain.Task) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v4_receipts(grant_id,account_id,operation_id,request_hash,action_code,resource_id,status,error_code,server_version,result) VALUES($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9,$10::jsonb)`, record.GrantID, record.AccountID, op.OperationID, hash, op.Action, op.ResourceID, result.Status, result.ErrorCode, result.ServerVersion, encoded)
	if err != nil {
		return err
	}
	if result.Status != "applied" {
		return nil
	}
	effect := OfflineV3TaskEffect{Origin: "offline_v4", ID: uuid.New(), GrantID: record.GrantID, AccountID: record.AccountID, OperationID: op.OperationID, TaskID: op.ResourceID, ActorID: record.UserID, Action: op.Action, TaskVersion: result.ServerVersion, RecurrenceSeed: seed}
	encoded, err = json.Marshal(effect)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO offline_v4_event_outbox(id,grant_id,account_id,operation_id,event_type,payload) VALUES($1,$2,$3,$4,'task_effect',$5::jsonb)`, effect.ID, effect.GrantID, effect.AccountID, effect.OperationID, encoded)
	return err
}

func (r *OfflineV4Repository) Sync(ctx context.Context, input OfflineV4SyncInput, expected *OfflineV4AuthRecord, writes bool, loadAsset OfflineV3AssetLoader, finalize func(context.Context, *OfflineV4AuthRecord) error) (*OfflineV4SyncResult, error) {
	if expected == nil || input.GrantID == uuid.Nil || input.BrowserProfileID != expected.BrowserProfileID || input.GrantID != expected.GrantID || len(input.Operations) > 100 || len(input.WantSnapshots) > 4 {
		return nil, ErrOfflineV3Invalid
	}
	if len(input.Operations) > 0 && !writes {
		return nil, ErrOfflineV3AccessDenied
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	record, err := r.LockActiveGrantTx(ctx, tx, input.GrantID, "")
	if err != nil {
		return nil, err
	}
	if record.OfflineV4Tuple != expected.OfflineV4Tuple || record.BrowserKeyThumbprint != expected.BrowserKeyThumbprint || record.GrantKeyThumbprint != expected.GrantKeyThumbprint || record.GrantKeyThumbprint == "" {
		return nil, ErrOfflineV3AccessDenied
	}
	if input.SelectionRevision != record.SelectionRevision {
		return nil, ErrOfflineV3Conflict
	}
	if err = consumeOfflineV4Challenge(ctx, tx, input.ChallengeID, uuid.Nil, input.GrantID, "sync", input.Nonce); err != nil {
		return nil, err
	}
	// Recheck all selected ACLs even for a receipt-only sync before extending a
	// lease. Connectivity never turns a removed permission back into authority.
	selections, err := offlineV4SelectionsTx(ctx, tx, record.GrantID, record.AccountID)
	if err != nil {
		return nil, err
	}
	byID := map[uuid.UUID]domain.OfflineV3Selection{}
	for _, selection := range selections {
		action, ok := offlineV3ReadAction(selection.Module)
		if !ok || !offlineV4HasAction(record.Actions, action) {
			return nil, ErrOfflineV3AccessDenied
		}
		if err = validateOfflineV3ResourceAccess(ctx, tx, record.UserID, record.AccountID, selection, domain.TaskAccessView); err != nil {
			return nil, err
		}
		byID[selection.ID] = selection
	}
	out := &OfflineV4SyncResult{Record: record, Snapshots: []domain.OfflineV4Snapshot{}, Receipts: []domain.OfflineV3OperationResult{}}
	for _, op := range input.Operations {
		result, err := r.applyTaskTx(ctx, tx, record, op)
		if err != nil {
			return nil, err
		}
		out.Receipts = append(out.Receipts, result)
	}
	seen := map[uuid.UUID]bool{}
	for _, id := range input.WantSnapshots {
		selection, ok := byID[id]
		if !ok || seen[id] {
			return nil, ErrOfflineV3Invalid
		}
		seen[id] = true
		var payload json.RawMessage
		if selection.Module == domain.OfflineModuleTasks {
			payload, err = offlineTaskListSnapshot(ctx, tx, record.AccountID, record.UserID, selection.ResourceID, offlineV4HasAction(record.Actions, domain.OfflineV3ActionTasksCreate), offlineV4HasAction(record.Actions, domain.OfflineV3ActionTasksComplete))
		} else {
			payload, _, err = offlineV3SnapshotPayload(ctx, tx, record.AccountID, record.UserID, selection, loadAsset)
		}
		if err != nil {
			return nil, err
		}
		if len(payload) > offlineV3MaxSnapshotBytes {
			return nil, ErrOfflineSnapshotTooLarge
		}
		digest := sha256.Sum256(payload)
		hash := hex.EncodeToString(digest[:])
		var version int64
		err = tx.QueryRow(ctx, `UPDATE offline_v4_selections SET head_version=CASE WHEN content_hash IS DISTINCT FROM $4 THEN head_version+1 ELSE head_version END,content_hash=$4,byte_size=$5 WHERE id=$1 AND grant_id=$2 AND account_id=$3 RETURNING head_version`, id, record.GrantID, record.AccountID, hash, len(payload)).Scan(&version)
		if err != nil {
			return nil, err
		}
		out.Snapshots = append(out.Snapshots, domain.OfflineV4Snapshot{OfflineV4Tuple: record.OfflineV4Tuple, ProtocolVersion: 4, SelectionID: id, Module: selection.Module, ResourceType: selection.ResourceType, ResourceID: selection.ResourceID, SelectionRevision: record.SelectionRevision, HeadVersion: version, ContentHash: hash, Payload: payload, PayloadJSON: string(payload), GeneratedAt: time.Now().UTC()})
	}
	var selectedBytes int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(SUM(byte_size),0) FROM offline_v4_selections WHERE grant_id=$1 AND account_id=$2`, record.GrantID, record.AccountID).Scan(&selectedBytes); err != nil {
		return nil, err
	}
	if selectedBytes > record.QuotaBytes {
		return nil, ErrOfflineV4QuotaExceeded
	}
	// Keep the authority locks through lease signing. A concurrent revoke may
	// linearize before this transaction (denied) or after it, never between an
	// authorization read and issuance of a fresh lease.
	if finalize != nil {
		if err := finalize(ctx, record); err != nil {
			return nil, err
		}
	}
	return out, tx.Commit(ctx)
}
