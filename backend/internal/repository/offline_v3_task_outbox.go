package repository

import (
	"context"
	"encoding/json"
)

// ClaimTaskEffects leases a bounded batch. A crashed worker is retried after
// the persisted deadline; the task mutation/receipt is never rerun here.
func (r *OfflineV3Repository) ClaimTaskEffects(ctx context.Context, limit int) ([]OfflineV3TaskEffect, error) {
	if limit < 1 || limit > 50 {
		limit = 20
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id,grant_id,account_id,operation_id,payload FROM offline_v3_event_outbox WHERE event_type='task_effect' AND processed_at IS NULL AND next_attempt_at<=NOW() ORDER BY next_attempt_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	effects := make([]OfflineV3TaskEffect, 0, limit)
	invalid := make([]OfflineV3TaskEffect, 0)
	for rows.Next() {
		var effect OfflineV3TaskEffect
		var payload json.RawMessage
		if err := rows.Scan(&effect.ID, &effect.GrantID, &effect.AccountID, &effect.OperationID, &payload); err != nil {
			rows.Close()
			return nil, err
		}
		var decoded OfflineV3TaskEffect
		if json.Unmarshal(payload, &decoded) != nil || decoded.ID != effect.ID || decoded.GrantID != effect.GrantID || decoded.AccountID != effect.AccountID || decoded.OperationID != effect.OperationID {
			invalid = append(invalid, effect)
			continue
		}
		effects = append(effects, decoded)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	// Preserve malformed records for diagnosis without allowing one corrupted
	// account/event to block valid effects for every other account indefinitely.
	for _, effect := range invalid {
		if _, err := tx.Exec(ctx, `UPDATE offline_v3_event_outbox SET attempts=attempts+1,last_error_code='task_effect_binding_invalid',next_attempt_at=NOW()+INTERVAL '1 day' WHERE id=$1 AND grant_id=$2 AND account_id=$3`, effect.ID, effect.GrantID, effect.AccountID); err != nil {
			return nil, err
		}
	}
	for _, effect := range effects {
		if _, err := tx.Exec(ctx, `UPDATE offline_v3_event_outbox SET attempts=attempts+1,next_attempt_at=NOW()+INTERVAL '2 minutes' WHERE id=$1 AND grant_id=$2 AND account_id=$3`, effect.ID, effect.GrantID, effect.AccountID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return effects, nil
}

func (r *OfflineV3Repository) FinishTaskEffect(ctx context.Context, effect OfflineV3TaskEffect, success bool) error {
	if success {
		_, err := r.db.Exec(ctx, `UPDATE offline_v3_event_outbox SET processed_at=NOW(),last_error_code=NULL WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND operation_id=$4`, effect.ID, effect.GrantID, effect.AccountID, effect.OperationID)
		return err
	}
	_, err := r.db.Exec(ctx, `UPDATE offline_v3_event_outbox SET last_error_code='task_effect_retry',next_attempt_at=NOW()+make_interval(secs=>LEAST(300,5*(1<<LEAST(attempts,6)))) WHERE id=$1 AND grant_id=$2 AND account_id=$3 AND operation_id=$4 AND processed_at IS NULL`, effect.ID, effect.GrantID, effect.AccountID, effect.OperationID)
	return err
}
