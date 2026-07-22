package repository

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestSurveyRepositoryRejectsRawCreationAndDuplicationBeforeDatabaseAccess(t *testing.T) {
	repo := &SurveyRepository{}
	if err := repo.Create(context.Background(), &domain.Survey{}); !errors.Is(err, ErrRawSurveyMutationDisabled) {
		t.Fatalf("raw create error=%v", err)
	}
	if _, err := repo.Duplicate(context.Background(), uuid.New(), uuid.New(), "copia", "copia"); !errors.Is(err, ErrRawSurveyMutationDisabled) {
		t.Fatalf("raw duplicate error=%v", err)
	}
}
