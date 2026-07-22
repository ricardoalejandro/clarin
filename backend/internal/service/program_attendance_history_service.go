package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

const (
	defaultProgramAttendanceHistoryLimit = 25
	maxProgramAttendanceHistoryLimit     = 50
)

type programAttendanceHistoryCursorPayload struct {
	ProgramID     uuid.UUID `json:"program_id"`
	ParticipantID uuid.UUID `json:"participant_id"`
	Date          string    `json:"date"`
	StartTime     string    `json:"start_time"`
	CreatedAt     time.Time `json:"created_at"`
	SessionID     uuid.UUID `json:"session_id"`
}

func decodeProgramAttendanceHistoryCursor(raw string, programID, participantID uuid.UUID) (*repository.ProgramAttendanceHistoryCursor, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 2048 {
		return nil, programInputError("invalid attendance history cursor")
	}
	payloadJSON, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil {
		return nil, programInputError("invalid attendance history cursor")
	}
	var payload programAttendanceHistoryCursorPayload
	if err := json.Unmarshal(payloadJSON, &payload); err != nil {
		return nil, programInputError("invalid attendance history cursor")
	}
	if payload.ProgramID != programID || payload.ParticipantID != participantID ||
		payload.SessionID == uuid.Nil || payload.CreatedAt.IsZero() || strings.TrimSpace(payload.StartTime) == "" {
		return nil, programInputError("invalid attendance history cursor")
	}
	date, err := time.Parse("2006-01-02", payload.Date)
	if err != nil {
		return nil, programInputError("invalid attendance history cursor")
	}
	return &repository.ProgramAttendanceHistoryCursor{
		Date:      date,
		StartTime: payload.StartTime,
		CreatedAt: payload.CreatedAt,
		SessionID: payload.SessionID,
	}, nil
}

func encodeProgramAttendanceHistoryCursor(programID, participantID uuid.UUID, row *domain.ProgramParticipantAttendanceHistorySession) (string, error) {
	if row == nil || row.SessionID == uuid.Nil || row.CursorDate.IsZero() || row.CursorCreatedAt.IsZero() || row.CursorStartTime == "" {
		return "", errors.New("incomplete attendance history cursor row")
	}
	payload, err := json.Marshal(programAttendanceHistoryCursorPayload{
		ProgramID:     programID,
		ParticipantID: participantID,
		Date:          row.CursorDate.Format("2006-01-02"),
		StartTime:     row.CursorStartTime,
		CreatedAt:     row.CursorCreatedAt,
		SessionID:     row.SessionID,
	})
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(payload), nil
}

func roundProgramAttendancePercent(numerator, denominator int) *float64 {
	if denominator <= 0 {
		return nil
	}
	value := math.Round((float64(numerator)/float64(denominator)*100)*10) / 10
	return &value
}

func buildProgramAttendanceHistorySummary(counts repository.ProgramAttendanceHistoryCounts) domain.ProgramParticipantAttendanceHistorySummary {
	goal := counts.GoalPercent
	if goal < 1 || goal > 100 {
		goal = 80
	}
	pending := counts.EligibleSessions - counts.MarkedSessions
	if pending < 0 {
		pending = 0
	}
	summary := domain.ProgramParticipantAttendanceHistorySummary{
		GoalPercent:      goal,
		EligibleSessions: counts.EligibleSessions,
		MarkedSessions:   counts.MarkedSessions,
		Pending:          pending,
		Present:          counts.Present,
		Absent:           counts.Absent,
		Late:             counts.Late,
		AttendanceRate:   roundProgramAttendancePercent(counts.Present+counts.Late, counts.MarkedSessions),
		PunctualityRate:  roundProgramAttendancePercent(counts.Present, counts.MarkedSessions),
		Health:           "no_data",
	}
	if summary.AttendanceRate == nil {
		return summary
	}
	// Classify from the exact ratio; rounding is presentation-only and must not
	// move a participant across the goal boundary.
	rate := float64(counts.Present+counts.Late) / float64(counts.MarkedSessions) * 100
	switch {
	case rate >= float64(goal):
		summary.Health = "green"
	case rate >= math.Max(0, float64(goal-10)):
		summary.Health = "amber"
	default:
		summary.Health = "red"
	}
	return summary
}

func buildProgramAttendanceHistoryResponse(
	programID, participantID uuid.UUID,
	counts repository.ProgramAttendanceHistoryCounts,
	rows []*domain.ProgramParticipantAttendanceHistorySession,
	limit int,
) (*domain.ProgramParticipantAttendanceHistory, error) {
	history := &domain.ProgramParticipantAttendanceHistory{
		Summary:            buildProgramAttendanceHistorySummary(counts),
		Sessions:           make([]*domain.ProgramParticipantAttendanceHistorySession, 0, limit),
		HistoricalSessions: make([]*domain.ProgramParticipantAttendanceHistorySession, 0),
	}
	if len(rows) > limit {
		rows = rows[:limit]
		nextCursor, err := encodeProgramAttendanceHistoryCursor(programID, participantID, rows[len(rows)-1])
		if err != nil {
			return nil, err
		}
		history.NextCursor = nextCursor
	}
	for _, row := range rows {
		if row.Historical {
			history.HistoricalSessions = append(history.HistoricalSessions, row)
			continue
		}
		history.Sessions = append(history.Sessions, row)
	}
	return history, nil
}

// GetParticipantAttendanceHistory returns held sessions only. Eligible
// sessions are those inside the inclusive enrollment window; real attendance
// or observations outside it are retained separately and never affect rates.
func (s *ProgramService) GetParticipantAttendanceHistory(
	ctx context.Context,
	accountID, programID, participantID uuid.UUID,
	rawCursor string,
	limit int,
) (*domain.ProgramParticipantAttendanceHistory, error) {
	if limit == 0 {
		limit = defaultProgramAttendanceHistoryLimit
	}
	if limit < 1 || limit > maxProgramAttendanceHistoryLimit {
		return nil, programInputError("attendance history limit must be between 1 and 50")
	}
	cursor, err := decodeProgramAttendanceHistoryCursor(rawCursor, programID, participantID)
	if err != nil {
		return nil, err
	}
	counts, rows, err := s.repo.Program.GetParticipantAttendanceHistory(
		ctx, accountID, programID, participantID, cursor, limit+1,
	)
	if err != nil {
		return nil, err
	}

	return buildProgramAttendanceHistoryResponse(programID, participantID, counts, rows, limit)
}
