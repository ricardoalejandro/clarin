package api

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/repository"
)

func TestTaskMyWorkCursorRoundTripAndSectionIsolation(t *testing.T) {
	taskID := uuid.New()
	focusRaw, err := encodeTaskMyWorkFocusCursor(&repository.TaskMyWorkFocusCursor{Position: 2048, TaskID: taskID})
	if err != nil {
		t.Fatal(err)
	}
	focus, suggestion, err := decodeTaskMyWorkCursor(focusRaw, "focus")
	if err != nil || suggestion != nil || focus == nil || focus.Position != 2048 || focus.TaskID != taskID {
		t.Fatalf("focus cursor mismatch: focus=%+v suggestion=%+v err=%v", focus, suggestion, err)
	}
	if _, _, err := decodeTaskMyWorkCursor(focusRaw, "suggestions"); err == nil {
		t.Fatal("focus cursor was accepted for suggestions")
	}

	dueAt := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	suggestionRaw, err := encodeTaskMyWorkSuggestionCursor(&repository.TaskMyWorkSuggestionCursor{
		ReasonRank: 1, PriorityRank: 2, DueNullRank: 0, DueAt: dueAt, TaskID: taskID,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, suggestion, err = decodeTaskMyWorkCursor(suggestionRaw, "suggestions")
	if err != nil || suggestion == nil || suggestion.TaskID != taskID || !suggestion.DueAt.Equal(dueAt) {
		t.Fatalf("suggestion cursor mismatch: %+v err=%v", suggestion, err)
	}
}

func TestParseTaskMyWorkMutationRequiresRevisionDateAndOperation(t *testing.T) {
	revision := int64(0)
	operationID := uuid.New()
	parsed, err := parseTaskMyWorkMutationInput(taskMyWorkMutationRequest{
		BusinessDate: "2026-09-01", ExpectedRevision: &revision, OperationID: operationID.String(),
	}, nil)
	if err != nil || parsed != operationID {
		t.Fatalf("valid mutation rejected: parsed=%s err=%v", parsed, err)
	}
	if _, err := parseTaskMyWorkMutationInput(taskMyWorkMutationRequest{BusinessDate: "2026-09-01", OperationID: operationID.String()}, nil); err == nil {
		t.Fatal("missing revision was accepted")
	}
}
