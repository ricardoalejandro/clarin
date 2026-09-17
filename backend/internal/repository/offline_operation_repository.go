package repository

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrOfflineOperationIDReuse = errors.New("offline operation id reused with different content")

func (r *OfflineRepository) OperationStatuses(ctx context.Context, accountID, terminalID uuid.UUID, operationIDs []uuid.UUID) (map[uuid.UUID]string, error) {
	out := make(map[uuid.UUID]string)
	if len(operationIDs) == 0 {
		return out, nil
	}
	rows, err := r.db.Query(ctx, `SELECT operation_id,status FROM offline_sync_receipts WHERE account_id=$1 AND terminal_id=$2 AND operation_id=ANY($3::uuid[])`, accountID, terminalID, operationIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id uuid.UUID
		var status string
		if err := rows.Scan(&id, &status); err != nil {
			return nil, err
		}
		out[id] = status
	}
	return out, rows.Err()
}

func (r *OfflineRepository) ExistingOperationResult(ctx context.Context, accountID, terminalID, operationID uuid.UUID, requestHash []byte) (*domain.OfflineOperationResult, error) {
	var storedHash []byte
	var status string
	var resourceID *uuid.UUID
	var appliedVersion *int64
	var result json.RawMessage
	err := r.db.QueryRow(ctx, `SELECT request_hash,status,resource_id,applied_version,result FROM offline_sync_receipts WHERE account_id=$1 AND terminal_id=$2 AND operation_id=$3`, accountID, terminalID, operationID).
		Scan(&storedHash, &status, &resourceID, &appliedVersion, &result)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if subtle.ConstantTimeCompare(storedHash, requestHash) != 1 {
		return nil, ErrOfflineOperationIDReuse
	}
	out := &domain.OfflineOperationResult{OperationID: operationID, Status: status}
	_ = json.Unmarshal(result, out)
	out.OperationID, out.Status = operationID, status
	if resourceID != nil {
		out.ResourceID = *resourceID
	}
	if appliedVersion != nil {
		out.ServerVersion = *appliedVersion
	}
	return out, nil
}

func (r *OfflineRepository) StoreOperationResult(ctx context.Context, record *OfflineAuthRecordV2, operation domain.OfflineOperation, requestHash []byte, result domain.OfflineOperationResult) error {
	resultJSON, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `INSERT INTO offline_sync_receipts(account_id,terminal_id,user_id,operation_id,request_hash,status,result,module,resource_type,resource_id,operation_type,base_version,applied_version,completed_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NULLIF($13,0),NOW())
		ON CONFLICT(account_id,terminal_id,operation_id) DO NOTHING`, record.AccountID, record.TerminalID, record.UserID, operation.OperationID, requestHash, result.Status, resultJSON, operation.Module, operation.ResourceType, operation.ResourceID, operation.OperationType, operation.BaseVersion, result.ServerVersion)
	return err
}
