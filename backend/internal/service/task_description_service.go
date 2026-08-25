package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func taskDescriptionUpdatedEventPayload(taskID uuid.UUID, state *repository.TaskDescriptionState, operationID uuid.UUID) map[string]interface{} {
	payload := map[string]interface{}{
		"action":       "description_updated",
		"task_id":      taskID.String(),
		"description":  state.Description,
		"version":      state.Version,
		"updated_at":   state.UpdatedAt,
		"operation_id": operationID.String(),
	}
	return payload
}

// UpdateDescription keeps autosave writes narrow. Once the repository returns
// successfully, its state is the committed canonical description state; this
// method deliberately performs no fallible hydration or realtime publication.
func (s *TaskService) UpdateDescription(
	ctx context.Context,
	accountID, actorID, taskID uuid.UUID,
	description string,
	expectedVersion int64,
	operationID uuid.UUID,
) (*repository.TaskDescriptionState, error) {
	state, err := s.repos.TaskWork.UpdateTaskDescription(ctx, accountID, actorID, taskID, description, expectedVersion, operationID)
	return state, err
}

// PublishDescriptionUpdated emits only the narrow canonical description state
// to the task's final authorized viewer set. Callers publish after invalidating
// collection caches so an event-driven reload cannot recover stale content.
func (s *TaskService) PublishDescriptionUpdated(
	ctx context.Context,
	accountID, taskID uuid.UUID,
	state *repository.TaskDescriptionState,
	operationID uuid.UUID,
) {
	if state == nil || !state.Changed || s.hub == nil {
		return
	}
	s.broadcastTaskACL(ctx, accountID, taskID, nil, taskDescriptionUpdatedEventPayload(taskID, state, operationID))
}
