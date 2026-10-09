package service

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
)

func TestProgramRejectsInvalidLifecycleBeforePersistence(t *testing.T) {
	s := NewProgramService(nil)
	for _, status := range []string{"invalid", "ACTIVE", " active ", "deleted"} {
		for _, save := range []func(context.Context, *domain.Program) error{s.CreateProgram, s.UpdateProgram} {
			if err := save(context.Background(), &domain.Program{Name: "Synthetic group", Type: "course", Status: status}); !errors.Is(err, ErrProgramInput) {
				t.Fatalf("invalid status %q should fail validation: %v", status, err)
			}
		}
	}
	if err := s.UpdateProgram(context.Background(), &domain.Program{Name: "Synthetic group", Type: "course"}); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("empty update status must not erase lifecycle: %v", err)
	}
	for _, status := range []string{"active", "completed", "archived"} {
		if err := validateProgramStatus(status); err != nil {
			t.Fatalf("valid status %q: %v", status, err)
		}
	}
}

func TestLegacyAttendanceNotesValidation(t *testing.T) {
	note := "  Synthetic observation  "
	a := &domain.ProgramAttendance{ParticipantID: uuid.New(), Status: "present", Notes: &note}
	if err := validateAttendanceBatch(uuid.New(), []*domain.ProgramAttendance{a}); err != nil || *a.Notes != "Synthetic observation" {
		t.Fatalf("trimmed note should remain available for canonical persistence: %v", err)
	}
	tooLong := strings.Repeat("á", 4001)
	a.Notes = &tooLong
	if err := validateAttendanceBatch(uuid.New(), []*domain.ProgramAttendance{a}); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("oversized note should be rejected before any batch write: %v", err)
	}
}
