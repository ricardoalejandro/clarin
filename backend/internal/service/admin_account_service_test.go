package service

import (
	"context"
	"errors"
	"testing"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestAdminAccountUpdateRejectsExplicitBlankSubscriptionStatus(t *testing.T) {
	t.Parallel()

	service := &AccountService{}
	account := &domain.Account{
		Name:               "Cuenta",
		Plan:               "basic",
		SubscriptionStatus: "   ",
	}
	err := service.UpdateWithSubscription(context.Background(), account, repository.AdminAccountUpdateMask{
		SubscriptionStatus: true,
	})
	if !errors.Is(err, ErrSubscriptionStatusInvalid) {
		t.Fatalf("error = %v, want ErrSubscriptionStatusInvalid", err)
	}
}

func TestAdminAccountUpdateRejectsExplicitBlankPlan(t *testing.T) {
	t.Parallel()

	service := &AccountService{}
	account := &domain.Account{
		Name:               "Cuenta",
		Plan:               "   ",
		SubscriptionStatus: domain.SubscriptionStatusActive,
	}
	err := service.UpdateWithSubscription(context.Background(), account, repository.AdminAccountUpdateMask{
		Plan: true,
	})
	if !errors.Is(err, ErrSubscriptionPlanInvalid) {
		t.Fatalf("error = %v, want ErrSubscriptionPlanInvalid", err)
	}
}
