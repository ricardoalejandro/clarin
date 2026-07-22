package service

import (
	"context"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

// ContactProfileService is the shared identity boundary used by Contact,
// Lead, Chat, Event and Program surfaces. Context authorization remains in the
// HTTP layer and every repository operation repeats account scoping.
type ContactProfileService struct {
	repos *repository.Repositories
}

func NewContactProfileService(repos *repository.Repositories) *ContactProfileService {
	return &ContactProfileService{repos: repos}
}

func (s *ContactProfileService) Get(ctx context.Context, accountID, contactID uuid.UUID) (*domain.Contact, error) {
	return s.repos.ContactProfile.Get(ctx, accountID, contactID)
}

func (s *ContactProfileService) Update(ctx context.Context, accountID, contactID uuid.UUID, patch repository.ContactProfilePatch) (*domain.Contact, error) {
	return s.repos.ContactProfile.Update(ctx, accountID, contactID, patch)
}

func (s *ContactProfileService) ListObservations(ctx context.Context, accountID, contactID uuid.UUID, limit, offset int) ([]*domain.Interaction, error) {
	return s.repos.ContactProfile.ListObservations(ctx, accountID, contactID, limit, offset)
}

func (s *ContactProfileService) CountObservations(ctx context.Context, accountID, contactID uuid.UUID) (int, error) {
	return s.repos.ContactProfile.CountObservations(ctx, accountID, contactID)
}

func (s *ContactProfileService) CreateObservation(ctx context.Context, accountID, userID, contactID uuid.UUID, contextType string, contextID uuid.UUID, notes string) (*domain.Interaction, error) {
	return s.repos.ContactProfile.CreateObservation(ctx, accountID, userID, contactID, contextType, contextID, notes)
}

func (s *ContactProfileService) DeleteObservation(ctx context.Context, accountID, contactID, observationID uuid.UUID) error {
	return s.repos.ContactProfile.DeleteObservation(ctx, accountID, contactID, observationID)
}
