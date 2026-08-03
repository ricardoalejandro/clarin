package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// TaskAccessService is the application boundary for Clarin Work ACL. Keeping
// handlers on this service makes it harder for a new route to accidentally
// infer access from account role or visibility alone.
type TaskAccessService struct {
	repos *repository.Repositories
}

func NewTaskAccessService(repos *repository.Repositories) *TaskAccessService {
	return &TaskAccessService{repos: repos}
}

func (s *TaskAccessService) Environment(ctx context.Context, accountID, userID, environmentID uuid.UUID) (*domain.TaskEffectiveAccess, error) {
	return s.repos.TaskWork.ResolveEnvironmentAccess(ctx, accountID, userID, environmentID)
}

func (s *TaskAccessService) Task(ctx context.Context, accountID, userID, taskID uuid.UUID) (*domain.TaskEffectiveAccess, error) {
	return s.repos.TaskWork.ResolveTaskAccess(ctx, accountID, userID, taskID)
}

func (s *TaskAccessService) RequireEnvironment(ctx context.Context, accountID, userID, environmentID uuid.UUID, level string) (*domain.TaskEffectiveAccess, error) {
	return s.repos.TaskWork.RequireEnvironmentAccess(ctx, accountID, userID, environmentID, level)
}

func (s *TaskAccessService) RequireTask(ctx context.Context, accountID, userID, taskID uuid.UUID, level string) (*domain.TaskEffectiveAccess, error) {
	return s.repos.TaskWork.RequireTaskAccess(ctx, accountID, userID, taskID, level)
}

func (s *TaskAccessService) TaskViewers(ctx context.Context, accountID, taskID uuid.UUID) ([]uuid.UUID, error) {
	return s.repos.TaskWork.TaskViewerUserIDs(ctx, accountID, taskID)
}
