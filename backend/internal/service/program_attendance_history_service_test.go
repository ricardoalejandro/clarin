package service

import (
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

func TestBuildProgramAttendanceHistorySummaryUsesOnlyMarkedSessions(t *testing.T) {
	summary := buildProgramAttendanceHistorySummary(repository.ProgramAttendanceHistoryCounts{
		GoalPercent:      80,
		EligibleSessions: 7,
		MarkedSessions:   5,
		Present:          3,
		Absent:           1,
		Late:             1,
	})
	if summary.Pending != 2 {
		t.Fatalf("pending = %d, want 2", summary.Pending)
	}
	if summary.AttendanceRate == nil || *summary.AttendanceRate != 80 {
		t.Fatalf("attendance rate = %#v, want 80", summary.AttendanceRate)
	}
	if summary.PunctualityRate == nil || *summary.PunctualityRate != 60 {
		t.Fatalf("punctuality rate = %#v, want 60", summary.PunctualityRate)
	}
	if summary.Health != "green" {
		t.Fatalf("health = %q, want green", summary.Health)
	}
}

func TestBuildProgramAttendanceHistorySummaryHealthThresholds(t *testing.T) {
	tests := []struct {
		name   string
		counts repository.ProgramAttendanceHistoryCounts
		want   string
	}{
		{
			name:   "no marked data",
			counts: repository.ProgramAttendanceHistoryCounts{GoalPercent: 80, EligibleSessions: 4},
			want:   "no_data",
		},
		{
			name:   "ten points below is amber",
			counts: repository.ProgramAttendanceHistoryCounts{GoalPercent: 80, MarkedSessions: 10, Present: 7},
			want:   "amber",
		},
		{
			name:   "more than ten points below is red",
			counts: repository.ProgramAttendanceHistoryCounts{GoalPercent: 80, MarkedSessions: 3, Present: 2},
			want:   "red",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := buildProgramAttendanceHistorySummary(test.counts).Health; got != test.want {
				t.Fatalf("health = %q, want %q", got, test.want)
			}
		})
	}
}

func TestProgramAttendanceHistoryCursorIsBoundToContext(t *testing.T) {
	programID, participantID := uuid.New(), uuid.New()
	row := &domain.ProgramParticipantAttendanceHistorySession{
		SessionID:       uuid.New(),
		CursorDate:      time.Date(2026, 7, 21, 0, 0, 0, 0, time.UTC),
		CursorStartTime: "09:30",
		CursorCreatedAt: time.Date(2026, 7, 1, 13, 0, 0, 0, time.UTC),
	}
	raw, err := encodeProgramAttendanceHistoryCursor(programID, participantID, row)
	if err != nil {
		t.Fatalf("encode cursor: %v", err)
	}
	decoded, err := decodeProgramAttendanceHistoryCursor(raw, programID, participantID)
	if err != nil {
		t.Fatalf("decode cursor: %v", err)
	}
	if decoded.SessionID != row.SessionID || decoded.StartTime != row.CursorStartTime || !decoded.Date.Equal(row.CursorDate) {
		t.Fatalf("decoded cursor = %#v", decoded)
	}
	if _, err := decodeProgramAttendanceHistoryCursor(raw, uuid.New(), participantID); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("cross-program cursor error = %v, want ErrProgramInput", err)
	}
	if _, err := decodeProgramAttendanceHistoryCursor("not-base64", programID, participantID); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("malformed cursor error = %v, want ErrProgramInput", err)
	}
	if _, err := decodeProgramAttendanceHistoryCursor(strings.Repeat("a", 2049), programID, participantID); !errors.Is(err, ErrProgramInput) {
		t.Fatalf("oversized cursor error = %v, want ErrProgramInput", err)
	}
}

func TestBuildProgramAttendanceHistoryResponseSplitsHistoricalRowsAndPaginates(t *testing.T) {
	programID, participantID := uuid.New(), uuid.New()
	makeRow := func(historical bool, day int) *domain.ProgramParticipantAttendanceHistorySession {
		return &domain.ProgramParticipantAttendanceHistorySession{
			SessionID:       uuid.New(),
			Historical:      historical,
			CursorDate:      time.Date(2026, 7, day, 0, 0, 0, 0, time.UTC),
			CursorStartTime: "08:00",
			CursorCreatedAt: time.Date(2026, 6, day, 0, 0, 0, 0, time.UTC),
		}
	}
	rows := []*domain.ProgramParticipantAttendanceHistorySession{
		makeRow(false, 3), makeRow(true, 2), makeRow(false, 1),
	}
	history, err := buildProgramAttendanceHistoryResponse(programID, participantID, repository.ProgramAttendanceHistoryCounts{}, rows, 2)
	if err != nil {
		t.Fatalf("build response: %v", err)
	}
	if len(history.Sessions) != 1 || len(history.HistoricalSessions) != 1 {
		t.Fatalf("split rows = %d eligible, %d historical", len(history.Sessions), len(history.HistoricalSessions))
	}
	if history.NextCursor == "" {
		t.Fatal("expected next cursor")
	}
	decoded, err := decodeProgramAttendanceHistoryCursor(history.NextCursor, programID, participantID)
	if err != nil {
		t.Fatalf("decode next cursor: %v", err)
	}
	if decoded.SessionID != rows[1].SessionID {
		t.Fatalf("cursor session = %s, want %s", decoded.SessionID, rows[1].SessionID)
	}
}
