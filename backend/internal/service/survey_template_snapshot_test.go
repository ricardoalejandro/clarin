package service

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestSurveyTemplateSnapshotRetriesWholeOperation(t *testing.T) {
	calls := 0
	expected := &domain.SurveyInstanceSummary{ID: uuid.New(), TemplateRevision: 3}
	got, err := retrySurveyTemplateSnapshot(func() (*domain.SurveyInstanceSummary, error) {
		calls++
		if calls < 3 {
			return nil, repository.ErrSurveyTemplateRevisionConflict
		}
		return expected, nil
	})
	if err != nil || got != expected || calls != 3 {
		t.Fatalf("got=%v err=%v reads=%d", got, err, calls)
	}
}

func TestSurveyTemplateSnapshotExhaustionAndOtherErrors(t *testing.T) {
	calls := 0
	_, err := retrySurveyTemplateSnapshot(func() (*domain.SurveyInstanceSummary, error) {
		calls++
		return nil, repository.ErrSurveyTemplateRevisionConflict
	})
	if !errors.Is(err, repository.ErrSurveyTemplateRevisionConflict) || calls != 3 {
		t.Fatalf("err=%v calls=%d", err, calls)
	}
	calls = 0
	_, err = retrySurveyTemplateSnapshot(func() (*domain.SurveyInstanceSummary, error) {
		calls++
		return nil, repository.ErrSurveyTemplateEmpty
	})
	if !errors.Is(err, repository.ErrSurveyTemplateEmpty) || calls != 1 {
		t.Fatalf("unrelated error retried: err=%v calls=%d", err, calls)
	}
}
