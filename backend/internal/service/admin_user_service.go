package service

import (
	"context"
	"fmt"

	"golang.org/x/crypto/bcrypt"

	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// CreateUserWithAccounts hashes the credential and delegates the complete
// user/account write to one repository transaction.
func (s *AccountService) CreateUserWithAccountsAndAuthorityImpact(ctx context.Context, user *domain.User, password string, assignments []*domain.UserAccount) (*repository.WhiteboardAuthorityMutationEffect, error) {
	if err := ValidateStrongPassword(password); err != nil {
		return nil, err
	}
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}
	user.PasswordHash = string(hashedPassword)
	return s.repos.User.CreateWithAccountsAndAuthorityImpact(ctx, user, assignments)
}
