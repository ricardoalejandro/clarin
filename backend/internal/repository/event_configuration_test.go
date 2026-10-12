package repository

import (
	"context"
	"errors"
	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"testing"
	"time"
)

func TestEventConfigurationMatchesCanonicalPrecision(t *testing.T) {
	now := time.Now().UTC()
	canonical := now.Truncate(time.Microsecond)
	if !eventConfigurationMatches(&now, canonical) || !eventConfigurationMatches(nil, canonical) {
		t.Fatal("canonical precision/legacy update rejected")
	}
	next := now.Add(time.Millisecond)
	if eventConfigurationMatches(&next, canonical) {
		t.Fatal("stale edit accepted")
	}
}

func TestEventConfigurationConcurrentEditPreservesWinner(t *testing.T) {
	pool := programSurveyIntegrityPool(t)
	f := integrityProgram(t, pool)
	id := uuid.New()
	integrityExec(t, pool, `INSERT INTO events(id,account_id,name,status,color) VALUES($1,$2,'Before','active','#334455')`, id, f.account)
	repo := &EventRepository{db: pool}
	ctx := context.Background()
	first, err := repo.GetByID(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	second := *first
	expected := first.UpdatedAt
	first.ExpectedUpdatedAt = &expected
	second.ExpectedUpdatedAt = &expected
	first.Name = "Winner"
	ok, err := repo.UpdateWithExpectedStatus(ctx, first, domain.EventStatusActive)
	if !ok || err != nil {
		t.Fatal(err)
	}
	second.Name = "Stale"
	_, err = repo.UpdateWithExpectedStatus(ctx, &second, domain.EventStatusActive)
	if !errors.Is(err, ErrEventConfigurationConflict) {
		t.Fatal("stale edit accepted", err)
	}
	got, err := repo.GetByID(ctx, id)
	if err != nil || got.Name != "Winner" {
		t.Fatal("canonical winner lost", err)
	}
}
