package service

import (
	"context"
	"fmt"

	"golang.org/x/crypto/bcrypt"

	"github.com/naperu/clarin/internal/domain"
)

// CreateUserWithAccounts hashes the credential and delegates the complete
// user/account write to one repository transaction.
func (s *AccountService) CreateUserWithAccounts(ctx context.Context, user *domain.User, password string, assignments []*domain.UserAccount) error {
	if err := ValidateStrongPassword(password); err != nil {
		return err
	}
	hashedPassword, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}
	user.PasswordHash = string(hashedPassword)
	return s.repos.User.CreateWithAccounts(ctx, user, assignments)
}
