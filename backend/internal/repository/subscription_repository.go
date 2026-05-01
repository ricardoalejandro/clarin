package repository

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/naperu/clarin/internal/domain"
)

// SubscriptionRepository handles SaaS plans and account subscription state.
type SubscriptionRepository struct {
	db *pgxpool.Pool
}

func (r *SubscriptionRepository) ListPlans(ctx context.Context, includePrivate bool) ([]*domain.Plan, error) {
	query := `
		SELECT p.code, p.name, p.description, p.trial_days, p.is_public, p.sort_order, p.created_at, p.updated_at,
			COALESCE(jsonb_object_agg(pe.key, pe.value_json) FILTER (WHERE pe.key IS NOT NULL), '{}'::jsonb) AS entitlements
		FROM plans p
		LEFT JOIN plan_entitlements pe ON pe.plan_code = p.code
		WHERE ($1 OR p.is_public = TRUE)
		GROUP BY p.code
		ORDER BY p.sort_order, p.code
	`
	rows, err := r.db.Query(ctx, query, includePrivate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	plans := make([]*domain.Plan, 0)
	for rows.Next() {
		plan := &domain.Plan{}
		var entitlements []byte
		if err := rows.Scan(&plan.Code, &plan.Name, &plan.Description, &plan.TrialDays, &plan.IsPublic, &plan.SortOrder, &plan.CreatedAt, &plan.UpdatedAt, &entitlements); err != nil {
			return nil, err
		}
		plan.Entitlements = map[string]json.RawMessage{}
		if len(entitlements) > 0 {
			_ = json.Unmarshal(entitlements, &plan.Entitlements)
		}
		plans = append(plans, plan)
	}
	return plans, rows.Err()
}

func (r *SubscriptionRepository) GetPlan(ctx context.Context, code string) (*domain.Plan, error) {
	plan := &domain.Plan{}
	var entitlements []byte
	err := r.db.QueryRow(ctx, `
		SELECT p.code, p.name, p.description, p.trial_days, p.is_public, p.sort_order, p.created_at, p.updated_at,
			COALESCE(jsonb_object_agg(pe.key, pe.value_json) FILTER (WHERE pe.key IS NOT NULL), '{}'::jsonb) AS entitlements
		FROM plans p
		LEFT JOIN plan_entitlements pe ON pe.plan_code = p.code
		WHERE p.code = $1
		GROUP BY p.code
	`, code).Scan(&plan.Code, &plan.Name, &plan.Description, &plan.TrialDays, &plan.IsPublic, &plan.SortOrder, &plan.CreatedAt, &plan.UpdatedAt, &entitlements)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	plan.Entitlements = map[string]json.RawMessage{}
	if len(entitlements) > 0 {
		_ = json.Unmarshal(entitlements, &plan.Entitlements)
	}
	return plan, nil
}

func (r *SubscriptionRepository) GetByAccountID(ctx context.Context, accountID uuid.UUID) (*domain.Subscription, error) {
	sub := &domain.Subscription{}
	var metadata []byte
	err := r.db.QueryRow(ctx, `
		SELECT id, account_id, plan_code, status, trial_started_at, trial_ends_at, current_period_start, current_period_end,
			grace_ends_at, canceled_at, suspended_at, billing_provider, provider_customer_id, provider_subscription_id,
			metadata, created_at, updated_at
		FROM subscriptions
		WHERE account_id = $1
	`, accountID).Scan(
		&sub.ID, &sub.AccountID, &sub.PlanCode, &sub.Status, &sub.TrialStartedAt, &sub.TrialEndsAt,
		&sub.CurrentPeriodStart, &sub.CurrentPeriodEnd, &sub.GraceEndsAt, &sub.CanceledAt, &sub.SuspendedAt,
		&sub.BillingProvider, &sub.ProviderCustomerID, &sub.ProviderSubscriptionID, &metadata, &sub.CreatedAt, &sub.UpdatedAt,
	)
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(metadata) > 0 {
		sub.Metadata = json.RawMessage(metadata)
	} else {
		sub.Metadata = json.RawMessage(`{}`)
	}
	return sub, nil
}

func (r *SubscriptionRepository) Upsert(ctx context.Context, sub *domain.Subscription) error {
	metadata := string(sub.Metadata)
	if metadata == "" {
		metadata = "{}"
	}
	return r.db.QueryRow(ctx, `
		INSERT INTO subscriptions (
			account_id, plan_code, status, trial_started_at, trial_ends_at, current_period_start, current_period_end,
			grace_ends_at, canceled_at, suspended_at, billing_provider, provider_customer_id, provider_subscription_id, metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
		ON CONFLICT (account_id) DO UPDATE SET
			plan_code = EXCLUDED.plan_code,
			status = EXCLUDED.status,
			trial_started_at = EXCLUDED.trial_started_at,
			trial_ends_at = EXCLUDED.trial_ends_at,
			current_period_start = EXCLUDED.current_period_start,
			current_period_end = EXCLUDED.current_period_end,
			grace_ends_at = EXCLUDED.grace_ends_at,
			canceled_at = EXCLUDED.canceled_at,
			suspended_at = EXCLUDED.suspended_at,
			billing_provider = EXCLUDED.billing_provider,
			provider_customer_id = EXCLUDED.provider_customer_id,
			provider_subscription_id = EXCLUDED.provider_subscription_id,
			metadata = EXCLUDED.metadata,
			updated_at = NOW()
		RETURNING id, created_at, updated_at
	`, sub.AccountID, sub.PlanCode, sub.Status, sub.TrialStartedAt, sub.TrialEndsAt, sub.CurrentPeriodStart, sub.CurrentPeriodEnd,
		sub.GraceEndsAt, sub.CanceledAt, sub.SuspendedAt, sub.BillingProvider, sub.ProviderCustomerID, sub.ProviderSubscriptionID, metadata).Scan(
		&sub.ID, &sub.CreatedAt, &sub.UpdatedAt,
	)
}

func (r *SubscriptionRepository) SetAccountPlan(ctx context.Context, accountID uuid.UUID, planCode string) error {
	_, err := r.db.Exec(ctx, `UPDATE accounts SET plan = $2, updated_at = NOW() WHERE id = $1`, accountID, planCode)
	return err
}

func (r *SubscriptionRepository) GetUsage(ctx context.Context, accountID uuid.UUID) (domain.SubscriptionUsage, error) {
	usage := domain.SubscriptionUsage{}
	err := r.db.QueryRow(ctx, `
		SELECT
			(SELECT COUNT(*) FROM user_accounts WHERE account_id = $1),
			(SELECT COUNT(*) FROM devices WHERE account_id = $1),
			(SELECT COUNT(*) FROM contacts WHERE account_id = $1),
			(SELECT COUNT(*) FROM leads WHERE account_id = $1),
			(SELECT COUNT(*) FROM chats WHERE account_id = $1)
	`, accountID).Scan(&usage.Users, &usage.Devices, &usage.Contacts, &usage.Leads, &usage.Chats)
	return usage, err
}
