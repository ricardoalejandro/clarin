package service

import (
	"context"
	"time"

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

func (s *ContactProfileService) ListObservations(ctx context.Context, accountID, contactID, userID uuid.UUID, isAdmin bool, limit, offset int) ([]*domain.Interaction, error) {
	return s.repos.ContactProfile.ListObservations(ctx, accountID, contactID, userID, isAdmin, limit, offset)
}
func (s *ContactProfileService) CountPinnedObservations(ctx context.Context, accountID, contactID uuid.UUID) (int, error) {
	return s.repos.ContactProfile.CountPinnedObservations(ctx, accountID, contactID)
}

func (s *ContactProfileService) CountObservations(ctx context.Context, accountID, contactID uuid.UUID) (int, error) {
	return s.repos.ContactProfile.CountObservations(ctx, accountID, contactID)
}

func (s *ContactProfileService) CreateObservation(ctx context.Context, accountID, userID, contactID uuid.UUID, contextType string, contextID uuid.UUID, notes string) (*domain.Interaction, error) {
	return s.repos.ContactProfile.CreateObservation(ctx, accountID, userID, contactID, contextType, contextID, notes)
}

func (s *ContactProfileService) UpdateObservation(ctx context.Context, accountID, contactID, observationID, userID uuid.UUID, isAdmin bool, notes string, expected time.Time) (*domain.Interaction, error) {
	return s.repos.ContactProfile.UpdateObservation(ctx, accountID, contactID, observationID, userID, isAdmin, notes, expected)
}
func (s *ContactProfileService) PinObservation(ctx context.Context, accountID, contactID, observationID, userID uuid.UUID, isAdmin, pinned bool) (*domain.Interaction, error) {
	return s.repos.ContactProfile.PinObservation(ctx, accountID, contactID, observationID, userID, isAdmin, pinned)
}
func (s *ContactProfileService) DeleteObservation(ctx context.Context, accountID, contactID, observationID, userID uuid.UUID, isAdmin bool) error {
	return s.repos.ContactProfile.DeleteObservation(ctx, accountID, contactID, observationID, userID, isAdmin)
}
