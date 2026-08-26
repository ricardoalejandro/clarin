package api

import (
	"context"
	"errors"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

// hydrateAccountScopedClaims replaces every account-authority value embedded
// in a token with current database truth. In particular it never reads the
// legacy users.is_admin mirror, which describes only the default account and
// would otherwise leak administrator authority after switching accounts.
func (s *Server) hydrateAccountScopedClaims(ctx context.Context, claims *service.JWTClaims) error {
	if claims == nil || claims.UserID == uuid.Nil || claims.AccountID == uuid.Nil {
		return pgx.ErrNoRows
	}
	var active, globalSuperAdmin bool
	var role string
	var permissions []string
	err := s.repos.DB().QueryRow(ctx, `
		SELECT account_user.is_active,COALESCE(account_user.is_super_admin,FALSE),
			membership.role,COALESCE(role_item.permissions,'{}'::text[])
		FROM users account_user
		JOIN user_accounts membership ON membership.user_id=account_user.id AND membership.account_id=$2
		LEFT JOIN roles role_item ON role_item.id=membership.role_id
		WHERE account_user.id=$1
	`, claims.UserID, claims.AccountID).Scan(&active, &globalSuperAdmin, &role, &permissions)
	if err != nil {
		return err
	}
	if !active {
		return pgx.ErrNoRows
	}
	claims.Role = role
	claims.IsSuperAdmin = globalSuperAdmin
	claims.IsAdmin = domain.HasAccountAdminAuthority(role, globalSuperAdmin)
	if claims.IsAdmin {
		claims.Permissions = []string{domain.PermAll}
	} else {
		claims.Permissions = append([]string(nil), permissions...)
	}
	return nil
}

func writeAccountAuthorityFailure(c *fiber.Ctx, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return c.Status(fiber.StatusUnauthorized).JSON(fiber.Map{
			"success": false, "error": "Account access revoked",
		})
	}
	return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{
		"success": false, "error": "Authentication is temporarily unavailable", "code": "authorization_unavailable",
	})
}

// isAccountAdmin is shared authorization logic for account-scoped resources.
// Keep it independent from any product module so retiring one feature cannot
// silently remove access checks required by other handlers.
func (s *Server) isAccountAdmin(c *fiber.Ctx, accountID, userID uuid.UUID) bool {
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok {
		if claims.IsSuperAdmin || (claims.AccountID == accountID && domain.HasAccountAdminAuthority(claims.Role, false)) {
			return true
		}
	}
	var role string
	err := s.repos.DB().QueryRow(c.Context(), `SELECT role FROM user_accounts WHERE user_id=$1 AND account_id=$2`, userID, accountID).Scan(&role)
	return err == nil && (role == domain.RoleAdmin || role == domain.RoleSuperAdmin)
}
