package repository

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

var ErrTaskOperationPayloadConflict = errors.New("task operation payload conflict")

// Receipts survive task purge; replay must never recreate a deleted result.
// The insert and task mutation share one transaction, including rollback on
// permission/validation errors and serialization of concurrent retries.
func (r *TaskRepository) claimTaskCreateReceiptTx(ctx context.Context, tx pgx.Tx, task *domain.Task) (bool, error) {
	if task.CreatePayloadHash == "" || task.MutationOperationID == nil {
		return false, nil
	}
	ensureTaskCreateID(task)
	actor := task.CreatedBy
	if task.MutationActor != nil {
		actor = *task.MutationActor
	}
	command, err := tx.Exec(ctx, `INSERT INTO task_create_receipts(account_id,actor_id,operation_id,payload_hash,task_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, task.AccountID, actor, *task.MutationOperationID, task.CreatePayloadHash, task.ID)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() == 1 {
		return false, nil
	}
	var hash string
	var id uuid.UUID
	if err := tx.QueryRow(ctx, `SELECT payload_hash,task_id FROM task_create_receipts WHERE account_id=$1 AND actor_id=$2 AND operation_id=$3 FOR UPDATE`, task.AccountID, actor, *task.MutationOperationID).Scan(&hash, &id); err != nil {
		return false, err
	}
	if hash != task.CreatePayloadHash {
		return false, ErrTaskOperationPayloadConflict
	}
	access, err := resolveTaskAccessWith(ctx, tx, task.AccountID, actor, id)
	if err != nil {
		return false, err
	}
	if access.Access == nil || !access.Access.CanView {
		return false, ErrTaskWorkNotFound
	}
	canonical, err := r.scanTask(tx.QueryRow(ctx, `SELECT `+taskSelectFields+` FROM tasks t `+taskJoins+` WHERE t.account_id=$1 AND t.id=$2 AND t.deleted_at IS NULL`, task.AccountID, id))
	if err != nil {
		return false, err
	}
	*task = *canonical
	task.CreateReplayed = true
	return true, nil
}
