package repository

import (
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestEnsureTaskCreateIDPreservesOfflineIdempotencyAnchor(t *testing.T) {
	provided := uuid.New()
	task := &domain.Task{ID: provided}
	ensureTaskCreateID(task)
	if task.ID != provided {
		t.Fatalf("provided task id was replaced: got %s want %s", task.ID, provided)
	}
	ordinary := &domain.Task{}
	ensureTaskCreateID(ordinary)
	if ordinary.ID == uuid.Nil {
		t.Fatal("ordinary task did not receive a generated id")
	}
}
