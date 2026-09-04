package service

import (
	"context"
	"errors"
	"strings"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

var ErrAdminAccountNameRequired = errors.New("account name is required")

func (s *AccountService) validateAdminAccount(ctx context.Context, account *domain.Account) error {
	if account == nil {
		return ErrAdminAccountNameRequired
	}
	account.Name = strings.TrimSpace(account.Name)
	if account.Name == "" {
		return ErrAdminAccountNameRequired
	}
	account.Slug = strings.TrimSpace(account.Slug)
	account.Plan = strings.TrimSpace(account.Plan)
	if account.Plan == "" {
		account.Plan = "basic"
	}
	plan, err := s.repos.Subscription.GetPlan(ctx, account.Plan)
	if err != nil {
		return err
	}
	if plan == nil {
		return ErrSubscriptionPlanInvalid
	}
	account.SubscriptionStatus = strings.TrimSpace(account.SubscriptionStatus)
	if account.SubscriptionStatus == "" {
		account.SubscriptionStatus = domain.SubscriptionStatusActive
	}
	if !validSubscriptionStatus(account.SubscriptionStatus) {
		return ErrSubscriptionStatusInvalid
	}
	return nil
}

func (s *AccountService) CreateWithSubscription(ctx context.Context, account *domain.Account) error {
	if err := s.validateAdminAccount(ctx, account); err != nil {
		return err
	}
	return s.repos.Account.CreateWithSubscription(ctx, account)
}

func (s *AccountService) UpdateWithSubscription(ctx context.Context, account *domain.Account, mask repository.AdminAccountUpdateMask) error {
	// Creating without a plan defaults to basic, but an explicitly blank plan
	// during an update must not silently downgrade the account.
	if mask.Plan && account != nil && strings.TrimSpace(account.Plan) == "" {
		return ErrSubscriptionPlanInvalid
	}
	// Omission preserves the locked current status in the repository. An
	// explicitly supplied blank value is different: accepting it as the default
	// would silently reactivate canceled or suspended accounts.
	if mask.SubscriptionStatus && account != nil && strings.TrimSpace(account.SubscriptionStatus) == "" {
		return ErrSubscriptionStatusInvalid
	}
	if err := s.validateAdminAccount(ctx, account); err != nil {
		return err
	}
	return s.repos.Account.UpdateWithSubscription(ctx, account, mask)
}
