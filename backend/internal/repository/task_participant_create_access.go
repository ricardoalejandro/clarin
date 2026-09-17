package repository

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

// A new inherited root task takes its effective access from its actual list,
// not the Entorno default alone. Entorno Ver plus an explicit list Editar is
// sufficient; participation must not create a redundant root-task grant.
func taskCreateParticipantsNeedingGrant(ctx context.Context, q taskAccessQuerier, accountID, environmentID uuid.UUID, listID, rootTaskID *uuid.UUID, participantIDs []uuid.UUID) ([]uuid.UUID, error) {
	if rootTaskID != nil || listID == nil {
		return taskParticipantsNeedingGrant(ctx, q, accountID, environmentID, rootTaskID, participantIDs)
	}
	affected := make([]uuid.UUID, 0)
	for _, participantID := range participantIDs {
		access, _, err := resolveContainerAccessWith(ctx, q, accountID, participantID, *listID, domain.TaskAccessTargetList)
		if err != nil {
			return nil, err
		}
		if !TaskAccessAllows(access, domain.TaskAccessEdit) {
			affected = append(affected, participantID)
		}
	}
	return affected, nil
}
