package repository

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// CreateWithAccounts persists the login and every account assignment as one
// unit. A role/account constraint failure must never leave an orphaned user
// that then appears as a misleading duplicate on retry.
func (r *UserRepository) CreateWithAccounts(ctx context.Context, user *domain.User, assignments []*domain.UserAccount) error {
	if user == nil {
		return fmt.Errorf("user is required")
	}
	if len(assignments) == 0 {
		return fmt.Errorf("at least one account assignment is required")
	}

	seenAccounts := make(map[uuid.UUID]struct{}, len(assignments))
	defaultCount := 0
	for _, assignment := range assignments {
		if assignment == nil || assignment.AccountID == uuid.Nil {
			return fmt.Errorf("invalid account assignment")
		}
		if _, duplicate := seenAccounts[assignment.AccountID]; duplicate {
			return fmt.Errorf("duplicate account assignment")
		}
		seenAccounts[assignment.AccountID] = struct{}{}
		if assignment.IsDefault {
			defaultCount++
		}
	}
	if defaultCount != 1 {
		return fmt.Errorf("exactly one default account is required")
	}

	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if err := tx.QueryRow(ctx, `
		INSERT INTO users (account_id, username, email, password_hash, display_name, is_admin, is_super_admin, role)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING id, is_active, created_at, updated_at
	`, user.AccountID, user.Username, user.Email, user.PasswordHash, user.DisplayName, user.IsAdmin, user.IsSuperAdmin, user.Role).Scan(
		&user.ID, &user.IsActive, &user.CreatedAt, &user.UpdatedAt,
	); err != nil {
		return err
	}

	for _, assignment := range assignments {
		assignment.UserID = user.ID
		if err := tx.QueryRow(ctx, `
			INSERT INTO user_accounts (user_id, account_id, role, role_id, is_default)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, created_at
		`, assignment.UserID, assignment.AccountID, assignment.Role, assignment.RoleID, assignment.IsDefault).Scan(
			&assignment.ID, &assignment.CreatedAt,
		); err != nil {
			return err
		}
	}

	return tx.Commit(ctx)
}
