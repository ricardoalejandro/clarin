package service

import (
	"context"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type DocumentTemplateService struct{ repo *repository.Repositories }

func NewDocumentTemplateService(repo *repository.Repositories) *DocumentTemplateService {
	return &DocumentTemplateService{repo: repo}
}
func (s *DocumentTemplateService) Create(ctx context.Context, t *domain.DocumentTemplate) error {
	if t.PageWidth == 0 {
		t.PageWidth = 210
	}
	if t.PageHeight == 0 {
		t.PageHeight = 297
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
	if err := domain.ValidateDocumentTemplate(t); err != nil {
		return err
	}
	return s.repo.DocumentTemplate.Create(ctx, t)
}
func (s *DocumentTemplateService) GetByID(ctx context.Context, id, account uuid.UUID) (*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.GetByID(ctx, id, account)
}
func (s *DocumentTemplateService) List(ctx context.Context, account uuid.UUID) ([]*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.List(ctx, account)
}
func (s *DocumentTemplateService) Update(ctx context.Context, t *domain.DocumentTemplate, expected int64) error {
	if err := domain.ValidateDocumentTemplate(t); err != nil {
		return err
	}
	return s.repo.DocumentTemplate.Update(ctx, t, expected)
}
func (s *DocumentTemplateService) Delete(ctx context.Context, id, account uuid.UUID, expected int64) error {
	return s.repo.DocumentTemplate.Delete(ctx, id, account, expected)
}
func (s *DocumentTemplateService) Duplicate(ctx context.Context, id, account uuid.UUID, createdBy *uuid.UUID) (*domain.DocumentTemplate, error) {
	return s.repo.DocumentTemplate.Duplicate(ctx, id, account, createdBy)
}
