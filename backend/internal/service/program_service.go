package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/naperu/clarin/internal/domain"
	"github.com/naperu/clarin/internal/repository"
)

type ProgramService struct {
	repo *repository.Repositories
}

func NewProgramService(repo *repository.Repositories) *ProgramService {
	return &ProgramService{repo: repo}
}

// --- Programs ---

func (s *ProgramService) CreateProgram(ctx context.Context, p *domain.Program) error {
	if p.Name == "" {
		return errors.New("program name is required")
	}
	if p.Status == "" {
		p.Status = "active"
	}
	if p.Type == "" {
		p.Type = "course"
	}
	if p.Type != "course" && p.Type != "event" {
		return errors.New("program type must be 'course' or 'event'")
	}
	if p.Type == "event" && p.PipelineID == nil {
		return errors.New("event-type programs require a pipeline")
	}
	return s.repo.Program.Create(ctx, p)
}

func (s *ProgramService) GetProgram(ctx context.Context, accountID, id uuid.UUID) (*domain.Program, error) {
	return s.repo.Program.GetByID(ctx, accountID, id)
}

func (s *ProgramService) ListPrograms(ctx context.Context, accountID uuid.UUID, status string) ([]*domain.Program, error) {
	return s.repo.Program.List(ctx, accountID, status)
}

func (s *ProgramService) UpdateProgram(ctx context.Context, p *domain.Program) error {
	if p.Name == "" {
		return errors.New("program name is required")
	}
	if p.Type == "event" && p.PipelineID == nil {
		return errors.New("event-type programs require a pipeline")
	}
	return s.repo.Program.Update(ctx, p)
}

func (s *ProgramService) DeleteProgram(ctx context.Context, accountID, id uuid.UUID) error {
	return s.repo.Program.Delete(ctx, accountID, id)
}

// --- Participants ---

func (s *ProgramService) AddParticipant(ctx context.Context, pp *domain.ProgramParticipant) error {
	if pp.Status == "" {
		pp.Status = "active"
	}
	return s.repo.Program.AddParticipant(ctx, pp)
}

func (s *ProgramService) AddParticipantsByContactIDs(ctx context.Context, accountID, programID uuid.UUID, contactIDs []uuid.UUID) (repository.ProgramParticipantBulkResult, error) {
	return s.repo.Program.AddParticipantsByContactIDs(ctx, accountID, programID, contactIDs)
}

func (s *ProgramService) UpdateParticipantStage(ctx context.Context, programID, participantID uuid.UUID, stageID *uuid.UUID) error {
	return s.repo.Program.UpdateParticipantStage(ctx, programID, participantID, stageID)
}

func (s *ProgramService) ListParticipants(ctx context.Context, accountID, programID uuid.UUID) ([]*domain.ProgramParticipant, error) {
	return s.repo.Program.ListParticipants(ctx, accountID, programID)
}

func (s *ProgramService) RemoveParticipant(ctx context.Context, programID, participantID uuid.UUID) error {
	return s.repo.Program.RemoveParticipant(ctx, programID, participantID)
}

// --- Sessions ---

func (s *ProgramService) CreateSession(ctx context.Context, session *domain.ProgramSession) error {
	if session.Topic != nil && *session.Topic == "" {
		return errors.New("session topic cannot be empty")
	}
	if session.SessionType == "" {
		session.SessionType = "regular"
	}
	if session.SessionType != "regular" && session.SessionType != "recovery" {
		return errors.New("session type must be 'regular' or 'recovery'")
	}
	return s.repo.Program.CreateSession(ctx, session)
}

func (s *ProgramService) ListSessions(ctx context.Context, programID uuid.UUID) ([]*domain.ProgramSession, error) {
	return s.repo.Program.ListSessions(ctx, programID)
}

func (s *ProgramService) UpdateSession(ctx context.Context, session *domain.ProgramSession) error {
	if session.Topic != nil && *session.Topic == "" {
		return errors.New("session topic cannot be empty")
	}
	if session.SessionType == "" {
		session.SessionType = "regular"
	}
	if session.SessionType != "regular" && session.SessionType != "recovery" {
		return errors.New("session type must be 'regular' or 'recovery'")
	}
	return s.repo.Program.UpdateSession(ctx, session)
}

func (s *ProgramService) DeleteSession(ctx context.Context, programID, sessionID uuid.UUID) error {
	return s.repo.Program.DeleteSession(ctx, programID, sessionID)
}

// --- Attendance ---

func (s *ProgramService) MarkAttendance(ctx context.Context, accountID, userID, programID, sessionID uuid.UUID, a *domain.ProgramAttendance) error {
	return s.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, []*domain.ProgramAttendance{a})
}

func (s *ProgramService) BatchMarkAttendance(ctx context.Context, accountID, userID, programID, sessionID uuid.UUID, attendances []*domain.ProgramAttendance) error {
	validStatuses := map[string]bool{"": true, domain.AttendanceStatusPresent: true, domain.AttendanceStatusAbsent: true, domain.AttendanceStatusLate: true, domain.AttendanceStatusExcused: true}
	seen := make(map[uuid.UUID]struct{}, len(attendances))
	for _, attendance := range attendances {
		if attendance == nil || attendance.ParticipantID == uuid.Nil {
			return errors.New("participant_id is required")
		}
		if !validStatuses[attendance.Status] {
			return fmt.Errorf("invalid attendance status: %s", attendance.Status)
		}
		if _, exists := seen[attendance.ParticipantID]; exists {
			return errors.New("duplicate participant in attendance batch")
		}
		seen[attendance.ParticipantID] = struct{}{}
		attendance.SessionID = sessionID
	}
	return s.repo.Program.BatchMarkAttendance(ctx, accountID, userID, programID, sessionID, attendances)
}

func (s *ProgramService) GetAttendanceBySession(ctx context.Context, sessionID uuid.UUID) ([]*domain.ProgramAttendance, error) {
	return s.repo.Program.GetAttendanceBySession(ctx, sessionID)
}

func (s *ProgramService) GetParticipantsByAttendanceStatus(ctx context.Context, sessionID uuid.UUID, status string) ([]*domain.ProgramParticipant, error) {
	return s.repo.Program.GetParticipantsByAttendanceStatus(ctx, sessionID, status)
}

// GenerateSessions creates recurring sessions based on a schedule configuration
func (s *ProgramService) GenerateSessions(ctx context.Context, programID uuid.UUID, startDate, endDate time.Time, daysOfWeek []int, startTime, endTime, topicPrefix string, location *string) ([]*domain.ProgramSession, error) {
	if startDate.After(endDate) {
		return nil, errors.New("start date must be before end date")
	}
	if len(daysOfWeek) == 0 {
		return nil, errors.New("at least one day of week is required")
	}

	// Build a set of valid weekdays
	daySet := make(map[time.Weekday]bool)
	for _, d := range daysOfWeek {
		if d < 0 || d > 6 {
			return nil, fmt.Errorf("invalid day of week: %d", d)
		}
		daySet[time.Weekday(d)] = true
	}

	var sessions []*domain.ProgramSession
	sessionNum := 1
	current := startDate

	for !current.After(endDate) {
		if daySet[current.Weekday()] {
			topic := fmt.Sprintf("%s %d", topicPrefix, sessionNum)
			var st, et *string
			if startTime != "" {
				st = &startTime
			}
			if endTime != "" {
				et = &endTime
			}
			sessions = append(sessions, &domain.ProgramSession{
				ProgramID: programID,
				Date:      current,
				Topic:     &topic,
				StartTime: st,
				EndTime:   et,
				Location:  location,
			})
			sessionNum++
		}
		current = current.AddDate(0, 0, 1)
	}

	if len(sessions) == 0 {
		return nil, errors.New("no sessions generated for the given date range and days")
	}

	return s.repo.Program.GenerateSessions(ctx, sessions)
}

// --- Folders ---

func (s *ProgramService) GetFolders(ctx context.Context, accountID uuid.UUID, programStatus string) ([]*domain.ProgramFolder, error) {
	return s.repo.ProgramFolder.GetByAccountID(ctx, accountID, programStatus)
}

func (s *ProgramService) GetFolderByID(ctx context.Context, id uuid.UUID) (*domain.ProgramFolder, error) {
	return s.repo.ProgramFolder.GetByID(ctx, id)
}

func (s *ProgramService) CreateFolder(ctx context.Context, f *domain.ProgramFolder) error {
	return s.repo.ProgramFolder.Create(ctx, f)
}

func (s *ProgramService) UpdateFolder(ctx context.Context, f *domain.ProgramFolder) error {
	return s.repo.ProgramFolder.Update(ctx, f)
}

func (s *ProgramService) DeleteFolder(ctx context.Context, id uuid.UUID) error {
	return s.repo.ProgramFolder.Delete(ctx, id)
}

func (s *ProgramService) MoveProgramToFolder(ctx context.Context, programID uuid.UUID, folderID *uuid.UUID) error {
	return s.repo.ProgramFolder.MoveProgram(ctx, programID, folderID)
}

// --- Attendance Stats ---

func (s *ProgramService) GetAttendanceStats(ctx context.Context, accountID, programID uuid.UUID, months []time.Time) ([]*domain.ProgramSessionAttendanceStat, []*domain.ProgramParticipantAttendanceStat, error) {
	return s.repo.Program.GetAttendanceStats(ctx, accountID, programID, months)
}

func (s *ProgramService) GetProgramGoals(ctx context.Context, accountID uuid.UUID, programID *uuid.UUID) (*domain.ProgramGoal, error) {
	return s.repo.Program.GetProgramGoals(ctx, accountID, programID)
}

func (s *ProgramService) UpsertProgramGoals(ctx context.Context, goal *domain.ProgramGoal) error {
	return s.repo.Program.UpsertProgramGoals(ctx, goal)
}

func (s *ProgramService) UpdateParticipantOutcome(ctx context.Context, accountID, programID, participantID uuid.UUID, status string, droppedAt *time.Time, dropReason, dropNotes string, completedAt *time.Time, transferredToLevel string, transferredAt *time.Time) error {
	if status != "active" && status != "completed" && status != "dropped" {
		return errors.New("participant status must be active, completed or dropped")
	}
	if status == "dropped" && droppedAt == nil {
		now := time.Now()
		droppedAt = &now
	}
	if status == "completed" && completedAt == nil {
		now := time.Now()
		completedAt = &now
	}
	if transferredToLevel != "" && transferredAt == nil {
		now := time.Now()
		transferredAt = &now
	}
	if status != "dropped" {
		droppedAt = nil
		dropReason = ""
		dropNotes = ""
	}
	return s.repo.Program.UpdateParticipantOutcome(ctx, accountID, programID, participantID, status, droppedAt, dropReason, dropNotes, completedAt, transferredToLevel, transferredAt)
}

func (s *ProgramService) CreateParticipantNote(ctx context.Context, note *domain.ProgramParticipantNote) error {
	if note.Note == "" {
		return errors.New("note is required")
	}
	return s.repo.Program.CreateParticipantNote(ctx, note)
}

func (s *ProgramService) ListParticipantNotes(ctx context.Context, accountID, programID uuid.UUID, participantID *uuid.UUID) ([]*domain.ProgramParticipantNote, error) {
	return s.repo.Program.ListParticipantNotes(ctx, accountID, programID, participantID)
}

func (s *ProgramService) GetProgramHealth(ctx context.Context, accountID, programID uuid.UUID) (*domain.ProgramHealthSummary, error) {
	return s.repo.Program.GetProgramHealth(ctx, accountID, programID)
}

func (s *ProgramService) GetProgramsDashboard(ctx context.Context, accountID uuid.UUID, from, to *time.Time) (*domain.ProgramDashboardSummary, error) {
	return s.repo.Program.GetProgramsDashboard(ctx, accountID, from, to)
}
