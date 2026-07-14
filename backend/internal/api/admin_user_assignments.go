package api

import (
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

type adminUserAccountAssignmentRequest struct {
	AccountID string  `json:"account_id"`
	Role      string  `json:"role"`
	RoleID    *string `json:"role_id"`
	IsDefault bool    `json:"is_default"`
}

// buildAdminUserAccountAssignments validates the whole request before any
// write and normalizes it to one—and only one—default account.
func buildAdminUserAccountAssignments(requests []adminUserAccountAssignmentRequest) ([]*domain.UserAccount, int, error) {
	if len(requests) == 0 {
		return nil, -1, fmt.Errorf("asigna al usuario al menos a una cuenta")
	}

	defaultIndex := 0
	for index, request := range requests {
		if request.IsDefault {
			defaultIndex = index
			break
		}
	}

	assignments := make([]*domain.UserAccount, 0, len(requests))
	seenAccounts := make(map[uuid.UUID]struct{}, len(requests))
	for index, request := range requests {
		accountID, err := uuid.Parse(strings.TrimSpace(request.AccountID))
		if err != nil {
			return nil, -1, fmt.Errorf("una de las cuentas seleccionadas no es válida")
		}
		if _, duplicate := seenAccounts[accountID]; duplicate {
			return nil, -1, fmt.Errorf("una cuenta no puede asignarse dos veces")
		}
		seenAccounts[accountID] = struct{}{}

		role := strings.TrimSpace(request.Role)
		if role == "" {
			role = domain.RoleAgent
		}
		if role != domain.RoleAgent && role != domain.RoleAdmin && role != domain.RoleSuperAdmin {
			return nil, -1, fmt.Errorf("uno de los roles seleccionados no es válido")
		}

		var roleID *uuid.UUID
		if request.RoleID != nil && strings.TrimSpace(*request.RoleID) != "" {
			if role != domain.RoleAgent {
				return nil, -1, fmt.Errorf("los roles personalizados solo pueden combinarse con el rol Agente")
			}
			parsedRoleID, err := uuid.Parse(strings.TrimSpace(*request.RoleID))
			if err != nil {
				return nil, -1, fmt.Errorf("uno de los roles personalizados no es válido")
			}
			roleID = &parsedRoleID
		}

		assignments = append(assignments, &domain.UserAccount{
			AccountID: accountID,
			Role:      role,
			RoleID:    roleID,
			IsDefault: index == defaultIndex,
		})
	}

	return assignments, defaultIndex, nil
}
