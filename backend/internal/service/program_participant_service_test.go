package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestParticipantOutcomeDoesNotSilentlyReactivateHistory(t *testing.T) {
	service := &ProgramService{}
	err := service.UpdateParticipantOutcome(
		context.Background(),
		uuid.New(),
		uuid.New(),
		uuid.New(),
		"active",
		nil,
		"",
		"",
		nil,
		"",
		nil,
	)
	if err == nil || !strings.Contains(err.Error(), "explicit flow") {
		t.Fatalf("active outcome should require explicit re-enrollment, got %v", err)
	}
}

func TestParticipantOutcomeRejectsFutureLifecycleDates(t *testing.T) {
	future := time.Now().Add(24 * time.Hour)
	now := time.Now()
	tests := []struct {
		name               string
		status             string
		droppedAt          *time.Time
		completedAt        *time.Time
		transferredToLevel string
		transferredAt      *time.Time
	}{
		{name: "future drop", status: "dropped", droppedAt: &future},
		{name: "future completion", status: "completed", completedAt: &future},
		{name: "future transfer", status: "completed", completedAt: &now, transferredToLevel: "Nivel 2", transferredAt: &future},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			service := &ProgramService{}
			err := service.UpdateParticipantOutcome(
				context.Background(), uuid.New(), uuid.New(), uuid.New(), test.status,
				test.droppedAt, "", "", test.completedAt, test.transferredToLevel, test.transferredAt,
			)
			if !errors.Is(err, ErrProgramParticipantEndInFuture) {
				t.Fatalf("expected future lifecycle date rejection, got %v", err)
			}
		})
	}
}
