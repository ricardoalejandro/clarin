package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
)

type AdminAccountUpdateMask struct {
	Name               bool
	Slug               bool
	Plan               bool
	MaxDevices         bool
	MaxUsersOverride   bool
	StorageLimitBytes  bool
	KommoEnabled       bool
	SubscriptionStatus bool
	TrialEndsAt        bool
	CurrentPeriodEnd   bool
}

// CreateWithSubscription persists the account and its canonical subscription
// in one transaction. No caller can observe an account without a subscription
// when the subscription insert fails.
func (r *AccountRepository) CreateWithSubscription(ctx context.Context, account *domain.Account) error {
	if account == nil {
		return fmt.Errorf("account is required")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := tx.QueryRow(ctx, `
		INSERT INTO accounts (
			name, slug, plan, max_devices, max_users_override, storage_limit_bytes, is_active, kommo_enabled
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
		RETURNING id,created_at,updated_at
	`, account.Name, account.Slug, account.Plan, account.MaxDevices, account.MaxUsersOverride,
		account.StorageLimitBytes, account.IsActive, account.KommoEnabled).Scan(
		&account.ID, &account.CreatedAt, &account.UpdatedAt,
	); err != nil {
		return err
	}
	if err := upsertAdminAccountSubscriptionTx(ctx, tx, account); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// UpdateWithSubscription updates only account fields managed by the admin
// form and the subscription fields exposed by that form. Provider identifiers,
// billing metadata and all other subscription state remain untouched.
func (r *AccountRepository) UpdateWithSubscription(ctx context.Context, account *domain.Account, mask AdminAccountUpdateMask) error {
	if account == nil || account.ID == uuid.Nil {
		return fmt.Errorf("account is required")
	}
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	current := &domain.Account{}
	if err := tx.QueryRow(ctx, `
		SELECT id,name,COALESCE(slug,''),COALESCE(plan,'basic'),max_devices,max_users_override,
			COALESCE(storage_limit_bytes,0),COALESCE(kommo_enabled,FALSE)
		FROM accounts WHERE id=$1 FOR UPDATE
	`, account.ID).Scan(&current.ID, &current.Name, &current.Slug, &current.Plan, &current.MaxDevices,
		&current.MaxUsersOverride, &current.StorageLimitBytes, &current.KommoEnabled); err != nil {
		return err
	}
	if !mask.Name {
		account.Name = current.Name
	}
	if !mask.Slug {
		account.Slug = current.Slug
	}
	if !mask.MaxDevices {
		account.MaxDevices = current.MaxDevices
	}
	if !mask.MaxUsersOverride {
		account.MaxUsersOverride = current.MaxUsersOverride
	}
	if !mask.StorageLimitBytes {
		account.StorageLimitBytes = current.StorageLimitBytes
	}
	if !mask.KommoEnabled {
		account.KommoEnabled = current.KommoEnabled
	}

	// subscriptions.plan_code is canonical while accounts.plan is only its
	// compatibility mirror. Preserve the locked subscription value for partial
	// updates and use the account mirror only when no subscription exists yet.
	currentPlan := current.Plan
	currentStatus := domain.SubscriptionStatusActive
	var currentTrialEnd, currentPeriodEnd *time.Time
	if err := tx.QueryRow(ctx, `
			SELECT plan_code,status,trial_ends_at,current_period_end
			FROM subscriptions WHERE account_id=$1 FOR UPDATE
		`, account.ID).Scan(&currentPlan, &currentStatus, &currentTrialEnd, &currentPeriodEnd); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if !mask.Plan {
		account.Plan = currentPlan
	}
	if !mask.SubscriptionStatus {
		account.SubscriptionStatus = currentStatus
	}
	if !mask.TrialEndsAt {
		account.TrialEndsAt = currentTrialEnd
	}
	if !mask.CurrentPeriodEnd {
		account.CurrentPeriodEnd = currentPeriodEnd
	}
	result, err := tx.Exec(ctx, `
		UPDATE accounts SET
			name=$2,slug=$3,plan=$4,max_devices=$5,max_users_override=$6,
			storage_limit_bytes=$7,kommo_enabled=$8,updated_at=NOW()
		WHERE id=$1
	`, account.ID, account.Name, account.Slug, account.Plan, account.MaxDevices,
		account.MaxUsersOverride, account.StorageLimitBytes, account.KommoEnabled)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	if err := upsertAdminAccountSubscriptionTx(ctx, tx, account); err != nil {
		return err
	}
	if err := bumpAllWhiteboardAccessRevisionTx(ctx, tx, account.ID); err != nil {
		return err
	}
	if err := tx.QueryRow(ctx, `SELECT updated_at FROM accounts WHERE id=$1`, account.ID).Scan(&account.UpdatedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func upsertAdminAccountSubscriptionTx(ctx context.Context, tx pgx.Tx, account *domain.Account) error {
	status := account.SubscriptionStatus
	if status == "" {
		status = domain.SubscriptionStatusActive
	}
	_, err := tx.Exec(ctx, `
		INSERT INTO subscriptions (
			account_id,plan_code,status,trial_ends_at,current_period_start,current_period_end,
			canceled_at,suspended_at,metadata
		) VALUES (
			$1,$2,$3::text,$4,NOW(),$5,
			CASE WHEN $3::text='canceled' THEN NOW() ELSE NULL END,
			CASE WHEN $3::text='suspended' THEN NOW() ELSE NULL END,
			'{"source":"admin_account_write"}'::jsonb
		)
		ON CONFLICT (account_id) DO UPDATE SET
			plan_code=EXCLUDED.plan_code,
			status=EXCLUDED.status,
			trial_ends_at=EXCLUDED.trial_ends_at,
			current_period_end=EXCLUDED.current_period_end,
			canceled_at=CASE
				WHEN EXCLUDED.status='canceled' THEN COALESCE(subscriptions.canceled_at,NOW())
				WHEN EXCLUDED.status IN ('active','trialing','grace') THEN NULL
				ELSE subscriptions.canceled_at
			END,
			suspended_at=CASE
				WHEN EXCLUDED.status='suspended' THEN COALESCE(subscriptions.suspended_at,NOW())
				WHEN EXCLUDED.status IN ('active','trialing','grace') THEN NULL
				ELSE subscriptions.suspended_at
			END,
			updated_at=NOW()
	`, account.ID, account.Plan, status, account.TrialEndsAt, account.CurrentPeriodEnd)
	return err
}
