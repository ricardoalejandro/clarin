package repository

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type erosPublicationPolicyKey struct{}
type erosPublicationPolicy struct {
	Version  int64
	Required bool
}

// Mixed results begun with Leads disabled still publish independent data, but
// only under the same configuration that produced their snapshot.
func WithErosPublicationPolicy(ctx context.Context, version int64, required bool) context.Context {
	return context.WithValue(ctx, erosPublicationPolicyKey{}, erosPublicationPolicy{version, required})
}

func validateErosPublicationPolicy(policy domain.LeadPolicy, version int64, required bool) error {
	if policy.Version != version {
		return ErrLeadPolicyConflict
	}
	if required && !policy.LeadsEnabled {
		return ErrLeadsDisabled
	}
	return nil
}

func requireErosPublicationTx(ctx context.Context, tx pgx.Tx, accountID uuid.UUID) error {
	stamp, ok := ctx.Value(erosPublicationPolicyKey{}).(erosPublicationPolicy)
	if !ok {
		return nil
	}
	policy, err := readLeadPolicy(ctx, tx, accountID, true)
	if err != nil {
		return err
	}
	return validateErosPublicationPolicy(*policy, stamp.Version, stamp.Required)
}

func (r *AccountRepository) AcquireErosPublication(ctx context.Context, accountID uuid.UUID, version int64, required bool) (func(), error) {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	if err = requireErosPublicationTx(WithErosPublicationPolicy(ctx, version, required), tx, accountID); err != nil {
		_ = tx.Rollback(context.Background())
		return nil, err
	}
	return func() { _ = tx.Rollback(context.Background()) }, nil
}

// Save the source policy before requesting a durable model turn. Recovery must
// never relabel an older provider response with the currently enabled version.
func (r *ErosRunRepository) SaveLeadPolicySnapshot(ctx context.Context, run *domain.ErosRun, snapshot json.RawMessage) error {
	var parameters []byte
	err := r.db.QueryRow(ctx, `UPDATE eros_runs SET parameters=parameters || $4::jsonb,updated_at=NOW()
		WHERE id=$1 AND account_id=$2 AND user_id=$3 AND status='running' AND NOT cancel_requested
		RETURNING parameters`, run.ID, run.AccountID, run.UserID, snapshot).Scan(&parameters)
	if err == nil {
		run.Parameters = parameters
	}
	return err
}
