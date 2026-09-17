package repository

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrOfflineConflictNotFound = errors.New("offline conflict not found or not resolvable")

// roles is a global role catalog. Account isolation comes from the exact
// user_accounts membership being checked against the conflict's account.
const offlineConflictResolverPredicate = `(c.user_id=$2 OR EXISTS(
			SELECT 1 FROM user_accounts ua LEFT JOIN roles ro ON ro.id=ua.role_id
			WHERE ua.account_id=c.account_id AND ua.user_id=$2 AND (ua.role IN ('admin','owner','super_admin') OR '*'=ANY(COALESCE(ro.permissions,'{}'::text[])))
		))`

func (r *OfflineRepository) SelectionForOperation(ctx context.Context, record *OfflineAuthRecordV2, selectionID uuid.UUID) (*domain.OfflineResourceSelection, error) {
	selection := &domain.OfflineResourceSelection{}
	err := r.db.QueryRow(ctx, `SELECT s.id,s.grant_id,s.account_id,s.module,s.resource_type,s.resource_id,COALESCE(h.head_version,1),s.updated_at
		FROM offline_resource_selections s
		JOIN offline_terminal_grants g ON g.id=s.grant_id AND g.account_id=s.account_id
		LEFT JOIN offline_resource_heads h ON h.selection_id=s.id
		WHERE s.id=$1 AND g.terminal_id=$2 AND g.account_id=$3 AND g.user_id=$4 AND g.state='active'`, selectionID, record.TerminalID, record.AccountID, record.UserID).
		Scan(&selection.ID, &selection.GrantID, &selection.AccountID, &selection.Module, &selection.ResourceType, &selection.ResourceID, &selection.HeadVersion, &selection.UpdatedAt)
	return selection, err
}

func (r *OfflineRepository) CreateConflict(ctx context.Context, record *OfflineAuthRecordV2, operation domain.OfflineOperation, serverVersion int64, serverValue json.RawMessage, paths []string) (uuid.UUID, error) {
	conflictID := uuid.New()
	base := operation.Base
	if len(base) == 0 || !json.Valid(base) {
		base = json.RawMessage(`{}`)
	}
	client := operation.Patch
	if len(client) == 0 || !json.Valid(client) {
		client = json.RawMessage(`{}`)
	}
	err := r.db.QueryRow(ctx, `INSERT INTO offline_sync_conflicts(id,account_id,terminal_id,user_id,operation_id,module,resource_type,resource_id,server_version,client_version,base_version,base_value,server_value,client_value,conflict_paths)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14)
		ON CONFLICT(account_id,terminal_id,operation_id) DO UPDATE SET server_version=EXCLUDED.server_version,server_value=EXCLUDED.server_value,conflict_paths=EXCLUDED.conflict_paths
		RETURNING id`, conflictID, record.AccountID, record.TerminalID, record.UserID, operation.OperationID, operation.Module, operation.ResourceType, operation.ResourceID, serverVersion, operation.BaseVersion, base, serverValue, client, paths).Scan(&conflictID)
	return conflictID, err
}

func (r *OfflineRepository) ListConflictsForResolver(ctx context.Context, accountID, actorID uuid.UUID, limit int) ([]domain.OfflineConflict, error) {
	if limit < 1 || limit > 200 {
		limit = 100
	}
	rows, err := r.db.Query(ctx, `SELECT c.id,c.terminal_id,c.operation_id,c.module,c.resource_type,c.resource_id,c.server_version,COALESCE(c.base_version,c.client_version),c.base_value,c.server_value,c.client_value,c.conflict_paths,c.status,c.created_at
		FROM offline_sync_conflicts c
		WHERE c.account_id=$1 AND c.status='open' AND `+offlineConflictResolverPredicate+`
		ORDER BY c.created_at DESC,c.id LIMIT $3`, accountID, actorID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.OfflineConflict, 0)
	for rows.Next() {
		var item domain.OfflineConflict
		if err := rows.Scan(&item.ID, &item.TerminalID, &item.OperationID, &item.Module, &item.ResourceType, &item.ResourceID, &item.ServerVersion, &item.BaseVersion, &item.BaseValue, &item.ServerValue, &item.ClientValue, &item.ConflictPaths, &item.Status, &item.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (r *OfflineRepository) ResolveConflictWithServer(ctx context.Context, accountID, actorID, conflictID uuid.UUID, note string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var terminalID, operationID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE offline_sync_conflicts c SET status='resolved_server',resolved_by=$2,resolved_at=NOW(),resolution_value=server_value,resolution_note=NULLIF($4,'')
		WHERE c.id=$3 AND c.account_id=$1 AND c.status='open' AND `+offlineConflictResolverPredicate+`
		RETURNING terminal_id,operation_id`, accountID, actorID, conflictID, note).Scan(&terminalID, &operationID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrOfflineConflictNotFound
	}
	if err != nil {
		return err
	}
	result, _ := json.Marshal(domain.OfflineOperationResult{OperationID: operationID, Status: domain.OfflineOperationRejected, ErrorCode: "conflict_resolved_server"})
	if _, err := tx.Exec(ctx, `UPDATE offline_sync_receipts SET status='rejected',result=$4,completed_at=NOW() WHERE account_id=$1 AND terminal_id=$2 AND operation_id=$3`, accountID, terminalID, operationID, result); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO offline_terminal_audit(terminal_id,account_id,actor_id,event_type,metadata) VALUES($1,$2,$3,'conflict_resolved_server',jsonb_build_object('conflict_id',$4::text,'operation_id',$5::text))`, terminalID, accountID, actorID, conflictID, operationID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
