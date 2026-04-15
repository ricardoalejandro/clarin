package service

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type DocumentTemplateService struct {
	repo *repository.Repositories
}

func NewDocumentTemplateService(repo *repository.Repositories) *DocumentTemplateService {
	return &DocumentTemplateService{repo: repo}
}

func (s *DocumentTemplateService) Create(ctx context.Context, t *domain.DocumentTemplate) error {
	if t.Name == "" {
		return errors.New("template name is required")
	}
	if t.PageWidth <= 0 {
		t.PageWidth = 210 // A4 default
	}
	if t.PageHeight <= 0 {
		t.PageHeight = 297 // A4 default
	}
	if t.PageOrientation == "" {
		t.PageOrientation = "portrait"
	}
	if t.CanvasJSON == nil {
		t.CanvasJSON = []byte("{}")
	}
	if t.FieldsUsed == nil {
		t.FieldsUsed = []string{}
	}
	return s.repo.DocumentTemplate.Create(ctx, t)
}

func (s *DocumentTemplateService) GetByID(ctx context.Context, id, accountID uuid.UUID) (*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.GetByID(ctx, id, accountID)
}

func (s *DocumentTemplateService) List(ctx context.Context, accountID uuid.UUID) ([]*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.List(ctx, accountID)
}

func (s *DocumentTemplateService) Update(ctx context.Context, t *domain.DocumentTemplate) error {
	if t.Name == "" {
		return errors.New("template name is required")
	}
	return s.repo.DocumentTemplate.Update(ctx, t)
}

func (s *DocumentTemplateService) Delete(ctx context.Context, id, accountID uuid.UUID) error {
	return s.repo.DocumentTemplate.Delete(ctx, id, accountID)
}

func (s *DocumentTemplateService) Duplicate(ctx context.Context, id, accountID uuid.UUID, createdBy *uuid.UUID) (*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.Duplicate(ctx, id, accountID, createdBy)
}
