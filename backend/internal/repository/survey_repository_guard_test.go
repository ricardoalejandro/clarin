package repository

import (
	"context"
	"errors"
	"testing"
	"time"

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

func TestSurveyDeletionBlockReasonPreservesEveryKindOfHistory(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name                                  string
		isTemplate, legacy, missingTemplate   bool
		hasResponses, hasActivity, hasUploads bool
		want                                  string
	}{
		{name: "empty canonical", want: ""},
		{name: "legacy template-shaped row", isTemplate: true, want: SurveyDeletionBlockLegacy},
		{name: "legacy", legacy: true, want: SurveyDeletionBlockLegacy},
		{name: "missing canonical template", missingTemplate: true, want: SurveyDeletionBlockLegacy},
		{name: "response wins", hasResponses: true, hasActivity: true, hasUploads: true, want: SurveyDeletionBlockHasResponses},
		{name: "observed activity", hasActivity: true, hasUploads: true, want: SurveyDeletionBlockHasActivity},
		{name: "live upload", hasUploads: true, want: SurveyDeletionBlockHasUploads},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := surveyDeletionBlockReason(test.isTemplate, test.legacy, test.missingTemplate, test.hasResponses, test.hasActivity, test.hasUploads)
			if got != test.want {
				t.Fatalf("block reason=%q, want %q", got, test.want)
			}
		})
	}
}

func TestSurveyLifecycleCapabilitiesKeepMigratedLegacyApplicationsReversible(t *testing.T) {
	t.Parallel()
	templateID := uuid.New()
	survey := &domain.Survey{IsTemplate: true, LegacyInstance: true, TemplateID: &templateID}
	applySurveyLifecycleCapabilities(survey, SurveyDeletionBlockLegacy)
	if survey.CanDelete || !survey.CanArchive || survey.CanRestore {
		t.Fatalf("unexpected active legacy capabilities: delete=%t archive=%t restore=%t", survey.CanDelete, survey.CanArchive, survey.CanRestore)
	}
	archivedAt := time.Now()
	survey.ArchivedAt = &archivedAt
	applySurveyLifecycleCapabilities(survey, SurveyDeletionBlockLegacy)
	if survey.CanDelete || survey.CanArchive || !survey.CanRestore {
		t.Fatalf("unexpected archived legacy capabilities: delete=%t archive=%t restore=%t", survey.CanDelete, survey.CanArchive, survey.CanRestore)
	}
}
