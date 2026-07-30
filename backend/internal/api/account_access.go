package api

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/service"
)

// isAccountAdmin is shared authorization logic for account-scoped resources.
// Keep it independent from any product module so retiring one feature cannot
// silently remove access checks required by other handlers.
func (s *Server) isAccountAdmin(c *fiber.Ctx, accountID, userID uuid.UUID) bool {
	if claims, ok := c.Locals("claims").(*service.JWTClaims); ok {
		if claims.IsAdmin || claims.IsSuperAdmin || claims.Role == domain.RoleAdmin || claims.Role == domain.RoleSuperAdmin {
			return true
		}
	}
	var role string
	err := s.repos.DB().QueryRow(c.Context(), `SELECT role FROM user_accounts WHERE user_id=$1 AND account_id=$2`, userID, accountID).Scan(&role)
	return err == nil && (role == domain.RoleAdmin || role == domain.RoleSuperAdmin)
}
